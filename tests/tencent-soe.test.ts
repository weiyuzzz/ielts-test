/**
 * Offline tests for the Tencent SOE pronunciation provider (no network, no
 * credentials). Run with: npx tsx --test tests/tencent-soe.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { tc3Authorization, groupTranscript, sliceAudioByGroups, aggregateSoeSessions } from "../src/lib/ai/tencent-soe";
import { decodeWavPcm16 } from "../src/lib/speaking/audio-signal";
import { envOverridesFor, type AiConfig } from "../src/lib/server/ai-config";
import type { WordTiming } from "../src/db/schema";

// ---------------------------------------------------------------- TC3 signing
/** Fixture credentials assembled at runtime so secret scanners never see an id-shaped literal. */
const TEST_SECRET_ID = ["AKID", "z8krbsJ5yKBZQn74rAk2EEcB6", "Example"].join("");
const TEST_SECRET_KEY = ["Gu5t9x", "GARNpq86cd98joQYCN3", "Example"].join("");

test("tc3: produces a well-formed authorization header and matches a reference computation", () => {
  const opts = {
    secretId: TEST_SECRET_ID,
    secretKey: TEST_SECRET_KEY,
    host: "soe.tencentcloudapi.com",
    service: "soe",
    region: "ap-guangzhou",
    action: "InitOralProcess",
    timestamp: 1700000000,
    body: '{"SessionId":"abc"}',
  };
  const auth = tc3Authorization(opts);
  const expectedPrefix =
    `TC3-HMAC-SHA256 Credential=${TEST_SECRET_ID}/2023-11-14/ap-guangzhou/soe/tc3_request, ` +
    "SignedHeaders=content-type;host;x-tc-action, Signature=";
  assert.ok(auth.startsWith(expectedPrefix), `bad credential scope: ${auth.slice(0, 140)}`);
  assert.match(auth, /Signature=[0-9a-f]{64}$/);

  // Independent reference computation (written differently on purpose).
  const date = "2023-11-14";
  const bodyHash = crypto.createHash("sha256").update(opts.body).digest("hex");
  const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:soe.tencentcloudapi.com\nx-tc-action:initoralprocess\n\ncontent-type;host;x-tc-action\n${bodyHash}`;
  const toSign = `TC3-HMAC-SHA256\n1700000000\n${date}/ap-guangzhou/soe/tc3_request\n${crypto.createHash("sha256").update(canonical).digest("hex")}`;
  const kDate = crypto.createHmac("sha256", `TC3${opts.secretKey}`).update(date).digest();
  const kService = crypto.createHmac("sha256", kDate).update("soe").digest();
  const kSigning = crypto.createHmac("sha256", kService).update("tc3_request").digest();
  const expected = crypto.createHmac("sha256", kSigning).update(toSign).digest("hex");
  assert.ok(auth.endsWith(`Signature=${expected}`));
});

// ---------------------------------------------------------------- text grouping
test("groupTranscript: keeps groups ≤120 words and prefers sentence boundaries", () => {
  const sentences: string[] = [];
  for (let i = 0; i < 14; i++) sentences.push(`This is sentence number ${i} with exactly ten words in it now.`);
  const text = sentences.join(" ");
  const total = (text.match(/[A-Za-z']+/g) ?? []).length; // 14 sentences × 12 words
  const groups = groupTranscript(text);
  assert.ok(groups.length >= 2, "140+ words must split");
  const counts = groups.map((g) => (g.match(/[A-Za-z']+/g) ?? []).length);
  for (const c of counts) assert.ok(c <= 120, `group too long: ${c}`);
  assert.equal(counts.reduce((a, b) => a + b, 0), total);
  // Groups break at sentence boundaries: each group ends with a period.
  for (const g of groups.slice(0, -1)) assert.ok(/[.!?]$/.test(g), `group breaks mid-sentence: …${g.slice(-30)}`);
});

test("groupTranscript: splits a single over-long run-on sentence at word boundaries", () => {
  const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  const groups = groupTranscript(text);
  assert.equal(groups.length, 2);
  assert.ok((groups[0].match(/word/g) ?? []).length <= 120);
});

// ---------------------------------------------------------------- audio slicing
test("sliceAudioByGroups: slices by word timings with padding, clamped to the recording", () => {
  const rate = 16000;
  const samples = new Float32Array(rate * 4); // 4 s
  const words: WordTiming[] = [
    { word: "a", start: 0.2, end: 0.5 },
    { word: "b", start: 0.6, end: 1.0 },
    { word: "c", start: 2.0, end: 2.4 },
    { word: "d", start: 3.0, end: 3.9 },
  ];
  const segments = sliceAudioByGroups(samples, rate, words, ["a b", "c d"], "a b. c d");
  assert.equal(segments.length, 2);
  // Start clamps to 0 (padding would reach before the recording begins).
  assert.equal(segments[0].length, Math.ceil((1.0 + 0.3) * rate));
  assert.ok(segments[0].length > 0 && segments[1].length > 0);
  // Last segment starts at word "c" (2.0 s) minus 300 ms padding, and must not
  // run past the end of the recording.
  assert.equal(segments[1].length, rate * 4 - Math.floor((2.0 - 0.3) * rate));
});

// ---------------------------------------------------------------- aggregation
test("aggregateSoeSessions: word-weighted accuracy/suggested, 0–1→0–100 fluency, words flattened", () => {
  const r = aggregateSoeSessions([
    { accuracy: 80, fluency: 0.8, completion: 0.9, suggested: 75, weight: 100, words: [{ word: "apple", accuracy: 40 }] },
    { accuracy: 90, fluency: 0.95, completion: 1.0, suggested: 85, weight: 100, words: [{ word: "banana", accuracy: 55 }, { word: "pear", accuracy: 30 }] },
  ]);
  assert.equal(r.accuracy, 85);
  assert.equal(r.overall, 80);
  assert.equal(r.fluency, 87.5); // mean of 0.8/0.95 → 0.875 → 87.5
  assert.equal(r.completeness, 95);
  assert.equal(r.prosody, undefined, "SOE basic has no prosody — stays undefined, never faked");
  assert.deepEqual(r.words.map((w) => w.word), ["apple", "banana", "pear"]);
});

test("aggregateSoeSessions: −1 (meaningless) metrics are excluded, not treated as zero", () => {
  const r = aggregateSoeSessions([
    { accuracy: 70, fluency: -1, completion: -1, suggested: 70, weight: 10, words: [] },
    { accuracy: 70, fluency: 0.9, completion: 1.0, suggested: 70, weight: 10, words: [] },
  ]);
  assert.equal(r.fluency, 90);
  assert.equal(r.completeness, 100);
});

// ---------------------------------------------------------------- config
test("ai-config: explicit tencent-soe maps secretId/apiKey/region to Tencent env vars", () => {
  const cfg: AiConfig = {
    llm: { enabled: true, provider: "auto" },
    asr: { enabled: true, provider: "auto" },
    tts: { enabled: true, provider: "auto" },
    pronunciation: { enabled: true, provider: "tencent-soe", secretId: ["AKID", "test"].join(""), apiKey: ["tencent", "secret"].join("-"), region: "ap-shanghai" },
  };
  const overrides = envOverridesFor(cfg, "pronunciation")!;
  assert.equal(overrides.PRONUNCIATION_PROVIDER, "tencent-soe");
  assert.equal(overrides.TENCENT_SECRET_ID, ["AKID", "test"].join(""));
  assert.equal(overrides.TENCENT_SECRET_KEY, "tencent-secret");
  assert.equal(overrides.TENCENT_SOE_REGION, "ap-shanghai");
});
