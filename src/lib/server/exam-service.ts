import { after } from "next/server";
import { db } from "@/db";
import { examSessions, examQuestions, questions, answerRecords, audioAssets, transcripts, assessments, users } from "@/db/schema";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { resolveConfig, EXAMINER_NAMES, type SpeakingExamConfig, type SpeakingMode } from "@/lib/speaking/config";
import { canSubmitAnswer, canRepeat, decideAdvance, canFinish, type MachineState, type MachineError } from "@/lib/speaking/exam-machine";
import { LINES, templateFollowUp, generateFollowUp } from "@/lib/speaking/examiner";
import { tokenize } from "@/lib/speaking/metrics";
import { getASR, getLLM, TIMEOUTS } from "@/lib/ai/registry";
import { withTimeout } from "@/lib/ai/types";
import { saveAudio, extForMime, readAudio } from "./storage";
import { ensureSeed } from "./seed";
import { HttpError } from "./user";
import { runScoring } from "./report-service";

type User = typeof users.$inferSelect;
type QuestionRow = typeof questions.$inferSelect;

const MACHINE_HTTP: Record<MachineError, number> = {
  session_not_active: 409,
  not_current_step: 409,
  already_answered: 409,
  rerecord_not_allowed: 409,
  repeat_limit: 429,
  step_not_answered: 409,
  unknown_step: 404,
};
function machineFail(e: MachineError): never {
  throw new HttpError(MACHINE_HTTP[e], e.replace(/_/g, " "), e);
}

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

/** Prefer topics the user has not practised yet (pattern observed in the reverse-engineered product). */
async function pickTopics(userId: string, part: number, count: number, pool: QuestionRow[]): Promise<string[]> {
  const keys = [...new Set(pool.filter((q) => q.part === part).map((q) => q.topicKey))];
  const used = await db
    .selectDistinct({ topic: examQuestions.topic })
    .from(examQuestions)
    .innerJoin(examSessions, eq(examSessions.id, examQuestions.sessionId))
    .where(and(eq(examSessions.userId, userId), eq(examQuestions.part, part)));
  const usedTopics = new Set(used.map((u) => u.topic));
  const topicOf = (k: string) => pool.find((q) => q.topicKey === k)!.topic;
  const fresh = shuffle(keys.filter((k) => !usedTopics.has(topicOf(k))));
  const old = shuffle(keys.filter((k) => usedTopics.has(topicOf(k))));
  return [...fresh, ...old].slice(0, count);
}

export async function createSession(user: User, mode: SpeakingMode) {
  await ensureSeed();
  const config = resolveConfig(mode);
  const pool = await db.select().from(questions).where(eq(questions.module, "speaking"));
  const examinerName = EXAMINER_NAMES[Math.floor(Math.random() * EXAMINER_NAMES.length)];
  type StepDraft = Omit<typeof examQuestions.$inferInsert, "sessionId" | "stepIndex">;
  const steps: StepDraft[] = [];
  const opening = mode === "full" ? LINES.opening(examinerName) + " " : "";

  if (config.part1.enabled) {
    const topics = await pickTopics(user.id, 1, config.part1.topics, pool);
    topics.forEach((key, ti) => {
      const qs = pool.filter((q) => q.part === 1 && q.topicKey === key).sort((a, b) => a.orderIndex - b.orderIndex).slice(0, config.part1.questionsPerTopic);
      qs.forEach((q, qi) => {
        let lead = "";
        if (ti === 0 && qi === 0) lead = `${opening}${LINES.part1Intro} ${LINES.part1Topic(q.topic)}`;
        else if (qi === 0) lead = LINES.part1NextTopic(q.topic);
        steps.push({ part: 1, kind: "question", questionId: q.id, topic: q.topic, examinerLead: lead.trim(), promptText: q.text, generator: "bank", answerSeconds: config.part1.answerSeconds });
      });
    });
  }
  let p23Key: string | undefined;
  if (config.part2.enabled || config.part3.enabled) {
    const candidates = await pickTopics(user.id, config.part2.enabled ? 2 : 3, 1, pool);
    p23Key = candidates[0];
  }
  if (config.part2.enabled && p23Key) {
    const card = pool.find((q) => q.part === 2 && q.topicKey === p23Key)!;
    steps.push({
      part: 2, kind: "cue_card", questionId: card.id, topic: card.topic,
      examinerLead: `${steps.length === 0 ? opening : ""}${LINES.part2Intro}`.trim(),
      promptText: card.text, cuePoints: card.cuePoints ?? [], generator: "bank",
      prepSeconds: config.part2.prepSeconds, answerSeconds: config.part2.answerSeconds,
    });
  }
  if (config.part3.enabled && p23Key) {
    const qs = shuffle(pool.filter((q) => q.part === 3 && q.topicKey === p23Key)).slice(0, config.part3.questions);
    qs.forEach((q, i) => {
      const lead = i === 0 ? (mode === "full" ? LINES.part3Intro(q.topic) : LINES.part3Practice(q.topic)) : "";
      steps.push({ part: 3, kind: "question", questionId: q.id, topic: q.topic, examinerLead: lead, promptText: q.text, generator: "bank", answerSeconds: config.part3.answerSeconds });
    });
  }
  if (!steps.length) throw new HttpError(500, "Question bank could not build an exam");

  return db.transaction(async (tx) => {
    const [s] = await tx
      .insert(examSessions)
      .values({ userId: user.id, module: "speaking", mode, examinerName, configSnapshot: config as unknown as Record<string, unknown>, totalSteps: steps.length })
      .returning();
    await tx.insert(examQuestions).values(steps.map((st, i) => ({ ...st, sessionId: s.id, stepIndex: i })));
    return s;
  });
}

async function loadOwned(user: User, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "Exam not found");
  const [s] = await db.select().from(examSessions).where(and(eq(examSessions.id, id), eq(examSessions.userId, user.id))).limit(1);
  if (!s) throw new HttpError(404, "Exam not found");
  return s;
}

async function machineState(s: typeof examSessions.$inferSelect): Promise<{ state: MachineState; steps: (typeof examQuestions.$inferSelect)[] }> {
  const steps = await db.select().from(examQuestions).where(eq(examQuestions.sessionId, s.id)).orderBy(asc(examQuestions.stepIndex));
  return {
    steps,
    state: {
      status: s.status as MachineState["status"],
      currentStep: s.currentStep,
      config: s.configSnapshot as unknown as SpeakingExamConfig,
      steps: steps.map((x) => ({ id: x.id, stepIndex: x.stepIndex, part: x.part, kind: x.kind as "question", status: x.status as "pending", parentId: x.parentId, repeatCount: x.repeatCount })),
    },
  };
}

export async function getSessionView(user: User, id: string) {
  const s = await loadOwned(user, id);
  const { steps } = await machineState(s);
  const answers = await db.select().from(answerRecords).where(and(eq(answerRecords.sessionId, s.id), eq(answerRecords.isCurrent, true)));
  const ts = answers.length ? await db.select().from(transcripts).where(inArray(transcripts.answerId, answers.map((a) => a.id))).orderBy(desc(transcripts.createdAt)) : [];
  const [assessment] = await db.select({ id: assessments.id, status: assessments.status }).from(assessments).where(eq(assessments.sessionId, s.id)).orderBy(desc(assessments.startedAt)).limit(1);
  return {
    session: { id: s.id, mode: s.mode, status: s.status, currentStep: s.currentStep, examinerName: s.examinerName, startedAt: s.startedAt, completedAt: s.completedAt, config: s.configSnapshot as unknown as SpeakingExamConfig },
    steps: steps.map((st) => {
      const a = answers.find((x) => x.examQuestionId === st.id);
      const t = a ? ts.find((x) => x.answerId === a.id) : undefined;
      return {
        id: st.id, stepIndex: st.stepIndex, part: st.part, kind: st.kind, topic: st.topic, examinerLead: st.examinerLead, promptText: st.promptText,
        cuePoints: st.cuePoints ?? [], generator: st.generator, prepSeconds: st.prepSeconds, answerSeconds: st.answerSeconds, status: st.status, repeatCount: st.repeatCount,
        answer: a ? { id: a.id, attempt: a.attempt, status: a.status, durationMs: a.durationMs, audioAssetId: a.audioAssetId, transcript: t ? { status: t.status, text: t.text, provider: t.provider } : null } : null,
      };
    }),
    assessment: assessment ?? null,
  };
}

async function transcribeAnswer(answerId: string, audioKey: string, mime: string, prompt: string) {
  const asr = getASR();
  if (!asr || asr.location !== "server") return null;
  const started = Date.now();
  try {
    const buf = await readAudio(audioKey);
    const r = await withTimeout(asr.id, TIMEOUTS.asrMs, (signal) => asr.transcribe(buf, mime, { signal, prompt }));
    const [row] = await db.insert(transcripts).values({ answerId, provider: asr.id, model: asr.model, status: "completed", text: r.text, words: r.words ?? null, confidence: r.confidence ?? null, latencyMs: Date.now() - started }).returning();
    return row;
  } catch (e) {
    await db.insert(transcripts).values({ answerId, provider: asr.id, model: asr.model, status: "failed", error: (e as Error).message.slice(0, 500), latencyMs: Date.now() - started });
    return null;
  }
}

export async function submitAnswer(user: User, id: string, form: FormData) {
  const s = await loadOwned(user, id);
  const config = s.configSnapshot as unknown as SpeakingExamConfig;
  const examQuestionId = String(form.get("examQuestionId") || "");
  const idem = String(form.get("idempotencyKey") || "");
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(idem)) throw new HttpError(400, "idempotencyKey required");

  // duplicate submission → return the original record (safe retries)
  const [dup] = await db.select().from(answerRecords).where(eq(answerRecords.idempotencyKey, idem)).limit(1);
  if (dup) {
    if (dup.sessionId !== s.id) throw new HttpError(409, "idempotency key reused");
    return { answerId: dup.id, status: dup.status, duplicate: true };
  }

  const { state, steps } = await machineState(s);
  const check = canSubmitAnswer(state, examQuestionId);
  if (!check.ok) machineFail(check.error);
  const step = steps.find((x) => x.id === examQuestionId)!;

  const durationMs = Math.max(0, Math.min(Number(form.get("durationMs") || 0), (step.answerSeconds + 5) * 1000));
  const audio = form.get("audio");
  const wav = form.get("wav");
  const files = [audio, wav].filter((f): f is File => f instanceof File && f.size > 0);
  for (const f of files) if (f.size > config.maxUploadBytes) throw new HttpError(413, `Audio file too large (max ${Math.round(config.maxUploadBytes / 1048576)} MB)`);

  const store = async (f: File | null, kind: "recording" | "pcm_wav") => {
    if (!(f instanceof File) || f.size === 0) return null;
    const mime = (f.type || (kind === "pcm_wav" ? "audio/wav" : "application/octet-stream")).split(";")[0];
    if (!mime.startsWith("audio/") && !mime.startsWith("video/")) throw new HttpError(415, `Unsupported audio type ${mime}`);
    const buf = Buffer.from(await f.arrayBuffer());
    const { key, sha256 } = await saveAudio(buf, extForMime(mime));
    const [row] = await db.insert(audioAssets).values({ userId: user.id, kind, storageKey: key, mimeType: f.type || mime, bytes: buf.length, durationMs, sha256 }).returning();
    return row;
  };
  const rec = await store(audio instanceof File ? audio : null, "recording");
  const wavRow = await store(wav instanceof File ? wav : null, "pcm_wav");
  const main = rec ?? wavRow;
  const noResponse = !main || durationMs < config.noResponseMs;

  const answer = await db.transaction(async (tx) => {
    const prev = await tx.select({ attempt: answerRecords.attempt }).from(answerRecords).where(eq(answerRecords.examQuestionId, step.id)).orderBy(desc(answerRecords.attempt)).limit(1);
    await tx.update(answerRecords).set({ isCurrent: false }).where(eq(answerRecords.examQuestionId, step.id));
    const [a] = await tx
      .insert(answerRecords)
      .values({ sessionId: s.id, examQuestionId: step.id, attempt: (prev[0]?.attempt ?? 0) + 1, idempotencyKey: idem, audioAssetId: main?.id ?? null, wavAssetId: wavRow?.id ?? null, durationMs, status: noResponse ? "no_response" : "answered" })
      .returning();
    await tx.update(examQuestions).set({ status: "answered", answeredAt: new Date() }).where(eq(examQuestions.id, step.id));
    await tx.update(examSessions).set({ updatedAt: new Date() }).where(eq(examSessions.id, s.id));
    return a;
  });

  // Transcript: browser-provided (Web Speech) or server ASR.
  const asr = getASR();
  const browserText = String(form.get("browserTranscript") || "").trim().slice(0, 10000);
  if (!noResponse && asr?.location === "browser") {
    await db.insert(transcripts).values({
      answerId: answer.id, provider: asr.id, model: asr.model,
      status: browserText ? "completed" : "failed", text: browserText,
      error: browserText ? null : "Browser speech recognition returned no text (unsupported browser, permission or network issue).",
    });
  } else if (!noResponse && asr?.location === "server" && main) {
    const prompt = step.promptText;
    if (step.part === 3 && step.kind === "question") await transcribeAnswer(answer.id, main.storageKey, main.mimeType, prompt);
    else after(() => transcribeAnswer(answer.id, main.storageKey, main.mimeType, prompt).then(() => undefined));
  }
  return { answerId: answer.id, status: answer.status, duplicate: false };
}

async function currentAnswerSummary(stepId: string) {
  const [a] = await db.select().from(answerRecords).where(and(eq(answerRecords.examQuestionId, stepId), eq(answerRecords.isCurrent, true))).limit(1);
  if (!a) return null;
  const [t] = await db.select().from(transcripts).where(and(eq(transcripts.answerId, a.id), eq(transcripts.status, "completed"))).orderBy(desc(transcripts.createdAt)).limit(1);
  return { noResponse: a.status === "no_response", text: t?.text ?? null, wordCount: t ? tokenize(t.text).length : Math.round(a.durationMs / 400) };
}

export async function advance(user: User, id: string, fromStep: number) {
  const s = await loadOwned(user, id);
  const { state, steps } = await machineState(s);
  if (s.status === "in_progress" && fromStep === s.currentStep - 1) return { currentStep: s.currentStep, duplicate: true };
  const step = steps.find((x) => x.stepIndex === s.currentStep);
  const summary = step ? await currentAnswerSummary(step.id) : null;
  const llm = getLLM();
  const d = decideAdvance(state, fromStep, summary, { llmAvailable: !!llm });
  if (!d.ok) machineFail(d.error);
  const decision = d.value;

  if (decision.type === "finish") return { currentStep: s.currentStep, finished: true };
  if (decision.type === "next") {
    const [u] = await db.update(examSessions).set({ currentStep: decision.nextStep, updatedAt: new Date() }).where(and(eq(examSessions.id, s.id), eq(examSessions.currentStep, fromStep))).returning();
    return { currentStep: u?.currentStep ?? s.currentStep, partChanged: decision.partChanged };
  }

  // follow_up: wording from LLM when available, otherwise template. Machine already decided it is allowed.
  let text: string | null = null;
  let generator = "template";
  if (llm && summary?.text) {
    try {
      text = await generateFollowUp(llm, { question: step!.promptText, answer: summary.text, topic: step!.topic }, TIMEOUTS.llmFollowUpMs);
      if (text) generator = "llm";
    } catch {
      text = null;
    }
  }
  if (!text) {
    if (decision.reason === "probe") {
      // LLM unavailable/failed for a probe → skip the follow-up rather than ask a generic question
      const next = steps.find((x) => x.stepIndex === s.currentStep + 1);
      if (!next) return { currentStep: s.currentStep, finished: true };
      await db.update(examSessions).set({ currentStep: next.stepIndex, updatedAt: new Date() }).where(and(eq(examSessions.id, s.id), eq(examSessions.currentStep, fromStep)));
      return { currentStep: next.stepIndex };
    }
    text = templateFollowUp(s.currentStep);
  }
  const insertAt = s.currentStep + 1;
  await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(examSessions).where(eq(examSessions.id, s.id)).for("update");
    if (locked.currentStep !== fromStep) throw new HttpError(409, "not current step", "not_current_step");
    await tx.update(examQuestions).set({ stepIndex: sql`-(${examQuestions.stepIndex} + 1)` }).where(and(eq(examQuestions.sessionId, s.id), gt(examQuestions.stepIndex, s.currentStep)));
    await tx.update(examQuestions).set({ stepIndex: sql`-${examQuestions.stepIndex}` }).where(and(eq(examQuestions.sessionId, s.id), sql`${examQuestions.stepIndex} < 0`));
    await tx.insert(examQuestions).values({ sessionId: s.id, stepIndex: insertAt, part: 3, kind: "follow_up", parentId: step!.id, topic: step!.topic, examinerLead: "", promptText: text!, generator, answerSeconds: (s.configSnapshot as unknown as SpeakingExamConfig).part3.answerSeconds });
    await tx.update(examSessions).set({ currentStep: insertAt, totalSteps: sql`${examSessions.totalSteps} + 1`, updatedAt: new Date() }).where(eq(examSessions.id, s.id));
  });
  return { currentStep: insertAt, followUp: { text, generator } };
}

export async function repeatQuestion(user: User, id: string, examQuestionId: string) {
  const s = await loadOwned(user, id);
  const { state } = await machineState(s);
  const r = canRepeat(state, examQuestionId);
  if (!r.ok) machineFail(r.error);
  await db.update(examQuestions).set({ repeatCount: sql`${examQuestions.repeatCount} + 1` }).where(eq(examQuestions.id, examQuestionId));
  return { remaining: r.value.remaining };
}

export async function finishSession(user: User, id: string) {
  const s = await loadOwned(user, id);
  if (s.status === "completed") {
    const [a] = await db.select({ id: assessments.id }).from(assessments).where(eq(assessments.sessionId, s.id)).orderBy(desc(assessments.startedAt)).limit(1);
    return { status: "completed", assessmentId: a?.id ?? null, duplicate: true };
  }
  const { state } = await machineState(s);
  const r = canFinish(state);
  if (!r.ok) machineFail(r.error);
  const [u] = await db.update(examSessions).set({ status: "completed", completedAt: new Date(), updatedAt: new Date() }).where(and(eq(examSessions.id, s.id), eq(examSessions.status, "in_progress"))).returning();
  if (!u) return { status: "completed", assessmentId: null, duplicate: true };
  const [a] = await db.insert(assessments).values({ sessionId: s.id, status: "pending", stage: "queued" }).returning();
  after(() => runScoring(a.id));
  return { status: "completed", assessmentId: a.id, duplicate: false };
}

export async function abandonSession(user: User, id: string) {
  const s = await loadOwned(user, id);
  if (s.status !== "in_progress") return { status: s.status };
  await db.update(examSessions).set({ status: "abandoned", updatedAt: new Date(), completedAt: new Date() }).where(eq(examSessions.id, s.id));
  return { status: "abandoned" };
}

export async function retryScoring(user: User, id: string) {
  const s = await loadOwned(user, id);
  if (s.status !== "completed") throw new HttpError(409, "Exam is not completed");
  const [running] = await db.select().from(assessments).where(and(eq(assessments.sessionId, s.id), inArray(assessments.status, ["pending", "running"]))).limit(1);
  if (running && Date.now() - running.startedAt.getTime() < 5 * 60_000) return { assessmentId: running.id, duplicate: true };
  const [a] = await db.insert(assessments).values({ sessionId: s.id, status: "pending", stage: "queued" }).returning();
  after(() => runScoring(a.id));
  return { assessmentId: a.id, duplicate: false };
}

export { loadOwned };
