import { db } from "@/db";
import {
  assessments, assessmentDimensions, assessmentFindings, examReports, examQuestions, answerRecords, transcripts, audioAssets, pronunciationResults,
} from "@/db/schema";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getASR, getLLM, getPronunciation, TIMEOUTS } from "@/lib/ai/registry";
import { withTimeout } from "@/lib/ai/types";
import { aggregate, type AnswerInput } from "@/lib/speaking/metrics";
import { buildScoringMessages, extractJson, validateLanguageScore, SCORING_PROMPT_VERSION, type LanguageScore, type Finding } from "@/lib/speaking/scoring";
import { overallBand, score100ToBand, DIMENSION_LABELS } from "@/lib/speaking/bands";
import { readAudio } from "./storage";

async function setStage(id: string, stage: string, status = "running") {
  await db.update(assessments).set({ stage, status }).where(eq(assessments.id, id));
}

export async function runScoring(assessmentId: string): Promise<void> {
  const [a] = await db.select().from(assessments).where(eq(assessments.id, assessmentId)).limit(1);
  if (!a) return;
  const notes: string[] = [];
  try {
    await setStage(a.id, "transcribing");
    const steps = await db.select().from(examQuestions).where(eq(examQuestions.sessionId, a.sessionId)).orderBy(asc(examQuestions.stepIndex));
    const answers = await db.select().from(answerRecords).where(and(eq(answerRecords.sessionId, a.sessionId), eq(answerRecords.isCurrent, true)));
    const asr = getASR();
    const ids = answers.map((x) => x.id);
    const allT = ids.length ? await db.select().from(transcripts).where(inArray(transcripts.answerId, ids)).orderBy(desc(transcripts.createdAt)) : [];
    const assets = ids.length
      ? await db.select().from(audioAssets).where(inArray(audioAssets.id, answers.flatMap((x) => [x.audioAssetId, x.wavAssetId]).filter((v): v is string => !!v)))
      : [];

    const inputs: (AnswerInput & { index: number; wavKey?: string })[] = [];
    let idx = 0;
    for (const st of steps) {
      const ans = answers.find((x) => x.examQuestionId === st.id);
      if (!ans) continue;
      idx++;
      let t = allT.find((x) => x.answerId === ans.id && x.status === "completed");
      const main = assets.find((x) => x.id === ans.audioAssetId);
      // (re)transcribe on the server when needed and possible
      if (!t && ans.status !== "no_response" && asr?.location === "server" && main) {
        const started = Date.now();
        try {
          const r = await withTimeout(asr.id, TIMEOUTS.asrMs, async (signal) => asr.transcribe(await readAudio(main.storageKey), main.mimeType, { signal, prompt: st.promptText }));
          [t] = await db.insert(transcripts).values({ answerId: ans.id, provider: asr.id, model: asr.model, status: "completed", text: r.text, words: r.words ?? null, latencyMs: Date.now() - started }).returning();
        } catch (e) {
          await db.insert(transcripts).values({ answerId: ans.id, provider: asr.id, model: asr.model, status: "failed", error: (e as Error).message.slice(0, 500), latencyMs: Date.now() - started });
          notes.push(`Transcription failed for answer #${idx}: ${(e as Error).message.slice(0, 120)}`);
        }
      }
      if (!t && ans.status !== "no_response") notes.push(`Answer #${idx} has no transcript and was excluded from language scoring.`);
      inputs.push({
        index: idx, answerId: ans.id, part: st.part, prompt: st.promptText, text: t?.text ?? "", durationMs: ans.durationMs,
        words: t?.words ?? null, noResponse: ans.status === "no_response",
        wavKey: assets.find((x) => x.id === ans.wavAssetId)?.storageKey,
      });
    }
    const asrProviders = [...new Set(allT.filter((t) => t.status === "completed").map((t) => t.provider))];
    if (asrProviders.includes("browser-web-speech")) notes.push("Transcripts come from the browser's built-in speech recognition (Web Speech API); accuracy varies by browser and may introduce recognition errors.");

    const metrics = aggregate(inputs);
    const llm = getLLM();

    // No AI scoring provider configured: complete the mock exam WITHOUT a score.
    // Recordings and transcripts are still kept; we never fabricate a band.
    if (!llm) {
      await db.update(assessments).set({
        status: "unscored", stage: "done", scorer: null, overallBand: null, isComplete: false,
        promptVersion: null, llmProvider: null, llmModel: null,
        metrics: metrics as unknown as Record<string, unknown>,
        notes: [...notes, "未接入 AI 评分（未配置 LLM_PROVIDER / OPENAI_API_KEY / ANTHROPIC_API_KEY）。本次只完成模考流程，不生成任何分数。"],
        asrProvider: asrProviders.join(",") || null, completedAt: new Date(),
      }).where(eq(assessments.id, a.id));
      return;
    }

    if (metrics.totalWords < 10) {
      await db.update(assessments).set({
        status: "failed", stage: "done", error: "Not enough recognised speech to assess (fewer than 10 words). Check your microphone and transcription settings, then retake the test.",
        metrics: metrics as unknown as Record<string, unknown>, notes, completedAt: new Date(), asrProvider: asrProviders.join(",") || null,
      }).where(eq(assessments.id, a.id));
      return;
    }

    // ---------------- Pronunciation (audio-based only)
    await setStage(a.id, "pronunciation");
    const pron = getPronunciation();
    const pronRows: { answerId: string; overall: number; accuracy: number; fluency: number; prosody?: number; durationMs: number; words: { word: string; accuracy: number; errorType?: string }[] }[] = [];
    if (pron) {
      for (const inp of inputs) {
        if (inp.noResponse || !inp.text || !inp.wavKey) continue;
        try {
          const r = await withTimeout(pron.id, TIMEOUTS.pronMs, async (signal) => pron.assess(await readAudio(inp.wavKey!), inp.text, { signal }));
          await db.insert(pronunciationResults).values({ answerId: inp.answerId, provider: pron.id, status: "completed", accuracy: r.accuracy, fluency: r.fluency, prosody: r.prosody ?? null, completeness: r.completeness ?? null, overall: r.overall, words: r.words });
          pronRows.push({ answerId: inp.answerId, overall: r.overall, accuracy: r.accuracy, fluency: r.fluency, prosody: r.prosody, durationMs: inp.durationMs, words: r.words });
        } catch (e) {
          await db.insert(pronunciationResults).values({ answerId: inp.answerId, provider: pron.id, status: "failed", error: (e as Error).message.slice(0, 500) });
          notes.push(`Pronunciation assessment failed for answer #${inp.index}.`);
        }
      }
    }

    // ---------------- Language (FC / LR / GRA)
    await setStage(a.id, "scoring");
    const scorable = inputs.filter((i) => i.text || i.noResponse);
    let lang: LanguageScore | null = null;
    const scorer = "llm" as const;
    {
      const { system, user } = buildScoringMessages(scorable);
      for (let attempt = 1; attempt <= 2 && !lang; attempt++) {
        try {
          const raw = await withTimeout(llm.id, TIMEOUTS.llmMs, (signal) => llm.complete([{ role: "system", content: system }, { role: "user", content: user }], { json: true, signal }));
          const v = validateLanguageScore(extractJson(raw), scorable);
          lang = v.score;
          if (v.dropped) notes.push(`${v.dropped} model findings were discarded because they did not quote the candidate's actual words.`);
          if (v.rejectedRefs) notes.push(`${v.rejectedRefs} rubric citation(s) were discarded because they did not match the rubric or the assigned band.`);
        } catch (e) {
          notes.push(`AI scoring attempt ${attempt} failed: ${(e as Error).message.slice(0, 160)}`);
        }
      }
    }
    // AI scoring is the only source of bands. If it fails, the exam stays unscored —
    // no heuristic band is substituted.
    if (!lang) {
      await db.update(assessments).set({
        status: "failed", stage: "done", error: "AI scoring did not return a valid result. No band was produced; please retry after checking the AI provider.",
        metrics: metrics as unknown as Record<string, unknown>, notes, completedAt: new Date(),
      }).where(eq(assessments.id, a.id));
      return;
    }

    // ---------------- Pronunciation dimension
    let pBand: number | null = null;
    let pRationale: string;
    const pFindings: Finding[] = [];
    if (pronRows.length) {
      const w = pronRows.reduce((s, r) => s + Math.max(1, r.durationMs), 0);
      const avg = (k: "overall" | "accuracy" | "fluency") => pronRows.reduce((s, r) => s + r[k] * Math.max(1, r.durationMs), 0) / w;
      pBand = score100ToBand(avg("overall"));
      pRationale = `Audio-based assessment by ${pron!.id} on ${pronRows.length} answers: pronunciation score ${avg("overall").toFixed(0)}/100 (accuracy ${avg("accuracy").toFixed(0)}, fluency ${avg("fluency").toFixed(0)}). Band derived with a documented 0–100→band approximation.`;
      const weak = pronRows.flatMap((r) => r.words.filter((x) => x.accuracy < 60 && x.word.length > 2).map((x) => ({ ...x, answerId: r.answerId })));
      const seen = new Set<string>();
      for (const x of weak.sort((p, q) => p.accuracy - q.accuracy)) {
        if (seen.has(x.word.toLowerCase()) || seen.size >= 8) continue;
        seen.add(x.word.toLowerCase());
        pFindings.push({ dimension: "P", answerId: x.answerId, kind: "error", category: x.errorType && x.errorType !== "None" ? x.errorType.toLowerCase() : "phoneme accuracy", originalText: x.word, suggestion: null, explanation: `Word accuracy ${x.accuracy.toFixed(0)}/100 — practise this word's sounds and stress.` });
      }
    } else {
      pRationale = pron
        ? "Pronunciation could not be assessed: the audio assessment service failed or no 16 kHz WAV was available."
        : "Not assessed. No audio-based pronunciation service is configured (set PRONUNCIATION_PROVIDER=azure). Pronunciation is deliberately NOT estimated from transcripts.";
      notes.push("Overall band excludes Pronunciation and is therefore provisional.");
    }

    const dims = [
      { dimension: "FC", band: lang.dimensions.FC.band, rationale: lang.dimensions.FC.rationale, source: scorer },
      { dimension: "LR", band: lang.dimensions.LR.band, rationale: lang.dimensions.LR.rationale, source: scorer },
      { dimension: "GRA", band: lang.dimensions.GRA.band, rationale: lang.dimensions.GRA.rationale, source: scorer },
      { dimension: "P", band: pBand, rationale: pRationale, source: pBand !== null ? "audio-model" : "none" },
    ];
    const isComplete = dims.every((d) => d.band !== null);
    // Four criteria each count 25%: with any criterion missing there is no valid
    // overall band, so we store null rather than averaging three of four.
    const overall = isComplete ? overallBand(dims.map((d) => d.band)) : null;
    const findings = [...lang.findings, ...pFindings];

    await db.transaction(async (tx) => {
      await tx.insert(assessmentDimensions).values(dims.map((d) => ({ assessmentId: a.id, dimension: d.dimension, band: d.band, status: d.band === null ? "not_assessed" : "scored", source: d.source, rationale: d.rationale })));
      if (findings.length)
        // TODO(phase3-shared-interface): add `descriptorRefs: f.descriptorRefs ?? []`
        // to this insert once `assessmentFindings.descriptorRefs` exists in
        // src/db/schema.ts. The ids are already validated by
        // validateLanguageScore()/checkDescriptorRefs(), so nothing invalid can
        // be stored; only the column is missing. See issue #4.
        await tx.insert(assessmentFindings).values(findings.map((f) => ({ assessmentId: a.id, dimension: f.dimension, answerId: f.answerId, kind: f.kind, category: f.category, originalText: f.originalText, suggestion: f.suggestion ?? null, explanation: f.explanation, possibleAsrError: !!f.possibleAsrError })));
      const weakest = dims.filter((d) => d.band !== null).sort((x, y) => (x.band as number) - (y.band as number))[0];
      const summary = lang.summary || (overall !== null ? `Estimated band ${overall}. Weakest area: ${DIMENSION_LABELS[weakest.dimension as "FC"]}.` : `Language criteria assessed. Weakest area: ${DIMENSION_LABELS[weakest.dimension as "FC"]}. Pronunciation was not assessed, so no overall band is shown.`);
      await tx.delete(examReports).where(eq(examReports.sessionId, a.sessionId));
      await tx.insert(examReports).values({ sessionId: a.sessionId, assessmentId: a.id, summary, nextSteps: lang!.nextSteps.length ? lang!.nextSteps : ["Keep practising full mock tests and compare reports over time."] });
      await tx.update(assessments).set({
        status: isComplete && scorer === "llm" ? "completed" : "partial",
        stage: "done", overallBand: overall, isComplete, scorer,
        llmProvider: scorer === "llm" ? llm!.id : null, llmModel: scorer === "llm" ? llm!.model ?? null : null,
        promptVersion: SCORING_PROMPT_VERSION,
        asrProvider: asrProviders.join(",") || null, pronunciationProvider: pronRows.length ? pron!.id : null,
        metrics: metrics as unknown as Record<string, unknown>, notes, completedAt: new Date(),
      }).where(eq(assessments.id, a.id));
    });
  } catch (e) {
    console.error("scoring failed", e);
    await db.update(assessments).set({ status: "failed", stage: "done", error: (e as Error).message.slice(0, 500), notes, completedAt: new Date() }).where(eq(assessments.id, a.id));
  }
}

export async function getReport(sessionId: string) {
  const [a] = await db.select().from(assessments).where(eq(assessments.sessionId, sessionId)).orderBy(desc(assessments.startedAt)).limit(1);
  if (!a) return null;
  const dims = await db.select().from(assessmentDimensions).where(eq(assessmentDimensions.assessmentId, a.id));
  const findings = await db.select().from(assessmentFindings).where(eq(assessmentFindings.assessmentId, a.id));
  const [report] = await db.select().from(examReports).where(eq(examReports.assessmentId, a.id)).limit(1);
  return { assessment: a, dimensions: dims, findings, report: report ?? null };
}
