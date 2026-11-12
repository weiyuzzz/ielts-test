import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig } from "../src/lib/speaking/config";
import { canSubmitAnswer, decideAdvance, canRepeat, canFinish, type MachineState, type MachineStep } from "../src/lib/speaking/exam-machine";
import { overallBand, toHalfBand, score100ToBand } from "../src/lib/speaking/bands";
import { aggregate, analyzeAnswer, type AnswerInput } from "../src/lib/speaking/metrics";
import { heuristicScore, validateLanguageScore, extractJson, ScoringValidationError, grammarRuleFindings } from "../src/lib/speaking/scoring";
import { sanitizeFollowUp } from "../src/lib/speaking/examiner";
import { withTimeout, ProviderError } from "../src/lib/ai/types";
import { pickMimeType, encodeWav, resample } from "../src/lib/audio/wav";
import { normalizeExaminerText, splitSentences, toProsodySsml, toAzureSsml, EXAMINER_TTS_INSTRUCTIONS } from "../src/lib/ai/tts-text";

// ------------------------------------------------------------- state machine
function state(mode: "full" | "part3" = "full", overrides: Partial<MachineState> = {}): MachineState {
  const steps: MachineStep[] = [
    { id: "a", stepIndex: 0, part: 1, kind: "question", status: "pending", repeatCount: 0 },
    { id: "b", stepIndex: 1, part: 2, kind: "cue_card", status: "pending", repeatCount: 0 },
    { id: "c", stepIndex: 2, part: 3, kind: "question", status: "pending", repeatCount: 0 },
    { id: "d", stepIndex: 3, part: 3, kind: "question", status: "pending", repeatCount: 0 },
  ];
  return { status: "in_progress", currentStep: 0, steps, config: resolveConfig(mode), ...overrides };
}

test("machine: only the current step accepts answers", () => {
  const s = state();
  assert.equal(canSubmitAnswer(s, "a").ok, true);
  assert.deepEqual(canSubmitAnswer(s, "b"), { ok: false, error: "not_current_step" });
  assert.deepEqual(canSubmitAnswer(s, "zzz"), { ok: false, error: "unknown_step" });
});

test("machine: full mock forbids re-answering; practice allows re-record", () => {
  const s = state();
  s.steps[0].status = "answered";
  assert.deepEqual(canSubmitAnswer(s, "a"), { ok: false, error: "already_answered" });
  const p = state("part3");
  p.steps[0].status = "answered";
  assert.deepEqual(canSubmitAnswer(p, "a"), { ok: true, value: { isRerecord: true } });
});

test("machine: cannot advance an unanswered step, or from a stale step (duplicate click)", () => {
  const s = state();
  assert.deepEqual(decideAdvance(s, 0, null, { llmAvailable: false }), { ok: false, error: "step_not_answered" });
  s.steps[0].status = "answered";
  assert.deepEqual(decideAdvance(s, 5, null, { llmAvailable: false }), { ok: false, error: "not_current_step" });
  const d = decideAdvance(s, 0, { wordCount: 30, noResponse: false }, { llmAvailable: false });
  assert.deepEqual(d, { ok: true, value: { type: "next", nextStep: 1, partChanged: true } });
});

test("machine: Part 3 short answer triggers a follow-up; silence never does; cap is enforced", () => {
  const s = state("full", { currentStep: 2 });
  s.steps.forEach((x) => (x.status = x.stepIndex <= 2 ? "answered" : "pending"));
  const short = decideAdvance(s, 2, { wordCount: 8, noResponse: false }, { llmAvailable: false });
  assert.equal(short.ok && short.value.type, "follow_up");
  const silent = decideAdvance(s, 2, { wordCount: 0, noResponse: true }, { llmAvailable: true });
  assert.equal(silent.ok && silent.value.type, "next");
  const long = decideAdvance(s, 2, { wordCount: 80, noResponse: false }, { llmAvailable: false });
  assert.equal(long.ok && long.value.type, "next", "no LLM → no probe on substantive answers");
  const probe = decideAdvance(s, 2, { wordCount: 80, noResponse: false }, { llmAvailable: true });
  assert.equal(probe.ok && probe.value.type, "follow_up");
  s.steps.push({ id: "f1", stepIndex: 9, part: 3, kind: "follow_up", status: "answered", repeatCount: 0 }, { id: "f2", stepIndex: 10, part: 3, kind: "follow_up", status: "answered", repeatCount: 0 });
  const capped = decideAdvance(s, 2, { wordCount: 5, noResponse: false }, { llmAvailable: true });
  assert.equal(capped.ok && capped.value.type, "next");
});

test("machine: Part 1/2 never get follow-ups", () => {
  const s = state();
  s.steps[0].status = "answered";
  const d = decideAdvance(s, 0, { wordCount: 2, noResponse: false }, { llmAvailable: true });
  assert.equal(d.ok && d.value.type, "next");
});

test("machine: repeat limit and finish rules", () => {
  const s = state();
  assert.equal(canRepeat(s, "a").ok, true);
  s.steps[0].repeatCount = 1;
  assert.deepEqual(canRepeat(s, "a"), { ok: false, error: "repeat_limit" });
  assert.equal(canFinish(s).ok, false);
  s.currentStep = 3;
  s.steps.forEach((x) => (x.status = "answered"));
  assert.equal(canFinish(s).ok, true);
  assert.deepEqual(canFinish({ ...s, status: "completed" }), { ok: false, error: "session_not_active" });
});

test("config: practice modes enable only one part and allow re-record", () => {
  const c = resolveConfig("part2");
  assert.equal(c.part1.enabled, false);
  assert.equal(c.part2.enabled, true);
  assert.equal(c.part3.enabled, false);
  assert.equal(c.allowRerecord, true);
  assert.equal(resolveConfig("full").allowRerecord, false);
});

// ------------------------------------------------------------- bands
test("bands: IELTS overall rounding", () => {
  assert.equal(overallBand([6, 6, 6, 6.5]), 6); // 6.125
  assert.equal(overallBand([6, 6.5, 6.5, 6]), 6.5); // 6.25 → 6.5
  assert.equal(overallBand([6.5, 6.5, 7, 7]), 7); // 6.75 → 7
  assert.equal(overallBand([7, 7, 7]), 7);
  assert.equal(overallBand([null, undefined]), null);
  assert.equal(toHalfBand(6.74), 6.5);
  assert.equal(score100ToBand(86), 8);
});

// ------------------------------------------------------------- evaluation set (graded mock answers)
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

test("evaluation set: heuristic bands are monotonic with answer quality", () => {
  const score = (set: AnswerInput[]) => heuristicScore(set, aggregate(set)).dimensions;
  const lo = score(LOW), mi = score(MID), hi = score(HIGH);
  console.log("  heuristic bands  LOW", lo.FC.band, lo.LR.band, lo.GRA.band, "| MID", mi.FC.band, mi.LR.band, mi.GRA.band, "| HIGH", hi.FC.band, hi.LR.band, hi.GRA.band);
  for (const d of ["FC", "LR", "GRA"] as const) {
    assert.ok(lo[d].band < mi[d].band, `${d}: low < mid`);
    assert.ok(mi[d].band <= hi[d].band, `${d}: mid <= high`);
    assert.ok(lo[d].band >= 2 && hi[d].band <= 9);
  }
  assert.ok(lo.FC.band <= 5, "clearly weak answers must not get a high band");
});

test("evaluation set: grammar rules catch real errors and do not flag good answers", () => {
  const low = grammarRuleFindings(LOW).map((f) => f.category);
  assert.ok(low.includes("subject-verb agreement"));
  assert.ok(low.includes("comparatives"));
  assert.ok(low.includes("negation"));
  assert.equal(grammarRuleFindings(HIGH).length, 0, "no false positives on advanced answers");
  assert.equal(grammarRuleFindings(MID).length, 0);
});

test("metrics: fillers, repetition, wpm", () => {
  const m = analyzeAnswer(ans("x", "Um, I I think, uh, it is um good you know. Um I like it.", 10));
  assert.ok(m.fillerCount >= 4);
  assert.ok(m.repetitionCount >= 1);
  assert.ok(m.wpm !== null && m.wpm > 50);
});

test("heuristic scorer never produces repeated identical findings across answers for unrelated content", () => {
  const r = heuristicScore(MID, aggregate(MID));
  const keys = r.findings.map((f) => `${f.category}|${f.originalText}`);
  assert.equal(new Set(keys).size, keys.length);
});

// ------------------------------------------------------------- LLM output validation
const idx = MID.map((a, i) => ({ ...a, index: i + 1 }));
const goodOutput = {
  dimensions: { FC: { band: 6.5, rationale: "Extended answers with some linking." }, LR: { band: 6, rationale: "Adequate range." }, GRA: { band: 6.3, rationale: "Mix of simple and complex." } },
  findings: [
    { dimension: "GRA", answer: 2, kind: "error", category: "tense", quote: "there are many new buildings", suggestion: "many new buildings have been built", explanation: "Present perfect fits change over time.", possibleAsrError: false },
    { dimension: "LR", answer: 1, kind: "strength", category: "collocation", quote: "helps me relax", suggestion: null, explanation: "Natural collocation." },
    { dimension: "LR", answer: 1, kind: "error", category: "hallucination", quote: "I adore classical symphonies", suggestion: null, explanation: "Not said." },
  ],
  summary: "Solid band 6 performance.",
  nextSteps: ["Use more precise vocabulary."],
};

test("LLM validation: accepts valid output, rounds bands, drops hallucinated quotes", () => {
  const { score, dropped } = validateLanguageScore(goodOutput, idx);
  assert.equal(score.dimensions.GRA.band, 6.5);
  assert.equal(score.findings.length, 2);
  assert.equal(dropped, 1);
  assert.equal(score.findings[0].answerId, "m2");
});

test("LLM validation: invalid JSON and missing dimensions are rejected", () => {
  assert.throws(() => extractJson("Sorry, I cannot do that."), ScoringValidationError);
  assert.throws(() => extractJson("{bad json,}"), ScoringValidationError);
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  const missing = structuredClone(goodOutput) as Record<string, unknown>;
  delete (missing.dimensions as Record<string, unknown>).LR;
  assert.throws(() => validateLanguageScore(missing, idx), /LR missing/);
  const outOfRange = structuredClone(goodOutput);
  outOfRange.dimensions.FC.band = 11;
  assert.throws(() => validateLanguageScore(outOfRange, idx), /FC/);
});

// ------------------------------------------------------------- providers / examiner
test("provider timeout aborts and raises ProviderError(timeout)", async () => {
  let aborted = false;
  await assert.rejects(
    withTimeout("slow-llm", 50, (signal) => new Promise((_, rej) => signal.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")); }))),
    (e: unknown) => e instanceof ProviderError && e.code === "timeout",
  );
  assert.equal(aborted, true);
});

test("examiner follow-up sanitizer rejects feedback, answers, non-questions", () => {
  assert.equal(sanitizeFollowUp("Why do you think older people resist new technology?"), "Why do you think older people resist new technology?");
  assert.equal(sanitizeFollowUp("Great answer! What else?"), null);
  assert.equal(sanitizeFollowUp("Tell me more."), null);
  assert.equal(sanitizeFollowUp("Your band score is 7. Why?"), null);
  assert.equal(sanitizeFollowUp("为什么?你觉得呢?"), null);
});

// ------------------------------------------------------------- audio helpers
test("MIME negotiation: Chrome → webm/opus, Safari → mp4, none → default", () => {
  const chrome = (t: string) => t.startsWith("audio/webm");
  const safari = (t: string) => t.startsWith("audio/mp4");
  assert.equal(pickMimeType(chrome), "audio/webm;codecs=opus");
  assert.equal(pickMimeType(safari), "audio/mp4;codecs=mp4a.40.2");
  assert.equal(pickMimeType(() => false), "");
  assert.equal(pickMimeType(undefined), "");
  assert.equal(pickMimeType(() => { throw new Error("x"); }), "");
});

test("WAV encoder writes a valid 16 kHz mono PCM header", () => {
  const pcm = resample(new Float32Array(48000).fill(0.5), 48000, 16000);
  assert.equal(pcm.length, 16000);
  const wav = encodeWav(pcm, 16000);
  const v = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(wav.length, 44 + 32000);
});

// ------------------------------------------------------------- examiner TTS text front-end
test("TTS text: normalisation collapses whitespace without mangling contractions", () => {
  assert.equal(normalizeExaminerText("  Hello,   I'd   like\tto ask\n a question. "), "Hello, I'd like to ask a question.");
  const curly = normalizeExaminerText("\u201cReally?\u201d ___ ");
  assert.ok(curly.startsWith('"Really?"') && !curly.includes("___") && !/\s{2,}/.test(curly));
});

test("TTS text: sentence splitting keeps terminal punctuation", () => {
  assert.deepEqual(splitSentences("Thank you. Where did you grow up? OK."), ["Thank you.", "Where did you grow up?", "OK."]);
  assert.deepEqual(splitSentences("One sentence only"), ["One sentence only"]);
  assert.deepEqual(splitSentences(""), []);
});

test("TTS text: prosody SSML inserts pauses, escapes XML, and keeps contractions readable", () => {
  const s = toProsodySsml("Thank you. Where did you grow up?");
  assert.ok(s.startsWith("<speak>") && s.endsWith("</speak>"));
  assert.equal((s.match(/<break /g) || []).length, 1, "no trailing pause after the last sentence");
  assert.ok(s.includes('<break strength="weak"/>'), "statement gets a short pause");
  assert.ok(!s.includes("&apos;"), "apostrophes are never turned into spoken entities");
  const escaped = toProsodySsml("A & B < C. I'd like to ask.");
  assert.ok(escaped.includes("A &amp; B &lt; C."));
  assert.ok(escaped.includes("I'd like to ask."));
  assert.ok(toProsodySsml("Why? Fine.").includes('<break strength="medium"/>'), "questions get a longer pause");
});

test("TTS text: Azure SSML carries voice, language and rate", () => {
  const s = toAzureSsml("Thank you. OK.", "en-GB-SoniaNeural");
  assert.ok(s.includes('xml:lang="en-GB"'));
  assert.ok(s.includes('name="en-GB-SoniaNeural"'));
  assert.ok(s.includes('rate="-4%"'));
  assert.ok(s.includes("<break "));
  assert.ok(EXAMINER_TTS_INSTRUCTIONS.length > 40);
});

// ------------------------------------------------------------------ Phase 2: VoiceProfile & speech acts
import { presetById, resolveVoiceProfile, sanitizeProfile, profileFingerprint, VOICE_PRESETS } from "../src/lib/speaking/voice-profile";
import { SPEECH_ACTS } from "../src/lib/speaking/speech-act";
import { prepareExaminerSpeech, toAzureSsmlForAct, pickEmphasisWord } from "../src/lib/ai/tts-text";

test("speech acts: closing is slower and less emphatic than a question", () => {
  const profile = presetById("azure-sonia")!;
  const q = prepareExaminerSpeech({ text: "Do you enjoy reading books?", speechAct: "question", profile });
  const c = prepareExaminerSpeech({ text: "Thank you. That is the end of the speaking test.", speechAct: "closing", profile });
  assert.ok(c.speed < q.speed, "closing speaks slightly slower");
  assert.ok(q.ssml.includes("<emphasis"), "questions may emphasise one informative word");
  assert.ok(!c.ssml.includes("<emphasis"), "closing never emphasises");
  assert.ok(SPEECH_ACTS.time_warning.sentencePauseMs >= SPEECH_ACTS.acknowledgement.sentencePauseMs);
});

test("speech acts: every act has a distinct steering instruction", () => {
  const texts = new Set(Object.values(SPEECH_ACTS).map((a) => a.instructions));
  assert.equal(texts.size, Object.keys(SPEECH_ACTS).length, "no two acts share instructions");
  for (const a of Object.values(SPEECH_ACTS)) {
    assert.ok(a.instructions.length > 60);
    assert.ok(a.speedFactor > 0.9 && a.speedFactor < 1.1, "rate changes stay subtle");
  }
});

test("emphasis picks one informative word and skips function words", () => {
  assert.equal(pickEmphasisWord("Do you enjoy reading books?"), "reading");
  assert.equal(pickEmphasisWord("Thank you."), null, "short function words are not emphasised");
  const idWord = pickEmphasisWord("Could I see your identification, please?");
  assert.ok(idWord !== null && idWord.length > 5);
});

test("Azure SSML for an act is valid XML, uses exact pause times and a real rate", () => {
  const profile = presetById("azure-sonia")!;
  const prepared = prepareExaminerSpeech({ text: "Thank you. Where did you grow up?", speechAct: "question", profile });
  const ssml = toAzureSsmlForAct(prepared, "en-GB-SoniaNeural");
  assert.ok(ssml.startsWith("<speak version="));
  assert.ok(ssml.includes('xml:lang="en-GB"'));
  assert.ok(ssml.includes('name="en-GB-SoniaNeural"'));
  assert.ok(ssml.includes('<break time="'), "uses measured break times, not guessed strengths");
  assert.ok(/rate="[+-]\d+%"/.test(ssml));
  assert.ok(!ssml.includes("mstts:express-as"), "no expressive style unless one was chosen");
  // every & must be a proper entity — an unescaped one makes Azure reject the request
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(ssml));
});

test("voice profiles: presets, provider:voice, legacy Azure and Kokoro values all resolve", () => {
  assert.equal(resolveVoiceProfile("azure-sonia").voice, "en-GB-SoniaNeural");
  assert.equal(resolveVoiceProfile("azure-ryan").provider, "azure");
  const explicit = resolveVoiceProfile("azure:en-GB-RyanNeural");
  assert.equal(explicit.provider, "azure");
  assert.equal(explicit.voice, "en-GB-RyanNeural");
  const legacyAzure = resolveVoiceProfile("en-GB-SoniaNeural");
  assert.equal(legacyAzure.provider, "azure");
  // pre-Phase-2 `examinerVoice` values were bare Kokoro voice names
  const legacyKokoro = resolveVoiceProfile("bf_emma");
  assert.equal(legacyKokoro.provider, "kokoro");
  assert.equal(legacyKokoro.voice, "bf_emma");
  assert.ok(VOICE_PRESETS.length >= 4);
});

test("voice profile fingerprint separates every parameter that changes the audio", () => {
  const base = presetById("azure-sonia")!;
  const fp = (p: typeof base, act: string, fmt = "mp3") => profileFingerprint(p, act, fmt);
  assert.notEqual(fp(base, "question"), fp(base, "greeting"), "speech act changes the key");
  assert.notEqual(fp(base, "question"), fp({ ...base, speed: 0.9 }, "question"), "speed changes the key");
  assert.notEqual(fp(base, "question"), fp({ ...base, pitch: 1 }, "question"), "pitch changes the key");
  assert.notEqual(fp(base, "question"), fp({ ...base, voice: "en-GB-RyanNeural" }, "question"), "voice changes the key");
  assert.notEqual(fp(base, "question"), fp(base, "question", "wav"), "format changes the key");
  assert.equal(fp(base, "question"), fp({ ...base }, "question"), "same profile → same key");
});

test("sanitizeProfile clamps hostile or malformed settings", () => {
  const p = sanitizeProfile({ provider: "not-a-provider", voice: "", speed: 99, pitch: -99, prosody: { sentencePauseMs: 99999 } });
  assert.ok(p.speed <= 1.4 && p.speed >= 0.6);
  assert.ok((p.pitch ?? 0) >= -2 && (p.pitch ?? 0) <= 2);
  assert.ok(p.prosody.sentencePauseMs <= 900);
  assert.equal(p.language, "en-GB");
  assert.ok(p.voice.length > 0, "never returns an empty voice");
});
