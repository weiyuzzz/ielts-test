import { db } from "@/db";
import {
  assessments, assessmentDimensions, assessmentFindings, examReports, examQuestions, answerRecords, transcripts, audioAssets, pronunciationResults, audioAnalyses,
} from "@/db/schema";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getASR, getLLM, getLLMFallback, getPronunciation, TIMEOUTS } from "@/lib/ai/registry";
import { withTimeout } from "@/lib/ai/types";
import { aggregate, type AnswerInput } from "@/lib/speaking/metrics";
import {
  buildScoringMessages, extractJson, validateLanguageScore, SCORING_PROMPT_VERSION, DIAGNOSTIC_VERSION,
  buildDiagnosticReport, type LanguageScore, type Finding, type PronunciationEvidence, type DimensionScore,
} from "@/lib/speaking/scoring";
import {
  aggregateSessionAudio, buildAudioAnalysis, AUDIO_ANALYSIS_VERSION, type AudioAnalysis,
} from "@/lib/speaking/audio-analysis";
import { overallBand, DIMENSION_LABELS } from "@/lib/speaking/bands";
import { DESCRIPTOR_SOURCE } from "@/lib/speaking/band-descriptors";
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
      // Server ASR prefers the 16 kHz mono WAV asset (correct container for
      // every provider, timeline matches the pronunciation slicer).
      const asrAsset = assets.find((x) => x.id === ans.wavAssetId) ?? main;
      // (re)transcribe on the server when needed and possible
      if (!t && ans.status !== "no_response" && asr?.location === "server" && asrAsset) {
        const started = Date.now();
        try {
          const r = await withTimeout(asr.id, TIMEOUTS.asrMs, async (signal) => asr.transcribe(await readAudio(asrAsset.storageKey), asrAsset.mimeType, { signal, prompt: st.promptText }));
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

    // ---------------- Audio analysis (acoustic evidence for the scorer)
    await setStage(a.id, "audio-analysis");
    const audioPerAnswer: { index: number; part: number; answerId: string; analysis: AudioAnalysis }[] = [];
    for (const inp of inputs) {
      if (inp.noResponse && !inp.text) continue;
      let wav: Uint8Array | null = null;
      if (inp.wavKey) {
        try {
          wav = await readAudio(inp.wavKey);
        } catch {
          wav = null;
        }
      }
      const analysis = buildAudioAnalysis({ text: inp.text, durationMs: inp.durationMs, words: inp.words, wav });
      try {
        await db.insert(audioAnalyses).values({
          answerId: inp.answerId,
          version: AUDIO_ANALYSIS_VERSION,
          status: "completed",
          analysis: analysis as unknown as Record<string, unknown>,
        });
      } catch {
        notes.push(`Audio analysis persistence failed for answer #${inp.index}.`);
      }
      audioPerAnswer.push({ index: inp.index, part: inp.part, answerId: inp.answerId, analysis });
    }
    const sessionAudio = aggregateSessionAudio(audioPerAnswer.map(({ part, analysis }) => ({ part, analysis })));
    if (audioPerAnswer.length) {
      const withTimings = audioPerAnswer.filter((x) => x.analysis.coverage.wordTimingAvailable).length;
      const withVad = audioPerAnswer.filter((x) => x.analysis.coverage.vadAvailable).length;
      notes.push(`Audio analysis: ${audioPerAnswer.length} answers analysed (word timings ${withTimings}/${audioPerAnswer.length}, VAD ${withVad}/${audioPerAnswer.length}).`);
    }

    const llm = getLLM() ?? getLLMFallback();

    // No AI scoring provider configured: complete the mock exam WITHOUT a score.
    // Recordings and transcripts are still kept; we never fabricate a band.
    // The deterministic statistics below are LEARNING DIAGNOSTICS, not bands.
    if (!llm) {
      const diagnostics = buildDiagnosticReport(inputs, metrics);
      await db.update(assessments).set({
        status: "unscored", stage: "done", scorer: null, overallBand: null, isComplete: false,
        promptVersion: null, llmProvider: null, llmModel: null,
        metrics: metrics as unknown as Record<string, unknown>,
        audioAnalysis: (sessionAudio ?? null) as unknown as Record<string, unknown> | null,
        notes: [...notes, `AI scoring is not configured (no LLM_PROVIDER / DEEPSEEK_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / DASHSCOPE_API_KEY / GEMINI_API_KEY). The mock flow completed without any scores being generated. ${diagnostics.note} (${DIAGNOSTIC_VERSION})`],
        asrProvider: asrProviders.join(",") || null, completedAt: new Date(),
      }).where(eq(assessments.id, a.id));
      return;
    }

    if (metrics.totalWords < 10) {
      await db.update(assessments).set({
        status: "failed", stage: "done", error: "Not enough recognised speech to assess (fewer than 10 words). Check your microphone and transcription settings, then retake the test.",
        metrics: metrics as unknown as Record<string, unknown>,
        audioAnalysis: (sessionAudio ?? null) as unknown as Record<string, unknown> | null,
        notes, completedAt: new Date(), asrProvider: asrProviders.join(",") || null,
      }).where(eq(assessments.id, a.id));
      return;
    }

    // ---------------- Pronunciation (audio-based only; raw numbers → evidence)
    await setStage(a.id, "pronunciation");
    const pron = getPronunciation();
    const pronRows: { answerIndex: number; answerId: string; overall: number; accuracy: number; fluency: number; prosody?: number; completeness?: number; durationMs: number; words: { word: string; accuracy: number; errorType?: string }[] }[] = [];
    if (pron) {
      for (const inp of inputs) {
        if (inp.noResponse || !inp.text || !inp.wavKey) continue;
        try {
          const r = await withTimeout(pron.id, TIMEOUTS.pronMs, async (signal) => pron.assess(await readAudio(inp.wavKey!), inp.text, { signal, words: inp.words ?? undefined }));
          await db.insert(pronunciationResults).values({ answerId: inp.answerId, provider: pron.id, status: "completed", accuracy: r.accuracy, fluency: r.fluency, prosody: r.prosody ?? null, completeness: r.completeness ?? null, overall: r.overall, words: r.words });
          pronRows.push({ answerIndex: inp.index, answerId: inp.answerId, overall: r.overall, accuracy: r.accuracy, fluency: r.fluency, prosody: r.prosody, completeness: r.completeness, durationMs: inp.durationMs, words: r.words });
        } catch (e) {
          await db.insert(pronunciationResults).values({ answerId: inp.answerId, provider: pron.id, status: "failed", error: (e as Error).message.slice(0, 500) });
          notes.push(`Pronunciation assessment failed for answer #${inp.index}.`);
        }
      }
    }
    // Provider numbers are EVIDENCE for the scorer, never bands: the LLM maps
    // them onto the [P] rubric; without evidence P stays not_assessed.
    const pronEvidence: PronunciationEvidence | null = pronRows.length
      ? {
          providerId: pron!.id,
          perAnswer: pronRows.map((r) => ({
            answer: r.answerIndex,
            accuracy: r.accuracy,
            fluency: r.fluency,
            prosody: r.prosody ?? null,
            completeness: r.completeness ?? null,
            overall: r.overall,
            worstWords: [...r.words].filter((w) => w.word.length > 2).sort((x, y) => x.accuracy - y.accuracy).slice(0, 5),
          })),
        }
      : null;

    // ---------------- Language (FC / LR / GRA) + P from audio evidence
    await setStage(a.id, "scoring");
    const scorable = inputs.filter((i) => i.text || i.noResponse);
    let lang: LanguageScore | null = null;
    let usedLLM = llm!;
    let degradedToFallback = false;
    const scorer = "llm" as const;
    {
      const audioByAnswerId = new Map(audioPerAnswer.map((x) => [x.answerId, x.analysis]));
      const { system, user } = buildScoringMessages(
        scorable.map((s) => ({ ...s, audio: audioByAnswerId.get(s.answerId) ?? null })),
        sessionAudio,
        pronEvidence,
      );
      // Primary first, then the configured fallback (same rubric, same
      // validator); every switch is recorded — never silent.
      const attempts: { llm: NonNullable<typeof llm>; kind: "primary" | "fallback" }[] = [{ llm: llm!, kind: "primary" }];
      const fb = getLLMFallback();
      if (fb && fb.id !== llm!.id) attempts.push({ llm: fb, kind: "fallback" });
      for (const attempt of attempts) {
        for (let tryNo = 1; tryNo <= 2 && !lang; tryNo++) {
          try {
            const raw = await withTimeout(attempt.llm.id, TIMEOUTS.llmMs, (signal) =>
              attempt.llm.complete([{ role: "system", content: system }, { role: "user", content: user }], { json: true, signal }));
            const v = validateLanguageScore(extractJson(raw), scorable, { allowPronunciation: pronEvidence !== null });
            lang = v.score;
            usedLLM = attempt.llm;
            degradedToFallback = attempt.kind === "fallback";
            if (v.dropped) notes.push(`${v.dropped} model findings were discarded because they did not quote the candidate's actual words.`);
            if (v.rejectedRefs) notes.push(`${v.rejectedRefs} rubric citation(s) were discarded because they did not match the rubric or the assigned band.`);
            if (v.droppedEvidence) notes.push(`${v.droppedEvidence} evidence item(s) were discarded: unknown answer indices, quotes that never appeared, or audio timestamps without word timings.`);
          } catch (e) {
            notes.push(`AI scoring attempt ${tryNo} on ${attempt.llm.id} (${attempt.kind}) failed: ${(e as Error).message.slice(0, 160)}`);
          }
        }
        if (lang) break;
      }
      if (degradedToFallback && lang) {
        notes.push(`Primary provider failed; the fallback provider ${usedLLM.id}${usedLLM.model ? ` (${usedLLM.model})` : ""} scored this exam against the SAME rubric version ${DESCRIPTOR_SOURCE.revision}.`);
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

    // ---------------- Pronunciation dimension (LLM-judged from provider evidence)
    const pDim: DimensionScore | null = lang.pronunciation ?? null;
    let pBand: number | null = pDim?.band ?? null;
    let pRationale: string;
    const pFindings: Finding[] = [];
    if (pronRows.length) {
      if (pDim) {
        pRationale = `Audio evidence from ${pron!.id} on ${pronRows.length} answers (accuracy/fluency/prosody/completeness + weakest words), judged against the [P] rubric — provider numbers were used as evidence, never mapped arithmetically to a band. ${pDim.rationale}`;
      } else {
        pRationale = `Pronunciation provider returned evidence for ${pronRows.length} answers, but no valid P judgement came back; P is not assessed this run.`;
        pBand = null;
        notes.push("Pronunciation evidence existed but the model returned no valid P judgement — P marked not_assessed.");
      }
      const weak = pronRows.flatMap((r) => r.words.filter((x) => x.accuracy < 60 && x.word.length > 2).map((x) => ({ ...x, answerId: r.answerId })));
      const seen = new Set<string>();
      for (const x of weak.sort((p, q) => p.accuracy - q.accuracy)) {
        if (seen.has(x.word.toLowerCase()) || seen.size >= 8) continue;
        seen.add(x.word.toLowerCase());
        pFindings.push({ dimension: "P", answerId: x.answerId, kind: "error", category: x.errorType && x.errorType !== "None" ? x.errorType.toLowerCase() : "phoneme accuracy", originalText: x.word, suggestion: null, explanation: `Word accuracy ${x.accuracy.toFixed(0)}/100 — practise this word's sounds and stress.`, evidenceType: "metric" });
      }
    } else {
      pRationale = pron
        ? "Pronunciation could not be assessed: the audio assessment service failed or no 16 kHz WAV was available."
        : "Not assessed. No audio-based pronunciation service is configured (set PRONUNCIATION_PROVIDER=azure). Pronunciation is deliberately NOT estimated from transcripts.";
      notes.push("Overall band excludes Pronunciation and is therefore provisional.");
    }

    const dims = [
      { dimension: "FC", dim: lang.dimensions.FC, source: scorer },
      { dimension: "LR", dim: lang.dimensions.LR, source: scorer },
      { dimension: "GRA", dim: lang.dimensions.GRA, source: scorer },
      { dimension: "P", dim: pDim, source: pDim ? "audio-llm" : "none" },
    ];
    const isComplete = dims.every((d) => d.dim && d.dim.band !== null);
    // Four criteria each count 25%: with any criterion missing there is no valid
    // overall band, so we store null rather than averaging three of four.
    const overall = isComplete ? overallBand(dims.map((d) => d.dim!.band)) : null;
    const findings = [...lang.findings, ...pFindings];
    const limitations = [...lang.limitations];
    if (sessionAudio && !sessionAudio.coverage.wordTimingAvailable) {
      limitations.push("Word timings were unavailable for some answers — audio evidence is limited to VAD aggregates, so located pauses carry no text context.");
    }
    if (!sessionAudio?.coverage.prosodyAvailable) {
      limitations.push("Prosody (pitch/energy variation) was not measured — no decodable 16 kHz WAV was available for at least one answer.");
    }

    await db.transaction(async (tx) => {
      await tx.insert(assessmentDimensions).values(dims.map((d) => ({
        assessmentId: a.id,
        dimension: d.dimension,
        band: d.dim?.band ?? null,
        status: d.dim && d.dim.band !== null ? "scored" : "not_assessed",
        source: d.source,
        rationale: d.dim?.rationale ?? (d.dimension === "P" ? pRationale : `${d.dimension} could not be assessed in this run.`),
        descriptorRefs: d.dim?.descriptorRefs ?? [],
        confidence: d.dim?.confidence ?? null,
        strengths: d.dim?.strengths ?? [],
        weaknesses: d.dim?.weaknesses ?? [],
      })));
      if (findings.length)
        await tx.insert(assessmentFindings).values(
          findings.map((f) => ({
            assessmentId: a.id, dimension: f.dimension, answerId: f.answerId, kind: f.kind,
            category: f.category, originalText: f.originalText, suggestion: f.suggestion ?? null,
            explanation: f.explanation, possibleAsrError: !!f.possibleAsrError,
            // Only ids validated against the rubric reach this point
            // (validateLanguageScore drops unknown / cross-dimension / far-band ids).
            descriptorRefs: f.descriptorRefs ?? [],
            evidenceType: f.evidenceType ?? "transcript",
            startMs: f.startMs ?? null,
            endMs: f.endMs ?? null,
          })),
        );
      const scored = dims.filter((d) => d.dim && d.dim.band !== null);
      const weakest = [...scored].sort((x, y) => (x.dim!.band as number) - (y.dim!.band as number))[0];
      const summary = lang.summary || (overall !== null ? `Estimated band ${overall}. Weakest area: ${DIMENSION_LABELS[weakest.dimension as "FC"]}.` : `Language criteria assessed. Weakest area: ${DIMENSION_LABELS[weakest.dimension as "FC"]}. Pronunciation was not assessed, so no overall band is shown.`);
      await tx.delete(examReports).where(eq(examReports.sessionId, a.sessionId));
      await tx.insert(examReports).values({ sessionId: a.sessionId, assessmentId: a.id, summary, nextSteps: lang!.nextSteps.length ? lang!.nextSteps : ["Keep practising full mock tests and compare reports over time."] });
      await tx.update(assessments).set({
        status: isComplete && scorer === "llm" ? "completed" : "partial",
        stage: "done", overallBand: overall, isComplete, scorer,
        llmProvider: usedLLM.id, llmModel: usedLLM.model ?? null,
        promptVersion: SCORING_PROMPT_VERSION,
        rubricVersion: DESCRIPTOR_SOURCE.revision,
        limitations: limitations.length ? limitations : null,
        asrProvider: asrProviders.join(",") || null, pronunciationProvider: pronRows.length ? pron!.id : null,
        metrics: metrics as unknown as Record<string, unknown>,
        audioAnalysis: (sessionAudio ?? null) as unknown as Record<string, unknown> | null,
        notes, completedAt: new Date(),
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
  const rows = await db.select().from(assessmentFindings).where(eq(assessmentFindings.assessmentId, a.id));
  // Rows written before the column existed (or by a pre-migration deployment)
  // come back as null; normalise to [] so the report never renders "undefined".
  const findings = rows.map((f) => ({ ...f, descriptorRefs: Array.isArray(f.descriptorRefs) ? f.descriptorRefs : [] }));
  const [report] = await db.select().from(examReports).where(eq(examReports.assessmentId, a.id)).limit(1);
  return { assessment: a, dimensions: dims, findings, report: report ?? null };
}
