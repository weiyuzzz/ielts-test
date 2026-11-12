/**
 * Language scoring (FC / LR / GRA + P when audio-provider evidence exists).
 *
 * ONE scorer: an LLM judging against the structured rubric with validated
 * evidence (transcript quotes, audio-clip bounds, provider numbers). Bands are
 * NEVER computed from metrics: word counts, WPM, pause counts and the like are
 * evidence for the model (and "learning diagnostics" for the user), never a
 * scoring formula. Pronunciation is judged only from audio-provider evidence —
 * transcripts can never produce a P band.
 */
import { toHalfBand, clampBand } from "./bands";
import type { AggregateMetrics, AnswerInput } from "./metrics";
import { splitSentences } from "./metrics";
import type { AudioAnalysis, SessionAudioAnalysis } from "./audio-analysis";
import { formatAudioEvidenceBlock } from "./audio-analysis";
import {
  descriptorBrief, findDescriptor, allowedBandsFor, PART_RULES,
  DESCRIPTOR_SOURCE, type CriterionKey,
} from "./band-descriptors";

export const SCORING_PROMPT_VERSION = "speaking-language-v5.0-multimodal-evidence";
export const DIAGNOSTIC_VERSION = "diagnostic-v2.0";

export type LangDim = "FC" | "LR" | "GRA";

export interface Finding {
  dimension: LangDim | "P";
  answerId: string | null;
  kind: "error" | "strength" | "issue";
  category: string;
  originalText: string;
  suggestion?: string | null;
  explanation: string;
  possibleAsrError?: boolean;
  /** Rubric ids this finding is evidence for (subset of the finding's dimension). */
  descriptorRefs?: string[];
  /** Where this evidence lives. Defaults to "transcript". */
  evidenceType?: "transcript" | "audio" | "metric";
  /** Inclusive audio-clip bounds in ms (answer-relative) when locatable. */
  startMs?: number | null;
  endMs?: number | null;
}

export interface EvidenceItem {
  /** Index of the answer in the scoring input list (1-based). */
  answer: number;
  evidenceType: "transcript" | "audio" | "metric";
  /** Verbatim transcript quote — required and validated for "transcript". */
  quote?: string | null;
  /** Audio-clip bounds in ms (answer-relative) — accepted only with real word timings. */
  startMs?: number | null;
  endMs?: number | null;
  explanation: string;
}

export interface DimensionScore {
  band: number;
  rationale: string;
  /** Rubric ids justifying this band. Empty only for legacy/heuristic output. */
  descriptorRefs: string[];
  /** Model's evidence-sufficiency judgement (0–1), NOT an IELTS band. */
  confidence?: number | null;
  strengths?: string[];
  weaknesses?: string[];
  evidence?: EvidenceItem[];
}

export interface LanguageScore {
  dimensions: Record<LangDim, DimensionScore>;
  /** P when (and only when) audio-provider evidence supported the judgement. */
  pronunciation?: DimensionScore | null;
  findings: Finding[];
  summary: string;
  nextSteps: string[];
  /** Model-stated evidence gaps and caveats, stored on the assessment. */
  limitations: string[];
}

/** Raw audio-provider pronunciation numbers per answer — evidence, never bands. */
export interface PronunciationEvidence {
  providerId: string;
  model?: string | null;
  perAnswer: {
    answer: number;
    accuracy: number;
    fluency: number;
    prosody?: number | null;
    completeness?: number | null;
    overall: number;
    /** Weakest words by provider accuracy (raw 0–100 provider scores). */
    worstWords: { word: string; accuracy: number; errorType?: string }[];
  }[];
}

/** Deterministic study-diagnostics. Contains NO IELTS band of any kind. */
export interface DiagnosticReport {
  version: string;
  metrics: AggregateMetrics;
  findings: Finding[];
  tips: string[];
  /** Always states that this is diagnostics, never a band. */
  note: string;
}

// ---------------------------------------------------------------- grammar rules
interface Rule {
  id: string;
  category: string;
  re: RegExp;
  fix: (m: RegExpMatchArray) => string;
  why: string;
}
const RULES: Rule[] = [
  { id: "agree-dont", category: "subject-verb agreement", re: /\b(he|she|it)\s+don't\b/i, fix: (m) => `${m[1]} doesn't`, why: "Third-person singular subjects take “doesn't”." },
  { id: "agree-have", category: "subject-verb agreement", re: /\b(he|she|it)\s+have\b/i, fix: (m) => `${m[1]} has`, why: "Third-person singular subjects take “has”." },
  { id: "am-agree", category: "verb pattern", re: /\bi\s+am\s+agree\b/i, fix: () => "I agree", why: "“Agree” is a verb; it is not used with “am”." },
  { id: "more-er", category: "comparatives", re: /\bmore\s+(better|easier|bigger|happier|cheaper|faster|worse)\b/i, fix: (m) => m[1], why: "Don't combine “more” with an -er comparative." },
  { id: "a-vowel", category: "articles", re: /\ba\s+(apple|hour|honest|interesting|important|old|elephant|exam|idea|amazing|umbrella|english)\b/i, fix: (m) => `an ${m[1]}`, why: "Use “an” before a vowel sound." },
  { id: "an-cons", category: "articles", re: /\ban\s+(university|useful|big|good|great|person|house|book|car|lot|european|one)\b/i, fix: (m) => `a ${m[1]}`, why: "Use “a” before a consonant sound." },
  { id: "many-uncount", category: "countable/uncountable", re: /\bmany\s+(information|advice|money|furniture|homework|knowledge|equipment|traffic|time)\b/i, fix: (m) => `much ${m[1]}`, why: "This noun is uncountable — use “much” or “a lot of”." },
  { id: "informations", category: "countable/uncountable", re: /\b(informations|advices|furnitures|homeworks|knowledges|equipments)\b/i, fix: (m) => m[1].replace(/s$/i, ""), why: "This noun is uncountable and has no plural form." },
  { id: "people-is", category: "subject-verb agreement", re: /\bpeople\s+(is|was|has)\b/i, fix: (m) => `people ${({ is: "are", was: "were", has: "have" } as Record<string, string>)[m[1].toLowerCase()]}`, why: "“People” is plural." },
  { id: "discuss-about", category: "verb pattern", re: /\bdiscuss\s+about\b/i, fix: () => "discuss", why: "“Discuss” is transitive — no “about”." },
  { id: "since-years", category: "tense / time expressions", re: /\bsince\s+(\d+|two|three|four|five|ten)\s+(years|months|weeks)\b/i, fix: (m) => `for ${m[1]} ${m[2]}`, why: "Use “for” with a length of time, “since” with a starting point." },
  { id: "double-neg", category: "negation", re: /\b(don't|didn't|can't)\s+(know|have|want|see)\s+nothing\b/i, fix: (m) => `${m[1]} ${m[2]} anything`, why: "Avoid double negatives in standard English." },
];

export function grammarRuleFindings(answers: AnswerInput[]): Finding[] {
  const out: Finding[] = [];
  for (const a of answers) {
    for (const s of splitSentences(a.text)) {
      for (const r of RULES) {
        const m = s.match(r.re);
        if (m) {
          out.push({
            dimension: "GRA",
            answerId: a.answerId,
            kind: "error",
            category: r.category,
            originalText: s,
            suggestion: s.replace(r.re, r.fix(m)),
            explanation: r.why,
          });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- diagnostics (NOT scoring)
/**
 * Deterministic learning diagnostics from transcripts and metrics. This used
 * to be `heuristicScore()` and returned pseudo-bands; it now reports events
 * and statistics ONLY — no band is computed, ever. Bands exist solely in the
 * LLM rubric scorer; configure a provider to get scores.
 */
export function buildDiagnosticReport(answers: AnswerInput[], m: AggregateMetrics): DiagnosticReport {
  const answered = answers.filter((a) => !a.noResponse && a.text.trim());
  const ruleFindings = grammarRuleFindings(answered);

  const findings: Finding[] = [...ruleFindings];
  for (const p of m.answers) {
    if (p.fillerCount >= 3) findings.push({ dimension: "FC", answerId: p.answerId, kind: "issue", category: "fillers", originalText: p.fillers.join(", "), explanation: "Frequent fillers interrupt the flow. Pause silently or use a short planning phrase instead (e.g. “Let me think…”)." });
    if (p.repetitionCount >= 2) findings.push({ dimension: "FC", answerId: p.answerId, kind: "issue", category: "self-repetition", originalText: p.repeatedPhrases.join(" · "), explanation: "Repeated words or restarts suggest hesitation." });
    for (const w of p.topWords) findings.push({ dimension: "LR", answerId: p.answerId, kind: "issue", category: "word repetition", originalText: `“${w.word}” × ${w.count}`, explanation: "Vary vocabulary with synonyms or paraphrase." });
    if (p.wordCount > 0 && p.wordCount < 12) findings.push({ dimension: "FC", answerId: p.answerId, kind: "issue", category: "answer length", originalText: `${p.wordCount} words`, explanation: "The answer is very short. Extend with a reason, an example or a comparison." });
    if (p.connectives.length >= 3) findings.push({ dimension: "FC", answerId: p.answerId, kind: "strength", category: "linking", originalText: p.connectives.slice(0, 5).join(", "), explanation: "Good range of linking expressions." });
  }

  // Tip priority follows the strongest observable signals, not any band maths.
  const errPer100 = m.totalWords ? (ruleFindings.length / m.totalWords) * 100 : 0;
  const signals: { dim: LangDim; weight: number }[] = [
    { dim: "GRA", weight: errPer100 },
    { dim: "FC", weight: m.fillerRate + m.repetitionRate + (m.longPausesPerMin ?? 0) },
    { dim: "LR", weight: Math.max(0, 0.1 - m.advancedWordRatio) * 100 },
  ];
  const tips: Record<LangDim, string> = {
    FC: "Extend each answer with reason → example → result, and replace fillers with brief silent pauses.",
    LR: "Build topic vocabulary sets and practise paraphrasing the examiner's question instead of repeating it.",
    GRA: "Practise mixing tenses and complex sentences (relative clauses, conditionals) while keeping basic agreement accurate.",
  };
  const orderedTips = [...signals].sort((a, b) => b.weight - a.weight).map((s) => tips[s.dim]);

  return {
    version: DIAGNOSTIC_VERSION,
    metrics: m,
    findings,
    tips: orderedTips,
    note:
      "学习诊断（Diagnostic Metrics）：以下统计与提示来自确定性文本/声学分析，用于定位练习方向。" +
      "它们不是 IELTS Band，也不能换算成 Band；正式评分需要配置 LLM 评分 Provider（发音维度需要音频评测 Provider）。",
  };
}

// ---------------------------------------------------------------- LLM prompt + validation
export interface ScoringAnswerInput extends AnswerInput {
  index: number;
  /** Per-answer acoustic evidence (pauses, rates, runs, fillers…), optional. */
  audio?: AudioAnalysis | null;
}

export function buildScoringMessages(
  answers: ScoringAnswerInput[],
  sessionAudio?: SessionAudioAnalysis | null,
  pronunciation?: PronunciationEvidence | null,
) {
  const partRules = Object.entries(PART_RULES).map(([p, r]) => `- ${r}`).join("\n");
  const system = [
    "You are a certified IELTS Speaking examiner producing a diagnostic practice report.",
    `Rubric under test (${DESCRIPTOR_SOURCE.revision}, paraphrased from the IELTS public band descriptors):\n${descriptorBrief()}`,
    "How to score each criterion:",
    "1. Read every answer, then choose the SINGLE best-fit integer band for each criterion by matching the evidence against the descriptors above.",
    "2. If the performance sits between two integer bands, choose the closer band. A half band is a best-fit judgement; it is never an official descriptor level.",
    "3. `descriptorRefs` must list 2–4 ids copied EXACTLY from the rubric that justify the band — ids from the chosen band, or from an adjacent band when the performance straddles two. Never invent, alter or abbreviate an id.",
    "4. The rationale must cite the concrete evidence (what the candidate actually did), not restate the descriptor wording.",
    "5. The four criteria are judged SEPARATELY, each on its own rubric. Never mix them into one overall impression.",
    "6. Judge the representative performance across the WHOLE exam, not an average of per-question scores; if performance differs across parts, say so in the rationale.",
    "Part-specific discipline — hard rules:",
    partRules,
    "- Part 1 brevity specifically: short answers are the correct strategy; brevity alone must never lower any criterion, and verbosity must never raise it.",
    "- Part 2: judge how well the candidate sustains and develops the cue card (details, reasons, experiences, clear narrative order) — speaking the full two minutes is not itself a merit, and heavy word-search pauses or meaningless repetition during it is a real weakness.",
    "- Part 3: judge direct responses to abstract questions and the ability to explain, exemplify, compare and consider alternatives.",
    "- Do NOT infer a band from word count, answer length, or how many complex sentences were produced. Length is not quality.",
    "- Do NOT equate the number of connectives with coherence. Overused or misused linkers can lower Fluency & Coherence.",
    "- Do NOT equate rare or long words with lexical ability, and do not reward forced 'advanced' vocabulary; judge range, precision, collocation and paraphrase in context.",
    "- Do NOT count complex sentences as a grammar merit by itself; judge the candidate's CONTROL (accuracy under complexity) and how errors affect understanding.",
    pronunciation
      ? [
          "Pronunciation (P) scoring rules:",
          "- PRONUNCIATION EVIDENCE from the audio assessment service is provided below. Score P ONLY from that evidence; transcripts carry no pronunciation information and must never influence P.",
          "- The provider numbers (accuracy/fluency/prosody/completeness, word scores) are NOT IELTS bands. Never map a number directly to a band; match the evidence against the [P] rubric above.",
          "- Judge intelligibility first: which band's intelligibility/features description best fits the evidence? Cite P-rubric ids in descriptorRefs.",
          "- In every P evidence item use evidenceType \"audio\"; reference the worst-words list or per-answer numbers in `explanation`.",
        ].join("\n")
      : "Do NOT score pronunciation (P). No audio-based pronunciation evidence is available in this run, so you MUST omit the P dimension entirely; P is assessed from audio separately and must never be inferred from spelling, vocabulary or prosody numbers.",
    "Acoustic evidence rules:",
    "- Each answer may carry AUTO-COMPUTED acoustic evidence (pauses, speech rate, mean length of run, fillers, repetitions, self-corrections, pitch/energy variation). It is EVIDENCE about fluency, never a band: no formula maps wpm, pause counts or any other number to a band, and you must weigh it against what the candidate actually said.",
    "- Acoustic evidence primarily informs Fluency & Coherence. It must not by itself raise or lower Lexical Resource or Grammar & Accuracy, which are judged from language use.",
    "- Not every pause or filler is a weakness: pauses may mark planning or emphasis, and discourse markers can be legitimate. Judge position, duration, context and what was said around them.",
    "- Features listed as unavailable in `availability`/`warnings` were NOT measured. Never assume a value for a missing feature and never penalise the candidate for a measurement gap; record the gap in `limitations` when it materially limits the assessment.",
    "- Prosody numbers (pitch/energy variation) are descriptive only and must NOT be used to score Pronunciation.",
    "- Filler counts are automatic estimates: um/uh-class hesitation sounds are reliable, but discourse markers such as 'you know' can be legitimate — judge their severity in context, not by count alone.",
    "Evidence rules:",
    "- Every criterion MUST include 2–6 `evidence` items, each referencing a REAL answer index from the input list.",
    "- evidenceType \"transcript\": `quote` MUST appear verbatim in that answer's transcript.",
    "- evidenceType \"audio\": use ONLY startMs/endMs values that appear in the acoustic evidence below (e.g. located pauses); when word timings were unavailable for an answer, do NOT invent audio timestamps for it.",
    "- evidenceType \"metric\": reference aggregate statistics (rates, counts) without timestamps.",
    "- Transcripts come from automatic speech recognition and may contain recognition errors. If an apparent error could be an ASR artifact (homophones, dropped short words, odd isolated words), set possibleAsrError=true and do not penalise it heavily.",
    "- `confidence` (0–1) is your judgement of how well the EVIDENCE supports the band you chose (thin transcripts, missing audio, ASR noise → lower). It is not an IELTS band.",
    "- Be specific, avoid generic repeated comments, and never invent content the candidate did not say.",
    "- `strengths`/`weaknesses` are short rubric-anchored statements; `limitations` lists evidence gaps (e.g. 'no word timings for answer #2', 'low-audio-quality answer #4').",
    "Return ONLY JSON matching this TypeScript type:",
    `{"dimensions":{"FC":Criterion,"LR":Criterion,"GRA":Criterion${pronunciation ? ',"P":Criterion' : ""}},"findings":[{"dimension":"FC"|"LR"|"GRA"${pronunciation ? '|"P"' : ''},"answer":number,"kind":"error"|"strength"|"issue","category":string,"quote":string,"suggestion":string|null,"explanation":string,"possibleAsrError":boolean,"descriptorRefs":string[]}],"summary":string,"nextSteps":string[],"limitations":string[]}`,
    `where Criterion = {"band":number,"confidence":number,"rationale":string,"descriptorRefs":string[],"strengths":string[],"weaknesses":string[],"evidence":[{"answer":number,"evidenceType":"transcript"|"audio"|"metric","quote":string|null,"startMs":number|null,"endMs":number|null,"explanation":string}]}`,
    `${pronunciation ? "P is REQUIRED in dimensions because pronunciation evidence is provided." : "P must be OMITTED from dimensions (no pronunciation evidence this run)."}`,
    "Include 4–12 findings: typical errors with corrected rewrites, more natural alternatives, and at least two strengths (good expressions) if present.",
  ].flat().join("\n");
  const audioBlock = formatAudioEvidenceBlock(
    answers.filter((a) => a.audio).map((a) => ({ index: a.index, part: a.part, analysis: a.audio! })),
    sessionAudio ?? null,
  );
  const pronBlock = pronunciation
    ? [
        `PRONUNCIATION EVIDENCE (provider: ${pronunciation.providerId}${pronunciation.model ? ` · ${pronunciation.model}` : ""}; raw 0–100 scores, NOT bands):`,
        ...pronunciation.perAnswer.map((p) => {
          const words = p.worstWords.length ? `; weakest words: ${p.worstWords.map((w) => `${w.word}=${w.accuracy}${w.errorType ? `(${w.errorType})` : ""}`).join(", ")}` : "";
          return `- #${p.answer}: accuracy ${p.accuracy.toFixed(0)}, fluency ${p.fluency.toFixed(0)}, prosody ${p.prosody?.toFixed(0) ?? "n/a"}, completeness ${p.completeness?.toFixed(0) ?? "n/a"}, overall ${p.overall.toFixed(0)}${words}`;
        }),
      ].join("\n")
    : null;
  const user = [
    ...answers.map((a) =>
      `#${a.index} [Part ${a.part}] Q: ${a.prompt}\nDuration: ${(a.durationMs / 1000).toFixed(0)}s\nA: ${a.noResponse || !a.text.trim() ? "(no response)" : a.text}`,
    ),
    ...(audioBlock
      ? [
          "",
          "ACOUSTIC EVIDENCE (auto-computed from recordings, word timings and VAD; evidence, NOT band scores):",
          audioBlock,
        ]
      : []),
    ...(pronBlock ? ["", pronBlock] : []),
  ].join("\n\n");
  return { system, user };
}

export interface DescriptorRefCheck {
  /** Whether the model supplied the field at all (legacy outputs do not). */
  present: boolean;
  valid: string[];
  rejected: number;
}

/**
 * Validate model-supplied rubric ids against the real rubric.
 *
 * - unknown id / wrong dimension / non-string  → rejected
 * - a band more than one step away from the score → rejected
 * - duplicates are collapsed
 *
 * Rejected ids are NEVER surfaced, so a fabricated id can never reach the DB or UI.
 */
export function checkDescriptorRefs(raw: unknown, dimension: CriterionKey, band: number): DescriptorRefCheck {
  if (!Array.isArray(raw)) return { present: false, valid: [], rejected: 0 };
  const lo = Math.floor(band) - 1;
  const hi = Math.ceil(band) + 1;
  const seen = new Set<string>();
  const valid: string[] = [];
  let rejected = 0;
  for (const item of raw) {
    if (typeof item !== "string") { rejected++; continue; }
    const id = item.trim();
    const d = findDescriptor(id);
    if (!d || d.dimension !== dimension || d.band < lo || d.band > hi) { rejected++; continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    valid.push(id);
  }
  return { present: true, valid, rejected };
}

export class ScoringValidationError extends Error {}

function isBand(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 9;
}

export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new ScoringValidationError("no JSON object in model output");
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (e) {
    throw new ScoringValidationError(`invalid JSON: ${(e as Error).message}`);
  }
}

/**
 * Validate LLM output. Throws if any FC/LR/GRA dimension is missing/invalid.
 * P is validated ONLY when `allowPronunciation` (audio-provider evidence was
 * supplied); an invalid or absent P then simply stays null → not_assessed.
 *
 * Anti-fabrication:
 *  - findings whose quote is not in the transcripts are dropped;
 *  - evidence items referencing unknown answers are dropped;
 *  - transcript evidence must quote that answer verbatim;
 *  - audio evidence with timestamps is accepted only for answers that actually
 *    HAVE word timings, and bounds must sit inside the recording;
 *  - invented rubric ids / wrong-dimension refs are rejected.
 */
export function validateLanguageScore(
  raw: unknown,
  answers: (AnswerInput & { index: number })[],
  opts?: { allowPronunciation?: boolean },
): { score: LanguageScore; dropped: number; rejectedRefs: number; droppedEvidence: number } {
  if (!raw || typeof raw !== "object") throw new ScoringValidationError("output is not an object");
  const o = raw as Record<string, unknown>;
  const dimsIn = o.dimensions as Record<string, Record<string, unknown>> | undefined;
  if (!dimsIn) throw new ScoringValidationError("missing dimensions");

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  const byIndex = new Map(answers.map((a) => [a.index, a]));
  const ctxByIndex = new Map(answers.map((a) => [a.index, { durationMs: Math.max(0, a.durationMs), wordTimings: !!(a.words && a.words.length >= 2) }]));
  const allText = norm(answers.map((a) => a.text).join(" "));

  const stringList = (v: unknown, cap: number): string[] =>
    Array.isArray(v) ? [...new Set((v as unknown[]).filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()))].slice(0, cap) : [];
  const confidenceOf = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? Math.round(n * 100) / 100 : null;
  };

  const parseEvidence = (rawItems: unknown, dimKey: CriterionKey): { items: EvidenceItem[]; dropped: number } => {
    const items: EvidenceItem[] = [];
    let dropped = 0;
    for (const e of Array.isArray(rawItems) ? (rawItems as Record<string, unknown>[]).slice(0, 12) : []) {
      const idx = Number(e.answer);
      const a = byIndex.get(idx);
      const ctx = ctxByIndex.get(idx);
      const type = e.evidenceType;
      const explanation = typeof e.explanation === "string" ? e.explanation.trim() : "";
      if (!a || !ctx || !explanation || !["transcript", "audio", "metric"].includes(type as string)) {
        dropped++;
        continue;
      }
      if (type === "transcript") {
        const quote = typeof e.quote === "string" ? e.quote : "";
        const hay = norm(a.text) || allText;
        if (!quote || !hay.includes(norm(quote))) { dropped++; continue; }
        items.push({ answer: idx, evidenceType: "transcript", quote, explanation });
        continue;
      }
      if (type === "audio") {
        const start = Number(e.startMs);
        const end = Number(e.endMs);
        // Real word timings are the only legitimate source of audio bounds.
        if (!ctx.wordTimings || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > ctx.durationMs + 2000) {
          dropped++;
          continue;
        }
        items.push({ answer: idx, evidenceType: "audio", startMs: Math.round(start), endMs: Math.round(end), explanation });
        continue;
      }
      // metric: aggregate numbers only — timestamps are not meaningful, strip them.
      items.push({
        answer: idx,
        evidenceType: "metric",
        quote: typeof e.quote === "string" && norm(a.text).includes(norm(e.quote)) ? e.quote : null,
        explanation,
      });
      void dimKey;
    }
    return { items: items.slice(0, 8), dropped };
  };

  const parseCriterion = (key: CriterionKey, v: Record<string, unknown> | undefined, requireRefs: boolean): { assessment: DimensionScore; rejectedRefs: number; droppedEvidence: number } | null => {
    if (!v || !isBand(v.band) || typeof v.rationale !== "string" || !v.rationale.trim()) return null;
    const band = toHalfBand(v.band);
    const check = checkDescriptorRefs(v.descriptorRefs, key, band);
    if (check.present) {
      const own = new Set(allowedBandsFor(band));
      const supportsBand = check.valid.some((id) => own.has(findDescriptor(id)!.band));
      // Cited refs but none survived validation → the citation is fabricated;
      // void the dimension rather than keep an unsupported judgement.
      if (!check.valid.length || (requireRefs && !supportsBand)) return null;
    }
    const ev = parseEvidence(v.evidence, key);
    return {
      assessment: {
        band,
        rationale: v.rationale.trim(),
        descriptorRefs: check.valid,
        confidence: confidenceOf(v.confidence),
        strengths: stringList(v.strengths, 6),
        weaknesses: stringList(v.weaknesses, 6),
        evidence: ev.items,
      },
      rejectedRefs: check.rejected,
      droppedEvidence: ev.dropped,
    };
  };

  let rejectedRefs = 0;
  let droppedEvidence = 0;
  const dims = {} as LanguageScore["dimensions"];
  for (const d of ["FC", "LR", "GRA"] as LangDim[]) {
    const parsed = parseCriterion(d, dimsIn[d] as Record<string, unknown> | undefined, true);
    if (!parsed) throw new ScoringValidationError(`dimension ${d} missing or invalid`);
    dims[d] = parsed.assessment;
    rejectedRefs += parsed.rejectedRefs;
    droppedEvidence += parsed.droppedEvidence;
  }
  // P: optional, and only judgeable when audio-provider evidence exists.
  let pronunciation: DimensionScore | null = null;
  if (opts?.allowPronunciation) {
    const parsed = parseCriterion("P", dimsIn.P as Record<string, unknown> | undefined, false);
    if (parsed) {
      pronunciation = parsed.assessment;
      rejectedRefs += parsed.rejectedRefs;
      droppedEvidence += parsed.droppedEvidence;
    }
  }
  const allowedFindings = pronunciation ? ["FC", "LR", "GRA", "P"] : ["FC", "LR", "GRA"];

  const findings: Finding[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const f of Array.isArray(o.findings) ? (o.findings as Record<string, unknown>[]) : []) {
    const quote = typeof f.quote === "string" ? f.quote : "";
    const dim = f.dimension;
    if (!quote || !allowedFindings.includes(dim as string) || typeof f.explanation !== "string") {
      dropped++;
      continue;
    }
    const a = byIndex.get(Number(f.answer));
    const hay = a ? norm(a.text) : allText;
    if (!hay.includes(norm(quote)) || seen.has(norm(quote) + dim)) {
      dropped++;
      continue;
    }
    seen.add(norm(quote) + dim);
    const dimKey = dim as LangDim | "P";
    const bandForRefs = dimKey === "P" ? pronunciation!.band : dims[dimKey].band;
    const refCheck = checkDescriptorRefs(f.descriptorRefs, dimKey, bandForRefs);
    rejectedRefs += refCheck.rejected;
    findings.push({
      dimension: dimKey,
      answerId: a?.answerId ?? null,
      kind: (["error", "strength", "issue"].includes(f.kind as string) ? f.kind : "issue") as Finding["kind"],
      category: typeof f.category === "string" ? f.category : "general",
      originalText: quote,
      suggestion: typeof f.suggestion === "string" ? f.suggestion : null,
      explanation: f.explanation,
      possibleAsrError: f.possibleAsrError === true,
      descriptorRefs: refCheck.valid,
      evidenceType: "transcript",
    });
  }
  return {
    score: {
      dimensions: dims,
      pronunciation,
      findings,
      summary: typeof o.summary === "string" ? o.summary : "",
      nextSteps: Array.isArray(o.nextSteps) ? (o.nextSteps as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 6) : [],
      limitations: stringList(o.limitations, 8),
    },
    dropped,
    rejectedRefs,
    droppedEvidence,
  };
}
