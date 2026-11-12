/**
 * Rubric + scoring-standardisation regression tests.
 *
 * Run with: npx tsx --test tests/scoring-rubric.test.ts
 *
 * These tests are fully offline: no paid LLM call is made in CI. Where a test
 * needs "model output", it feeds a hand-written JSON fixture through the same
 * validator the server uses.
 *
 * SAMPLE PROVENANCE (important):
 * The LOW / MID / HIGH answers below are SYNTHETIC samples duplicated from the
 * existing evaluation set in tests/unit.test.ts. They have NOT been reviewed by
 * a human examiner and must never be presented as official IELTS answers or as
 * an official band reference. They exist only to check monotonicity.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BAND_DESCRIPTORS, BAND_LEVELS, CRITERIA, DESCRIPTOR_SOURCE,
  descriptorBrief, descriptorsFor, findDescriptor, isDescriptorId,
  halfBandRule, allowedBandsFor, type CriterionKey,
} from "../src/lib/speaking/band-descriptors";
import {
  buildScoringMessages, validateLanguageScore, checkDescriptorRefs,
  SCORING_PROMPT_VERSION, buildDiagnosticReport, ScoringValidationError,
} from "../src/lib/speaking/scoring";
import { aggregate, type AnswerInput } from "../src/lib/speaking/metrics";
import type { WordTiming } from "../src/db/schema";

const DIMS: CriterionKey[] = ["FC", "LR", "GRA", "P"];
const ID_RE = /^(FC|LR|GRA|P)-B([0-9])-([0-9]{2})$/;

// ---------------------------------------------------------------- 1. coverage
test("1. every criterion has at least one descriptor at every band 0–9", () => {
  for (const dim of DIMS) {
    for (const band of BAND_LEVELS) {
      const items = descriptorsFor(dim, band);
      assert.ok(items.length >= 1, `${dim} band ${band} has no descriptor`);
    }
  }
  // 4 criteria × 10 bands is the minimum surface area of a complete rubric.
  assert.ok(BAND_DESCRIPTORS.length >= 40, `only ${BAND_DESCRIPTORS.length} descriptors`);
});

test("1b. transitional bands (3/5/7) carry explicit adjacent-band clarifiers", () => {
  for (const dim of DIMS) {
    for (const band of [3, 5, 7]) {
      const items = descriptorsFor(dim, band);
      assert.ok(
        items.some((d) => d.focus === "transition" || /band [0-9]/i.test(d.text)),
        `${dim} band ${band} lacks a transitional clarifier`,
      );
    }
  }
  // P keeps the official bridging formula at 3/5/7; the others use the appended clarifiers.
  assert.ok(descriptorsFor("P", 7).every((d) => /band [0-9]/i.test(d.text)), "P band 7 must stay bridging");
  assert.ok(BAND_DESCRIPTORS.some((d) => d.id === "FC-B7-04"), "appended descriptors keep stable generated ids");
  assert.match(DESCRIPTOR_SOURCE.revision, /^rubric-2/, "rubric revision must be bumped with the calibration");
});

// ---------------------------------------------------------------- 2. uniqueness
test("2. all descriptor ids are unique", () => {
  const ids = BAND_DESCRIPTORS.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate descriptor id");
});

// ---------------------------------------------------------------- 3. valid bands
test("3. no invalid band: every band is an integer 0–9 (no fabricated half bands)", () => {
  for (const d of BAND_DESCRIPTORS) {
    assert.equal(Number.isInteger(d.band), true, `${d.id} has non-integer band ${d.band}`);
    assert.ok(d.band >= 0 && d.band <= 9, `${d.id} band out of range`);
  }
  // The rubric must contain NO half-band descriptor.
  assert.equal(BAND_DESCRIPTORS.some((d) => !Number.isInteger(d.band)), false);
  assert.match(halfBandRule(), /integer/i);
  assert.match(halfBandRule(), /Never invent/i);
});

// ---------------------------------------------------------------- 4. id ↔ dimension
test("4. descriptor id encodes its own dimension and band", () => {
  for (const d of BAND_DESCRIPTORS) {
    const m = d.id.match(ID_RE);
    assert.ok(m, `${d.id} does not match the id grammar`);
    assert.equal(m![1], d.dimension, `${d.id} dimension mismatch`);
    assert.equal(Number(m![2]), d.band, `${d.id} band mismatch`);
  }
  // findDescriptor / isDescriptorId agree with the data set.
  assert.equal(findDescriptor("FC-B7-01")?.dimension, "FC");
  assert.equal(isDescriptorId("FC-B7-01"), true);
  assert.equal(isDescriptorId("FC-B7-99"), false);
  assert.equal(findDescriptor("NOPE-B7-01"), undefined);
});

test("4b. half-band scoring may only cite the two adjacent integer bands", () => {
  assert.deepEqual(allowedBandsFor(6.5), [6, 7]);
  assert.deepEqual(allowedBandsFor(7), [7]);
  assert.deepEqual(allowedBandsFor(0), [0]);
  assert.deepEqual(allowedBandsFor(9), [9]);
});

// ---------------------------------------------------------------- 5. prompt
const answers: (AnswerInput & { index: number })[] = [
  { answerId: "a1", index: 1, part: 1, prompt: "Where do you live?", durationMs: 9000, text: "I live in a small city in the south. It is quite quiet, which I like." },
  { answerId: "a2", index: 2, part: 2, prompt: "Describe a skill you learned.", durationMs: 90000, text: "I would like to talk about learning to swim. When I was ten my parents took me to a pool, and at first I was frightened of the water, but after a few months I could swim, and now I really enjoy it." },
  { answerId: "a3", index: 3, part: 3, prompt: "Why do people learn new skills?", durationMs: 40000, text: "I think people learn new skills because it helps them at work. For example, if you can use a computer well you can find a better job, although it also depends on the person." },
];

test("5. scoring prompt injects all four criteria with citable descriptor ids", () => {
  const { system, user } = buildScoringMessages(answers);
  for (const dim of DIMS) {
    const ids = BAND_DESCRIPTORS.filter((d) => d.dimension === dim).map((d) => d.id);
    assert.ok(ids.some((id) => system.includes(id)), `prompt is missing ${dim} descriptor ids`);
  }
  assert.ok(system.includes(DESCRIPTOR_SOURCE.revision), "prompt should name the rubric revision");
  assert.ok(system.includes("descriptorRefs"), "prompt must ask for descriptorRefs");
  // Every answer must be visible to the model with its index.
  for (const a of answers) assert.ok(user.includes(`#${a.index}`));
  assert.match(SCORING_PROMPT_VERSION, /v5\./, "v5 injects multimodal evidence rules (audio + provider + part rules)");
  assert.notEqual(SCORING_PROMPT_VERSION, "speaking-language-v2.0-criteria", "prompt version must be bumped");
});

test("5b. prompt forbids mechanical band decisions and text-based pronunciation scoring", () => {
  const { system } = buildScoringMessages(answers);
  assert.match(system, /Do NOT infer a band from word count/i);
  assert.match(system, /Do NOT equate the number of connectives with coherence/i);
  assert.match(system, /brevity alone must never lower/i);
  assert.match(system, /Do NOT score pronunciation/i);
  assert.match(system, /best-fit integer band/i);
  assert.match(system, /Never invent/i);
});

// ---------------------------------------------------------------- 6 / 7. refs
function modelOutput(overrides: Record<string, unknown> = {}) {
  return {
    dimensions: {
      FC: { band: 6, rationale: "Keeps going but repeats words when searching for language.", descriptorRefs: ["FC-B6-01", "FC-B6-02"] },
      LR: { band: 6, rationale: "Adequate range; some paraphrase succeeds.", descriptorRefs: ["LR-B6-01", "LR-B6-02"] },
      GRA: { band: 6.5, rationale: "Mix of simple and complex; complex forms attract errors.", descriptorRefs: ["GRA-B6-01", "GRA-B7-01"] },
    },
    findings: [
      { dimension: "GRA", answer: 3, kind: "error", category: "conditionals", quote: "if you can use a computer well you can find a better job", suggestion: null, explanation: "Complex conditional is used but the tense sequence is inconsistent.", possibleAsrError: false, descriptorRefs: ["GRA-B6-02"] },
      { dimension: "LR", answer: 2, kind: "strength", category: "collocation", quote: "frightened of the water", suggestion: null, explanation: "Natural collocation.", possibleAsrError: false, descriptorRefs: ["LR-B6-01"] },
    ],
    summary: "Solid band 6 performance.",
    nextSteps: ["Use more precise vocabulary."],
    ...overrides,
  };
}

test("6. valid model output keeps only real, dimension-matching descriptorRefs", () => {
  const { score, rejectedRefs } = validateLanguageScore(modelOutput(), answers);
  assert.equal(score.dimensions.FC.band, 6);
  assert.deepEqual(score.dimensions.FC.descriptorRefs, ["FC-B6-01", "FC-B6-02"]);
  assert.deepEqual(score.dimensions.GRA.descriptorRefs, ["GRA-B6-01", "GRA-B7-01"]);
  assert.equal(rejectedRefs, 0);
  for (const d of ["FC", "LR", "GRA"] as const) {
    for (const id of score.dimensions[d].descriptorRefs) {
      const found = findDescriptor(id);
      assert.ok(found, `${id} does not exist`);
      assert.equal(found!.dimension, d, `${id} is not a ${d} descriptor`);
    }
  }
  for (const f of score.findings) {
    for (const id of f.descriptorRefs ?? []) {
      assert.equal(findDescriptor(id)!.dimension, f.dimension, "finding cites another dimension");
    }
  }
});

test("7. fabricated descriptor ids are rejected and never surface", () => {
  // (a) dimension cites only fake ids → the whole result is rejected (forces a retry).
  const fake = modelOutput();
  fake.dimensions.FC.descriptorRefs = ["FC-B9-99", "FC-B7-42"];
  assert.throws(() => validateLanguageScore(fake, answers), ScoringValidationError);

  // (b) dimension cites another dimension's descriptor → rejected.
  const crossDim = modelOutput();
  crossDim.dimensions.FC.descriptorRefs = ["LR-B6-01"];
  assert.throws(() => validateLanguageScore(crossDim, answers), ScoringValidationError);

  // (c) a mix keeps the real ones, drops the fake, and reports the rejection.
  const mixed = modelOutput();
  mixed.dimensions.FC.descriptorRefs = ["FC-B6-01", "FC-B9-99", "MADE-UP"];
  mixed.findings[0].descriptorRefs = ["GRA-B6-02", "GRA-B1-01"];
  const { score, rejectedRefs } = validateLanguageScore(mixed, answers);
  assert.deepEqual(score.dimensions.FC.descriptorRefs, ["FC-B6-01"]);
  assert.deepEqual(score.findings[0].descriptorRefs, ["GRA-B6-02"]);
  assert.ok(rejectedRefs >= 2, `expected rejections, got ${rejectedRefs}`);
  const surfaced = JSON.stringify(score);
  assert.equal(surfaced.includes("FC-B9-99"), false);
  assert.equal(surfaced.includes("MADE-UP"), false);

  // (d) checkDescriptorRefs is the single gate used above.
  assert.deepEqual(checkDescriptorRefs("FC-B6-01", "FC", 6), { present: false, valid: [], rejected: 0 });
  assert.equal(checkDescriptorRefs(["FC-B6-01"], "LR", 6).valid.length, 0);
  assert.equal(checkDescriptorRefs(["FC-B6-01", "FC-B6-01"], "FC", 6).valid.length, 1, "duplicates collapsed");
});

// ---------------------------------------------------------------- 8. anti-hallucination
test("8. findings whose quote is not in the transcript are still dropped", () => {
  const out = modelOutput();
  out.findings.push({
    dimension: "LR", answer: 1, kind: "strength", category: "idiom",
    quote: "I adore classical symphonies", // not said by the candidate
    suggestion: null, explanation: "Not present in the transcript.",
    possibleAsrError: false, descriptorRefs: ["LR-B6-01"],
  });
  const { score, dropped } = validateLanguageScore(out, answers);
  assert.equal(dropped, 1);
  assert.equal(score.findings.some((f) => f.originalText.includes("symphonies")), false);
});

// ---------------------------------------------------------------- 9. short Part 1
test("9. a short Part 1 answer is not mechanically downgraded by validation", () => {
  const shortAnswers: (AnswerInput & { index: number })[] = [
    { answerId: "s1", index: 1, part: 1, prompt: "Do you work or study?", durationMs: 3000, text: "I study." },
  ];
  const out = {
    dimensions: {
      FC: { band: 7, rationale: "Direct, fluent short answer, appropriate for Part 1.", descriptorRefs: ["FC-B7-01"] },
      LR: { band: 7, rationale: "Precise word choice for the question.", descriptorRefs: ["LR-B7-01"] },
      GRA: { band: 7, rationale: "Error-free simple sentence.", descriptorRefs: ["GRA-B7-01"] },
    },
    findings: [],
    summary: "Short but appropriate.",
    nextSteps: [],
  };
  const { score } = validateLanguageScore(out, shortAnswers);
  // Nothing in the validator may cap a band because of word count / length.
  assert.equal(score.dimensions.FC.band, 7);
  assert.equal(score.dimensions.LR.band, 7);
  assert.equal(score.dimensions.GRA.band, 7);
});

// ---------------------------------------------------------------- 10. pronunciation
test("10. pronunciation is never derived from transcripts", () => {
  // The language scorer only returns FC/LR/GRA — a P band can only come from audio.
  const { score } = validateLanguageScore(modelOutput(), answers);
  assert.deepEqual(Object.keys(score.dimensions).sort(), ["FC", "GRA", "LR"]);
  assert.equal("P" in score.dimensions, false);

  // A model that tries to score P must not be able to smuggle it through.
  const withP = modelOutput({
    dimensions: {
      ...modelOutput().dimensions,
      P: { band: 8, rationale: "Sounds good.", descriptorRefs: ["P-B8-01"] },
    },
  });
  const v = validateLanguageScore(withP, answers);
  assert.equal("P" in v.score.dimensions, false, "P must be ignored by the text scorer");

  // And the prompt tells the model not to score it.
  assert.match(buildScoringMessages(answers).system, /P is assessed from audio separately/i);
});

// ---------------------------------------------------------------- 11. monotonicity
/**
 * SYNTHETIC reference samples (NOT human-reviewed, NOT official answers).
 * Duplicated from tests/unit.test.ts so the rubric change can be checked for
 * monotonicity without touching that file.
 */
const REFERENCE_SAMPLES = { reviewed: false, source: "synthetic; duplicated from tests/unit.test.ts" } as const;
const ans = (id: string, text: string, sec = 30): AnswerInput => ({ answerId: id, part: 1, prompt: "Q", text, durationMs: sec * 1000 });
const LOW = [
  ans("l1", "Um I like music. Uh pop music. I I listen every day.", 10),
  ans("l2", "My hometown is big. It is good. People is friendly. Um, I like it.", 10),
  ans("l3", "I am agree. It is more better. Uh I don't know nothing.", 10),
  ans("l4", "I read book. Um sometimes. It is good for me. Yes.", 10),
];
const MID = [
  ans("m1", "I usually listen to pop music when I'm commuting, because it helps me relax. I also like some rock bands, but I don't listen to them as often as I used to.", 15),
  ans("m2", "My hometown is a medium-sized city in the south. It has changed a lot since I was a child, for example there are many new buildings and the traffic is much worse now.", 15),
  ans("m3", "I think reading is important, so I try to read every evening. Mostly I read novels, although sometimes I read articles about technology on my phone.", 15),
  ans("m4", "Mornings are quite busy for me. I get up at seven, have a quick breakfast and then I go to work. At weekends it's different because I can sleep longer.", 15),
];
const HIGH = [
  ans("h1", "Honestly, my taste in music has broadened considerably over the years. Whereas I used to listen almost exclusively to mainstream pop, I've gradually developed an appreciation for jazz, which I find incredibly soothing after a demanding day. If I had more time, I would definitely learn to play the saxophone.", 20),
  ans("h2", "My hometown, which is a coastal city in the south, has undergone a remarkable transformation. Not only has the infrastructure improved dramatically, but the atmosphere has also become far more cosmopolitan, although some residents feel that the traditional character has been somewhat diluted.", 20),
  ans("h3", "I'd say reading is something I genuinely cherish. Although I spend most of my working hours staring at screens, I deliberately set aside time for printed novels, since I find that it helps me unwind and, perhaps more importantly, sharpens my concentration.", 20),
  ans("h4", "Mornings have always been my most productive period. Even though I'm not naturally an early riser, I've trained myself to wake up before six, which gives me an uninterrupted hour to plan my priorities before the inevitable flood of emails begins.", 20),
];

test("11. diagnostics separate synthetic quality levels and NEVER emit bands", () => {
  console.log(`  [samples] reviewed=${REFERENCE_SAMPLES.reviewed} source=${REFERENCE_SAMPLES.source}`);
  const diag = (set: AnswerInput[]) => buildDiagnosticReport(set, aggregate(set));
  const lo = diag(LOW), mi = diag(MID), hi = diag(HIGH);
  // Deterministic signals still order the quality levels…
  const issues = (r: typeof lo) => r.findings.filter((f) => f.kind !== "strength").length;
  assert.ok(issues(lo) > issues(hi), `LOW (${issues(lo)}) must exceed HIGH (${issues(hi)}) diagnostics`);
  assert.ok(lo.metrics.totalWords < hi.metrics.totalWords);
  // …but no band of any kind may exist in a diagnostic report.
  for (const r of [lo, mi, hi]) {
    assert.match(r.note, /Diagnostic|不是 IELTS Band/);
    assert.ok(!/"band"\s*:/.test(JSON.stringify(r)), "diagnostic report must not contain band fields");
  }
});

test("11b. rubric itself is ordered and non-degenerate per criterion", () => {
  for (const dim of DIMS) {
    const bands = [...new Set(BAND_DESCRIPTORS.filter((d) => d.dimension === dim).map((d) => d.band))];
    assert.deepEqual(bands, [...bands].sort((a, b) => a - b), `${dim} bands must be ordered`);
    assert.equal(bands.length, 10, `${dim} must cover all 10 bands`);
    // Descriptors must differ between bands (not just reworded).
    const texts = BAND_DESCRIPTORS.filter((d) => d.dimension === dim).map((d) => d.text);
    assert.equal(new Set(texts).size, texts.length, `${dim} has duplicated descriptor text across bands`);
  }
  // Four independent criteria — never collapsed into one overall rubric.
  assert.equal(CRITERIA.length, 4);
  assert.deepEqual(CRITERIA.map((c) => c.key).sort(), ["FC", "GRA", "LR", "P"]);
  assert.ok(descriptorBrief().includes("[P] Pronunciation"));
});

// ---------------------------------------------------------- 12. structured evidence
const wt = (word: string, start: number, end: number): WordTiming => ({ word, start, end });
const indexed = (index: number, id: string, text: string, opts?: { durationMs?: number; words?: WordTiming[] }): AnswerInput & { index: number } => ({
  answerId: id, part: 2, prompt: "Q", text, durationMs: opts?.durationMs ?? 4000, index, words: opts?.words ?? null,
});

test("12a. evidence: transcript quotes verified; unknown answers and unverifiable audio dropped", () => {
  const list = [indexed(1, "a1", "I play badminton every weekend with my colleagues.")];
  const out = modelOutput({
    dimensions: {
      FC: {
        band: 6, rationale: "Keeps going.", descriptorRefs: ["FC-B6-01"],
        confidence: 0.8, strengths: ["linking is natural"], weaknesses: ["some false starts"],
        evidence: [
          { answer: 1, evidenceType: "transcript", quote: "badminton every weekend", explanation: "sustained topic" },
          { answer: 9, evidenceType: "transcript", quote: "badminton every weekend", explanation: "unknown answer" },
          { answer: 1, evidenceType: "transcript", quote: "I never said this", explanation: "fabricated quote" },
          { answer: 1, evidenceType: "audio", startMs: 500, endMs: 900, explanation: "no word timings on this answer" },
          { answer: 1, evidenceType: "metric", explanation: "aggregate wpm reference" },
        ],
      },
      LR: { band: 6, rationale: "Adequate.", descriptorRefs: ["LR-B6-01"], evidence: [] },
      GRA: { band: 6, rationale: "Mixed.", descriptorRefs: ["GRA-B6-01"], evidence: [] },
    },
    findings: [],
  });
  const { score, droppedEvidence } = validateLanguageScore(out, list);
  const ev = score.dimensions.FC.evidence ?? [];
  assert.equal(ev.length, 2, "transcript + metric survive, others dropped");
  assert.equal(droppedEvidence, 3);
  assert.equal(score.dimensions.FC.confidence, 0.8);
  assert.deepEqual(score.dimensions.FC.strengths, ["linking is natural"]);
  assert.deepEqual(score.dimensions.FC.weaknesses, ["some false starts"]);
});

test("12b. audio evidence needs REAL word timings and in-range bounds", () => {
  const list = [
    indexed(1, "a1", "One two three four five.", { durationMs: 4000, words: [wt("one", 0.5, 0.8), wt("two", 1.0, 1.3)] }),
    indexed(2, "a2", "No timings here.", { durationMs: 4000 }),
  ];
  const mk = (evidence: Record<string, unknown>[]) => modelOutput({
    dimensions: {
      FC: { band: 6, rationale: "r", descriptorRefs: ["FC-B6-01"], evidence },
      LR: { band: 6, rationale: "r", descriptorRefs: ["LR-B6-01"] },
      GRA: { band: 6, rationale: "r", descriptorRefs: ["GRA-B6-01"] },
    },
    findings: [],
  });
  const out = validateLanguageScore(mk([
    { answer: 1, evidenceType: "audio", startMs: 1000, endMs: 2500, explanation: "located pause" },
    { answer: 1, evidenceType: "audio", startMs: 6500, endMs: 7000, explanation: "beyond recording" },
    { answer: 1, evidenceType: "audio", startMs: 2000, endMs: 1500, explanation: "inverted bounds" },
    { answer: 2, evidenceType: "audio", startMs: 500, endMs: 900, explanation: "answer without word timings" },
  ]), list);
  assert.equal((out.score.dimensions.FC.evidence ?? []).length, 1, "only the word-timed, in-range clip survives");
  assert.equal(out.droppedEvidence, 3);
});

test("12c. P is judgeable only from provider evidence, with P-rubric refs", () => {
  const list = [indexed(1, "a1", "Some answer text.")];
  const pDims = {
    FC: { band: 6, rationale: "r", descriptorRefs: ["FC-B6-01"] },
    LR: { band: 6, rationale: "r", descriptorRefs: ["LR-B6-01"] },
    GRA: { band: 6, rationale: "r", descriptorRefs: ["GRA-B6-01"] },
    P: { band: 6, rationale: "clarity reduced by mispronunciations", descriptorRefs: ["P-B6-01"] },
  };
  const withP = validateLanguageScore(modelOutput({ dimensions: pDims }), list, { allowPronunciation: true });
  assert.equal(withP.score.pronunciation?.band, 6, "P accepted when provider evidence exists");
  const withoutProvider = validateLanguageScore(modelOutput({ dimensions: pDims }), list);
  assert.equal(withoutProvider.score.pronunciation ?? null, null, "P never inferred without provider evidence");
  const badRefs = validateLanguageScore(
    modelOutput({ dimensions: { ...pDims, P: { band: 6, rationale: "r", descriptorRefs: ["FC-B6-01"] } } }),
    list, { allowPronunciation: true },
  );
  assert.equal(badRefs.score.pronunciation ?? null, null, "cross-dimension refs void the P judgement");
  const pFinding = modelOutput({
    dimensions: pDims,
    findings: [{ dimension: "P", answer: 1, kind: "error", category: "stress", quote: "Some answer text.", suggestion: null, explanation: "word stress", possibleAsrError: false, descriptorRefs: ["P-B6-01"] }],
  });
  assert.equal(validateLanguageScore(pFinding, list, { allowPronunciation: true }).score.findings.length, 1);
  assert.equal(validateLanguageScore(pFinding, list).score.findings.length, 0, "P findings dropped without provider evidence");
});

test("12d. confidence outside 0–1 and empty strings are sanitized", () => {
  const list = [indexed(1, "a1", "text.")];
  const out = validateLanguageScore(modelOutput({
    dimensions: {
      FC: { band: 6, rationale: "r", descriptorRefs: ["FC-B6-01"], confidence: 4.2, strengths: ["", "  ", "real strength"], weaknesses: [] },
      LR: { band: 6, rationale: "r", descriptorRefs: ["LR-B6-01"] },
      GRA: { band: 6, rationale: "r", descriptorRefs: ["GRA-B6-01"] },
    },
    limitations: ["", "no word timings for answer #2", "no word timings for answer #2"],
  }), list);
  assert.equal(out.score.dimensions.FC.confidence, null, "out-of-range confidence is not a number");
  assert.deepEqual(out.score.dimensions.FC.strengths, ["real strength"]);
  assert.deepEqual(out.score.limitations, ["no word timings for answer #2"], "limitations deduped and capped");
});

test("12e. prompt: P required only with pronunciation evidence; part rules always present", () => {
  const noPron = buildScoringMessages(answers);
  assert.match(noPron.system, /omit the P dimension/);
  assert.doesNotMatch(noPron.system, /PRONUNCIATION EVIDENCE/);
  assert.match(noPron.system, /Part 2/);
  assert.match(noPron.system, /Part 3/);
  const withPron = buildScoringMessages(answers, null, {
    providerId: "azure-pronunciation-assessment",
    perAnswer: [{ answer: 1, accuracy: 78, fluency: 80, prosody: 70, completeness: 90, overall: 76, worstWords: [{ word: "schedule", accuracy: 42, errorType: "Mispronunciation" }] }],
  });
  assert.match(withPron.system, /PRONUNCIATION EVIDENCE/);
  assert.match(withPron.system, /"P":Criterion/);
  assert.match(withPron.user, /azure-pronunciation-assessment/);
  assert.match(withPron.user, /schedule=42/);
});
