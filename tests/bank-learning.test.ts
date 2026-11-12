/**
 * Phase 3 — question learning content & shadowing.
 *
 * Run with: npx tsx --test tests/bank-learning.test.ts
 *
 * Scope note: cases 1–3 and 5–13 are pure logic (no database, no browser).
 * Case 4 exercises the real `importBank()` twice against DATABASE_URL and is
 * skipped when no database is configured — idempotency is a property of the
 * import transaction, so faking it would test nothing.
 *
 * What CANNOT be verified here: real microphone capture, the level meter, the
 * <audio> element, ASR accuracy and the visual layout. Those need a browser and
 * are listed as unverified in docs/phase3-question-learning.md.
 */
import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseBank, deriveImportPlan, BankImportError, type BankJson } from "../src/lib/content/bank-import";
import {
  checkAudioUrl, canonicalVoiceId, contentKey, sanitizeLearning, splitParagraphs,
} from "../src/lib/content/validate";
import { buildIndex, attachLearning, computeCoverage, parseSeasonFile } from "../src/lib/content/store";
import { decideExaminerAudio, decideFollowAudio, audioFields, audioCoverage } from "../src/lib/content/audio-policy";
import { projectExamStep, learningKeysPresent, EXAM_STEP_KEYS, type ExamStepRow } from "../src/lib/content/projection";
import { diffWords, speechStats, practiceHints } from "../src/lib/content/diff";
import {
  INITIAL_SHADOWING, reduceShadowing, canReplay, canTranscribe, createTakeStore, type ShadowingTake,
} from "../src/lib/content/shadowing";
import type { FollowAudioRef, QuestionLearningContent } from "../src/lib/content/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --------------------------------------------------------------- fixtures
function bank(overrides: Partial<BankJson> = {}): BankJson {
  return {
    season: "2027-01-04",
    region: "大陆地区",
    topics: [
      {
        key: "hometown",
        name: "Hometown",
        type: "evergreen",
        part1: [{ text: "Where is your hometown?" }, { text: "Is it a big city?" }],
        part2: [{ text: "Describe your hometown", cuePoints: ["Where it is", "What it is famous for"] }],
        part3: [{ text: "Why do people move away from small towns?" }],
      },
    ],
    ...overrides,
  };
}

const followRef: FollowAudioRef = {
  url: "https://cdn.example.com/learning/hometown-p1.mp3",
  voiceProfile: "azure-sonia",
  source: { kind: "team", label: "内部录制" },
};

const fullLearning: QuestionLearningContent = {
  sampleAnswer: {
    paragraphs: ["My hometown is a small city near the coast.", "It is famous for seafood."],
    source: { kind: "team", label: "内部内容组" },
    reviewStatus: "reviewed",
  },
  ideaNotes: [
    { stage: "main-idea", text: "Say where it is.", textZh: "先说位置。" },
    { stage: "example", text: "Mention the seafood market." },
  ],
  keyPhrases: [
    { phrase: "be known for", zh: "以……闻名", example: "It is known for its seafood.", usage: "描述特色" },
  ],
  followAudio: followRef,
};

function withLearning(): BankJson {
  const b = bank();
  b.topics[0].part1 = [
    { text: "Where is your hometown?", learning: fullLearning },
    { text: "Is it a big city?" },
  ];
  return b;
}

// ------------------------------------------------- 1. legacy bank, no content
test("1. a bank without learningContent imports exactly as before", () => {
  const parsed = parseBank(bank());
  assert.equal(parsed.warnings.length, 0);
  const plan = deriveImportPlan(parsed, 42);
  assert.equal(plan.rows.length, 4);
  assert.deepEqual(plan.counts, { part1: 2, part2: 1, part3: 1 });
  assert.equal(plan.learning.length, 0, "no content entries are invented");
  assert.equal(plan.rows[0].questionAudioUrl, null);
  assert.equal(plan.rows[0].questionVoiceProfile, null);
  // Question text is never rewritten by the learning layer.
  assert.equal(plan.rows[0].text, "Where is your hometown?");
});

// ------------------------------------------------------- 2. full content
test("2. complete learning content is imported and normalised", () => {
  const parsed = parseBank(withLearning());
  const plan = deriveImportPlan(parsed, 42);
  assert.equal(plan.learning.length, 1);
  assert.equal(plan.rows.length, 4, "content does not add or remove questions");
  const entry = plan.learning[0];
  assert.equal(entry.part, 1);
  assert.equal(entry.topicKey, "hometown");
  assert.equal(entry.learning.sampleAnswer?.paragraphs.length, 2);
  assert.equal(entry.learning.sampleAnswer?.reviewStatus, "reviewed");
  assert.equal(entry.learning.sampleAnswer?.source.kind, "team");
  assert.equal(entry.learning.ideaNotes?.length, 2);
  assert.equal(entry.learning.keyPhrases?.[0].phrase, "be known for");
  assert.equal(entry.learning.followAudio?.voiceProfile, "azure-sonia");
});

// --------------------------------------------------- 3. partial / malformed
test("3. partial content and empty values do not break the import", () => {
  const partial = bank();
  partial.topics[0].part1 = [
    { text: "Where is your hometown?", learning: { keyPhrases: [{ phrase: "be based in", zh: "位于", example: "We are based in Shanghai." }] } },
    { text: "Is it a big city?", learning: { ideaNotes: [{ stage: "reason", text: "Because of work." }] } },
    { text: "Do you like it?", learning: {} },
    { text: "Is it noisy?", learning: { sampleAnswer: { paragraphs: [] } as never } },
  ];
  const parsed = parseBank(partial);
  const plan = deriveImportPlan(parsed, 1);
  assert.equal(plan.rows.length, 6, "all questions are still imported (4 P1 + 1 P2 + 1 P3)");
  // Only the two entries with usable content survive; empty ones are dropped.
  assert.equal(plan.learning.length, 2);
  assert.ok(parsed.warnings.some((w) => w.includes("sampleAnswer dropped")));

  const sanitized = sanitizeLearning({ keyPhrases: [{ phrase: "  " }], ideaNotes: "nope" });
  assert.equal(sanitized.learning.keyPhrases?.length, 0);
  assert.equal(sanitized.learning.ideaNotes?.length, 0);
  assert.equal(sanitized.learning.sampleAnswer, null);
});

// ----------------------------------------------------- 4. idempotent import
test("4. importing the same season twice is idempotent (real database)", async (t) => {
  if (!process.env.DATABASE_URL) {
    t.skip("DATABASE_URL not set");
    return;
  }
  const { importBank } = await import("../src/lib/server/bank-service");
  const { db } = await import("../src/db");
  const { questionSets, questions } = await import("../src/db/schema");
  const { count, eq } = await import("drizzle-orm");

  const season = "2099-01-01-idempotency";
  const fixture = withLearning();
  fixture.season = season;
  const sidecar = path.join(ROOT, "src/data/learning", `${season}.json`);
  try {
    const first = await importBank(fixture, false);
    const second = await importBank(fixture, false);
    assert.deepEqual(first.counts, second.counts);
    assert.equal(second.counts.part1, 2);

    const sets = await db.select().from(questionSets).where(eq(questionSets.season, season));
    assert.equal(sets.length, 1, "re-import replaces instead of duplicating");
    const [{ n }] = await db.select({ n: count() }).from(questions).where(eq(questions.setId, second.id));
    assert.equal(Number(n), 4);
    assert.equal(sets[0].isActive, false, "an unactivated import must not steal the active slot");

    // The sidecar content file is written idempotently too (one entry, not two).
    const raw = JSON.parse(await readFile(sidecar, "utf8"));
    assert.equal(raw.entries.length, 1);
    assert.equal(raw.entries[0].learning.keyPhrases.length, 1);
  } finally {
    await db.delete(questionSets).where(eq(questionSets.season, season)).catch(() => {});
    await unlink(sidecar).catch(() => {});
  }
});

// --------------------------------------------------- 5. examiner audio import
test("5. pre-recorded examiner audio fields are imported verbatim", () => {
  const b = bank();
  b.topics[0].part1 = [{
    text: "Where is your hometown?",
    questionAudioUrl: "https://cdn.example.com/examiner/q-001.mp3",
    questionVoiceProfile: "azure-sonia",
  }];
  const plan = deriveImportPlan(parseBank(b), 7);
  assert.equal(plan.rows[0].questionAudioUrl, "https://cdn.example.com/examiner/q-001.mp3");
  assert.equal(plan.rows[0].questionVoiceProfile, "azure-sonia");
  assert.equal(plan.learning.length, 0, "an examiner clip is not learning material");
});

// ------------------------------------------------ 6. voice identity mismatch
test("6. a clip recorded with another voice never replaces the examiner", () => {
  const asset = { url: "https://cdn.example.com/q.mp3", voiceProfile: "azure-ryan" };
  const mismatch = decideExaminerAudio(asset, "azure-sonia");
  assert.equal(mismatch.source, "tts");
  assert.equal(mismatch.status, "voice-mismatch");

  const match = decideExaminerAudio(asset, "azure-ryan");
  assert.equal(match.source, "preset");
  assert.equal(match.url, "https://cdn.example.com/q.mp3");

  // Same voice, different spelling → still refused at runtime (which compares
  // raw ids) but reported as fixable by relabelling.
  const relabel = decideExaminerAudio(
    { url: "https://cdn.example.com/q.mp3", voiceProfile: "azure:en-GB-SoniaNeural" },
    "azure-sonia",
  );
  assert.equal(relabel.source, "tts");
  assert.equal(relabel.equivalentVoice, true);

  // Unlabelled clips are never trusted.
  assert.equal(decideExaminerAudio({ url: "https://cdn.example.com/q.mp3", voiceProfile: null }, "azure-sonia").status, "unlabelled");

  const coverage = audioCoverage(
    [asset, { url: null, voiceProfile: null }, { url: "https://cdn.example.com/b.mp3", voiceProfile: "azure-sonia" }],
    "azure-sonia",
  );
  assert.equal(coverage.total, 3);
  assert.equal(coverage.ready, 1);
  assert.equal(coverage.voiceMismatch, 1);
  assert.equal(coverage.missing, 1);
  assert.equal(coverage.coveragePercent, 33.3);
});

// ------------------------------------------------- 7. non-HTTPS is rejected
test("7. external non-HTTPS audio URLs are rejected", () => {
  assert.equal(checkAudioUrl("http://cdn.example.com/q.mp3").ok, false);
  assert.equal(checkAudioUrl("ftp://cdn.example.com/q.mp3").ok, false);
  assert.equal(checkAudioUrl("javascript:alert(1)").ok, false);
  assert.equal(checkAudioUrl("data:audio/mp3;base64,AAAA").ok, false);
  assert.equal(checkAudioUrl("/local/q.mp3").ok, false, "must be absolute");
  assert.equal(checkAudioUrl("https://user:pass@cdn.example.com/q.mp3").ok, false);
  assert.equal(checkAudioUrl("http://localhost:3000/q.mp3").ok, true, "loopback allowed for local dev");

  const b = bank();
  b.topics[0].part1 = [{
    text: "Where is your hometown?",
    questionAudioUrl: "http://cdn.example.com/q.mp3",
    questionVoiceProfile: "azure-sonia",
  }];
  assert.throws(
    () => parseBank(b),
    (e: unknown) => e instanceof BankImportError && e.status === 400 && e.code === "invalid_audio_url",
  );

  // A bank that points at a clip but cannot name its voice is refused too.
  b.topics[0].part1 = [{ text: "Where is your hometown?", questionAudioUrl: "https://cdn.example.com/q.mp3" }];
  assert.throws(() => parseBank(b), (e: unknown) => e instanceof BankImportError && e.code === "unlabelled_audio");

  // A voice we cannot resolve must not be accepted as the examiner.
  b.topics[0].part1 = [{
    text: "Where is your hometown?",
    questionAudioUrl: "https://cdn.example.com/q.mp3",
    questionVoiceProfile: "some-random-voice",
  }];
  assert.throws(() => parseBank(b), (e: unknown) => e instanceof BankImportError && e.code === "invalid_voice_profile");
});

// ------------------------------------- 8. follow audio ≠ examiner audio
test("8. follow audio and examiner audio never mix", () => {
  const parsed = parseBank(withLearning());
  const plan = deriveImportPlan(parsed, 1);
  const followUrl = followRef.url;

  assert.equal(plan.learning[0].learning.followAudio?.url, followUrl);
  assert.equal(plan.rows[0].questionAudioUrl, null, "follow audio must not become examiner audio");

  const fields = audioFields({
    questionAudioUrl: "https://cdn.example.com/examiner.mp3",
    learning: fullLearning,
  });
  assert.equal(fields.examiner, "https://cdn.example.com/examiner.mp3");
  assert.equal(fields.follow, followUrl);
  assert.notEqual(fields.examiner, fields.follow);

  const follow = decideFollowAudio(followRef);
  assert.equal(follow.playable, true);
  assert.equal(follow.usableInExam, false, "study audio is never exam audio");
  // A follow clip needs no exam-voice match, but it does need a named voice.
  assert.equal(decideFollowAudio({ ...followRef, voiceProfile: "unknown-voice" }).playable, false);
  assert.equal(decideFollowAudio({ ...followRef, url: "http://cdn.example.com/a.mp3" }).playable, false);
});

// ------------------------------------------- 9. full mock has no study data
test("9. a full mock step never carries learning material", () => {
  const row: ExamStepRow & { learning: unknown; sampleAnswer: unknown } = {
    id: "11111111-1111-1111-1111-111111111111",
    stepIndex: 0, part: 1, kind: "question", topic: "Hometown",
    examinerLead: "", promptText: "Where is your hometown?", cuePoints: null,
    generator: "bank", prepSeconds: 0, answerSeconds: 40, status: "pending", repeatCount: 0,
    questionId: 123,
    // Deliberately smuggled in — the projection must drop it.
    learning: fullLearning,
    sampleAnswer: fullLearning.sampleAnswer,
  };
  const view = projectExamStep(row, { url: null, profile: null }, null);
  assert.deepEqual(learningKeysPresent(view), []);
  assert.deepEqual(Object.keys(view).sort(), [...EXAM_STEP_KEYS].sort());
  assert.equal(view.promptText, "Where is your hometown?");
});

// ------------------------------------------ 10. the study page sees it all
test("10. the learning page receives complete content", () => {
  const file = {
    version: 1,
    season: "2027-01-04",
    entries: [{ topicKey: "hometown", part: 1, text: "Where is your hometown?", learning: fullLearning }],
  };
  const parsed = parseSeasonFile(file);
  assert.deepEqual(parsed.warnings, []);
  const index = buildIndex(parsed.file!.entries);
  const rows = [{ part: 1, topicKey: "hometown", text: "Where is your hometown?" }];
  const [question] = attachLearning(rows, index);
  assert.equal(question.learning.sampleAnswer?.paragraphs.length, 2);
  assert.equal(question.learning.ideaNotes?.length, 2);
  assert.equal(question.learning.keyPhrases?.length, 1);
  assert.ok(question.learning.followAudio?.url);

  const coverage = computeCoverage(rows, index);
  assert.equal(coverage.withSampleAnswer, 1);
  assert.equal(coverage.withFollowAudio, 1);
  assert.equal(coverage.sampleAnswerPercent, 100);

  // Matching is by normalised text, not by row id (ids change on re-import).
  const same = attachLearning([{ part: 1, topicKey: "Hometown", text: "  where is your hometown  " }], index);
  assert.ok(same[0].learning.sampleAnswer);
  assert.equal(contentKey(1, "hometown", "Where is your hometown?"), contentKey(1, "hometown", "where is your hometown"));
});

// --------------------------------------- 11. shadowing without any ASR
test("11. shadowing still records and replays when ASR is missing", () => {
  const take: ShadowingTake = {
    id: "take-1", durationMs: 12000, mimeType: "audio/webm",
    objectUrl: "blob:local/take-1", hasWav: true,
  };
  let s = reduceShadowing(INITIAL_SHADOWING, { type: "start-recording" });
  assert.equal(s.takeStatus, "recording");
  s = reduceShadowing(s, { type: "take-ready", take });
  assert.equal(s.takeStatus, "recorded");
  assert.equal(canReplay(s), true);

  s = reduceShadowing(s, { type: "transcribe" });
  assert.equal(s.transcript.status, "pending");
  s = reduceShadowing(s, { type: "asr-unavailable", reason: "未配置服务端语音识别" });
  assert.equal(s.transcript.status, "unavailable");
  assert.equal(canReplay(s), true, "the take survives a missing provider");
  assert.equal(s.take?.durationMs, 12000);
  assert.equal(canTranscribe(s, false), false);
});

// ------------------------- 12. practice takes are not exam answer records
test("12. a shadowing take can never become an exam answer record", async () => {
  const files = [
    "src/lib/content/shadowing.ts",
    "src/lib/content/playback.ts",
    "src/app/api/learning/asr/route.ts",
    "src/app/api/learning/questions/route.ts",
    "src/app/speaking/practice/shadowing-studio.tsx",
    "src/app/speaking/practice/page.tsx",
  ];
  // Comments are stripped first: the modules *document* that they never touch
  // answer records, and that sentence must not fail the check about code.
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
  for (const rel of files) {
    const src = stripComments(await readFile(path.join(ROOT, rel), "utf8"));
    assert.ok(!/from\s+["']@\/db["']/.test(src), `${rel} must not import the database`);
    assert.ok(!/answer_records|answerRecords/.test(src), `${rel} must not reference answer records`);
  }

  const store = createTakeStore();
  assert.equal(store.persistence, "session-memory");
  const take: ShadowingTake = {
    id: "t1", durationMs: 5000, mimeType: "audio/webm", objectUrl: "blob:1", hasWav: false,
  };
  store.put("1|hometown|q", take);
  assert.equal(store.list("1|hometown|q").length, 1);
  assert.deepEqual(Object.keys(take).sort(), ["durationMs", "hasWav", "id", "mimeType", "objectUrl"]);
  assert.ok(!("answerId" in take) && !("sessionId" in take));
});

// ---------------------------------------- 13. ASR failure degrades gracefully
test("13. an ASR failure never breaks the page or loses the recording", () => {
  const take: ShadowingTake = { id: "t2", durationMs: 8000, mimeType: "audio/wav", objectUrl: "blob:2", hasWav: true };
  let s = reduceShadowing(INITIAL_SHADOWING, { type: "take-ready", take });
  s = reduceShadowing(s, { type: "transcribe" });
  s = reduceShadowing(s, { type: "asr-failed", error: "provider timeout" });
  assert.equal(s.transcript.status, "failed");
  assert.equal(s.transcript.reason, "provider timeout");
  assert.equal(canReplay(s), true);
  assert.equal(canTranscribe(s, true), true, "retry is allowed");

  // A successful retry replaces the error.
  s = reduceShadowing(s, { type: "transcribe" });
  s = reduceShadowing(s, { type: "transcribed", text: "my hometown is small", provider: "openai-whisper" });
  assert.equal(s.transcript.status, "ok");

  // A new take invalidates the old transcript but keeps the UI usable.
  s = reduceShadowing(s, { type: "start-recording" });
  assert.equal(s.transcript.status, "idle");
});

// ---------------------------------------------------------- diff behaviour
test("diff: differences are reported as reference information only", () => {
  const d = diffWords("I live in a small city near the sea", "I live in a city near sea");
  assert.deepEqual(d.missing, ["small", "the"]);
  assert.equal(d.matched, 7);
  assert.equal(d.refWords, 9);
  assert.ok(Math.abs(d.matchRate - 7 / 9) < 0.001);
  assert.equal(practiceHints(d, speechStats("I live in a city near sea", 60000)).length, 1);

  const perfect = diffWords("I live here", "I live here");
  assert.equal(perfect.missing.length, 0);
  assert.equal(practiceHints(perfect, speechStats("I live here", 4000)).length, 1);

  const sub = diffWords("The market was crowded", "The market was busy");
  assert.deepEqual(sub.changed, [{ ref: "crowded", got: "busy" }]);

  const stats = speechStats("one two three four five six", 3000);
  assert.equal(stats.words, 6);
  assert.equal(stats.wpm, 120);
  // No score, no band, no phoneme claim anywhere in the output.
  assert.deepEqual(Object.keys(stats).sort(), ["durationMs", "words", "wpm"]);

  assert.deepEqual(splitParagraphs("One. Two. Three."), ["One. Two.", "Three."]);
  assert.equal(canonicalVoiceId("en-GB-SoniaNeural"), "azure:en-GB-SoniaNeural");
  assert.equal(canonicalVoiceId("azure-sonia"), "azure:en-GB-SoniaNeural");
  assert.equal(canonicalVoiceId("totally-made-up"), null);
});
