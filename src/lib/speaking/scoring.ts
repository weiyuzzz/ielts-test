/**
 * Language scoring (FC / LR / GRA). Two interchangeable scorers:
 *  - LLM scorer: examiner-style judgement with sentence-level evidence (validated JSON)
 *  - Heuristic scorer: deterministic metrics + conservative grammar rules (no LLM)
 * Pronunciation is NEVER scored here — it requires an audio-based provider.
 */
import { toHalfBand, clampBand } from "./bands";
import type { AggregateMetrics, AnswerInput } from "./metrics";
import { splitSentences } from "./metrics";
import { criteriaBrief } from "./band-descriptors";

export const SCORING_PROMPT_VERSION = "speaking-language-v2.0-criteria";
export const HEURISTIC_VERSION = "heuristic-v1.1";

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
}

export interface LanguageScore {
  dimensions: Record<LangDim, { band: number; rationale: string }>;
  findings: Finding[];
  summary: string;
  nextSteps: string[];
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

// ---------------------------------------------------------------- heuristic scorer
function interp(x: number, pts: [number, number][]): number {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return pts[pts.length - 1][1];
}

export function heuristicScore(answers: AnswerInput[], m: AggregateMetrics): LanguageScore {
  const answered = answers.filter((a) => !a.noResponse && a.text.trim());
  const ruleFindings = grammarRuleFindings(answered);
  const avgWordsPerAnswer = answered.length ? m.totalWords / answered.length : 0;

  // ---- FC (length of turn, speech rate, hesitation, linking)
  let fc = interp(avgWordsPerAnswer, [[5, 3.5], [15, 4.5], [30, 5.5], [50, 6.5], [80, 7.5], [120, 8]]);
  if (m.wpm !== null) fc += interp(m.wpm, [[60, -1], [90, -0.5], [110, 0], [160, 0.25], [200, -0.25]]);
  fc -= Math.min(1, m.fillerRate * 0.12) + Math.min(0.75, m.repetitionRate * 0.25);
  fc += interp(m.connectiveVariety, [[0, -0.5], [3, 0], [7, 0.5], [12, 0.75]]);
  if (m.longPausesPerMin !== null) fc -= Math.min(1, m.longPausesPerMin * 0.2);
  fc -= Math.min(1.5, m.noResponseCount * 0.5);

  // ---- LR (less-common vocabulary is the main signal; MATTR saturates on short answers)
  let lr = interp(m.advancedWordRatio, [[0, 4], [0.04, 5], [0.08, 6], [0.12, 7], [0.18, 8]]);
  lr += interp(m.mattr, [[0.55, -1], [0.65, -0.5], [0.75, 0], [0.85, 0.25]]);
  if (avgWordsPerAnswer < 20) lr = Math.min(lr, 5);
  if (m.totalWords < 60) lr = Math.min(lr, 5);
  lr -= Math.min(1, m.noResponseCount * 0.25);

  // ---- GRA (complexity markers, sentence length, rule-detected errors)
  let gra = interp(m.complexPer100, [[0, 4.5], [2, 5], [4, 6], [6.5, 7], [9, 7.5]]);
  gra += interp(m.avgSentenceLength, [[4, -0.5], [8, 0], [14, 0.5], [30, 0]]);
  const errPer100 = m.totalWords ? (ruleFindings.length / m.totalWords) * 100 : 0;
  gra -= Math.min(1.5, errPer100 * 0.4);
  if (m.totalWords < 60) gra = Math.min(gra, 5);

  const findings: Finding[] = [...ruleFindings];
  for (const p of m.answers) {
    if (p.fillerCount >= 3) findings.push({ dimension: "FC", answerId: p.answerId, kind: "issue", category: "fillers", originalText: p.fillers.join(", "), explanation: "Frequent fillers interrupt the flow. Pause silently or use a short planning phrase instead (e.g. “Let me think…”)." });
    if (p.repetitionCount >= 2) findings.push({ dimension: "FC", answerId: p.answerId, kind: "issue", category: "self-repetition", originalText: p.repeatedPhrases.join(" · "), explanation: "Repeated words or restarts suggest hesitation." });
    for (const w of p.topWords) findings.push({ dimension: "LR", answerId: p.answerId, kind: "issue", category: "word repetition", originalText: `“${w.word}” × ${w.count}`, explanation: "Vary vocabulary with synonyms or paraphrase." });
    if (p.wordCount > 0 && p.wordCount < 12) findings.push({ dimension: "FC", answerId: p.answerId, kind: "issue", category: "answer length", originalText: `${p.wordCount} words`, explanation: "The answer is very short. Extend with a reason, an example or a comparison." });
    if (p.connectives.length >= 3) findings.push({ dimension: "FC", answerId: p.answerId, kind: "strength", category: "linking", originalText: p.connectives.slice(0, 5).join(", "), explanation: "Good range of linking expressions." });
  }

  // floor of 2: any intelligible speech is above band 1 (band 0/1 are for no attempt / no communication)
  const r = (n: number) => toHalfBand(clampBand(Math.max(2, n)));
  const dims = {
    FC: { band: r(fc), rationale: `Heuristic: ${avgWordsPerAnswer.toFixed(0)} words/answer, ${m.wpm ?? "n/a"} wpm, filler rate ${m.fillerRate.toFixed(1)}/100 words, ${m.connectiveVariety} distinct linking expressions${m.longPausesPerMin !== null ? `, ${m.longPausesPerMin.toFixed(1)} long pauses/min` : ""}. Coherence of ideas is not judged without an LLM.` },
    LR: { band: r(lr), rationale: `Heuristic: lexical diversity (MATTR) ${m.mattr.toFixed(2)}, less-common word ratio ${(m.advancedWordRatio * 100).toFixed(1)}%. Collocation and idiom accuracy are not judged without an LLM.` },
    GRA: { band: r(gra), rationale: `Heuristic: ${m.complexPer100.toFixed(1)} complex-structure markers/100 words, avg sentence length ${m.avgSentenceLength.toFixed(1)} words, ${ruleFindings.length} rule-detected errors. Only a small set of high-precision error patterns is checked.` },
  };
  const weakest = (Object.entries(dims) as [LangDim, { band: number }][]).sort((a, b) => a[1].band - b[1].band)[0][0];
  const tips: Record<LangDim, string> = {
    FC: "Extend each answer with reason → example → result, and replace fillers with brief silent pauses.",
    LR: "Build topic vocabulary sets and practise paraphrasing the examiner's question instead of repeating it.",
    GRA: "Practise mixing tenses and complex sentences (relative clauses, conditionals) while keeping basic agreement accurate.",
  };
  return {
    dimensions: dims,
    findings,
    summary: `Automatic heuristic analysis of ${answered.length} answers (${m.totalWords} words). Configure an LLM provider for examiner-style, sentence-level feedback.`,
    nextSteps: [tips[weakest], ...Object.entries(tips).filter(([k]) => k !== weakest).map(([, v]) => v)],
  };
}

// ---------------------------------------------------------------- LLM prompt + validation
export function buildScoringMessages(answers: (AnswerInput & { index: number })[]) {
  const system = [
    "You are a certified IELTS Speaking examiner producing a diagnostic report.",
    `Apply these criteria strictly when judging the candidate:\n${criteriaBrief()}`,
    "Score ONLY Fluency & Coherence (FC), Lexical Resource (LR) and Grammatical Range & Accuracy (GRA) (0–9, half bands allowed).",
    "Judge each answer against the expectations for ITS PART. A short, direct Part 1 answer is correct and must not lose fluency marks; a long Part 3 answer is expected. Never use word count alone as a proxy for fluency.",
    "For each dimension, the rationale must name the concrete key indicators you used (e.g. speech continuity, cohesive devices, collocation, paraphrase, error density).",
    "Set `category` to that concrete key indicator, not a vague label like 'grammar'.",
    "Do NOT score pronunciation — you only see ASR transcripts.",
    "Transcripts come from automatic speech recognition and may contain recognition errors. If a likely error could be an ASR artifact (homophones, dropped short words, odd single words), set possibleAsrError=true and do not penalise it heavily.",
    "Every finding MUST quote text that appears verbatim in the candidate's transcripts (field `quote`) and reference the answer index.",
    "Be specific, avoid generic repeated comments, do not invent content the candidate did not say.",
    "Return ONLY JSON matching this TypeScript type:",
    `{"dimensions":{"FC":{"band":number,"rationale":string},"LR":{"band":number,"rationale":string},"GRA":{"band":number,"rationale":string}},
"findings":[{"dimension":"FC"|"LR"|"GRA","answer":number,"kind":"error"|"strength"|"issue","category":string,"quote":string,"suggestion":string|null,"explanation":string,"possibleAsrError":boolean}],
"summary":string,"nextSteps":string[]}`,
    "Include 4–12 findings: typical errors with corrected rewrites, more natural alternatives, and at least two strengths (good expressions) if present.",
  ].join("\n");
  const user = answers
    .map((a) => `#${a.index} [Part ${a.part}] Q: ${a.prompt}\nDuration: ${(a.durationMs / 1000).toFixed(0)}s\nA: ${a.noResponse || !a.text.trim() ? "(no response)" : a.text}`)
    .join("\n\n");
  return { system, user };
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
 * Findings whose quote cannot be found in the transcripts are dropped (anti-hallucination).
 */
export function validateLanguageScore(raw: unknown, answers: (AnswerInput & { index: number })[]): { score: LanguageScore; dropped: number } {
  if (!raw || typeof raw !== "object") throw new ScoringValidationError("output is not an object");
  const o = raw as Record<string, unknown>;
  const dimsIn = o.dimensions as Record<string, { band?: unknown; rationale?: unknown }> | undefined;
  if (!dimsIn) throw new ScoringValidationError("missing dimensions");
  const dims = {} as LanguageScore["dimensions"];
  for (const d of ["FC", "LR", "GRA"] as LangDim[]) {
    const v = dimsIn[d];
    if (!v || !isBand(v.band) || typeof v.rationale !== "string" || !v.rationale.trim()) {
      throw new ScoringValidationError(`dimension ${d} missing or invalid`);
    }
    dims[d] = { band: toHalfBand(v.band), rationale: v.rationale.trim() };
  }
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  const byIndex = new Map(answers.map((a) => [a.index, a]));
  const allText = norm(answers.map((a) => a.text).join(" "));
  const findings: Finding[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const f of Array.isArray(o.findings) ? (o.findings as Record<string, unknown>[]) : []) {
    const quote = typeof f.quote === "string" ? f.quote : "";
    const dim = f.dimension;
    if (!quote || !["FC", "LR", "GRA"].includes(dim as string) || typeof f.explanation !== "string") {
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
    findings.push({
      dimension: dim as LangDim,
      answerId: a?.answerId ?? null,
      kind: (["error", "strength", "issue"].includes(f.kind as string) ? f.kind : "issue") as Finding["kind"],
      category: typeof f.category === "string" ? f.category : "general",
      originalText: quote,
      suggestion: typeof f.suggestion === "string" ? f.suggestion : null,
      explanation: f.explanation,
      possibleAsrError: f.possibleAsrError === true,
    });
  }
  return {
    score: {
      dimensions: dims,
      findings,
      summary: typeof o.summary === "string" ? o.summary : "",
      nextSteps: Array.isArray(o.nextSteps) ? (o.nextSteps as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 6) : [],
    },
    dropped,
  };
}
