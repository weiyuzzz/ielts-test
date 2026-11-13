import { test } from "node:test";
import assert from "node:assert/strict";
import { TtsScheduler, TTS_PRIORITY, resolveTtsConcurrency } from "../src/lib/audio/tts-scheduler";
import { classifyAudioFailure, outcomeOf } from "../src/lib/audio/audio-lifecycle";

// ------------------------------------------------------------------ 5.3 concurrency

test("tts: concurrency — local CPU Kokoro defaults to 1, GPU/remote to 2", () => {
  assert.equal(resolveTtsConcurrency("kokoro", "http://localhost:8880/v1"), 1);
  assert.equal(resolveTtsConcurrency("kokoro", "https://api.example.com/v1"), 1);
  assert.equal(resolveTtsConcurrency("gpt-4o-mini-tts", "https://api.openai.com/v1"), 2);
  assert.equal(resolveTtsConcurrency("tts-1", "https://api.openai.com/v1"), 2);
});

test("tts: concurrency — TTS_CONCURRENCY overrides within 1..4, garbage ignored", () => {
  assert.equal(resolveTtsConcurrency("kokoro", "http://localhost:8880", "3"), 3);
  assert.equal(resolveTtsConcurrency("gpt-4o-mini-tts", "https://api.openai.com", "1"), 1);
  assert.equal(resolveTtsConcurrency("kokoro", "http://localhost:8880", "0"), 1); // clamped
  assert.equal(resolveTtsConcurrency("kokoro", "http://localhost:8880", "9"), 1); // out of range → default
  assert.equal(resolveTtsConcurrency("kokoro", "http://localhost:8880", "abc"), 1);
  assert.equal(resolveTtsConcurrency("gpt-4o-mini-tts", "https://api.openai.com", ""), 2);
});

test("tts: scheduler honours setMaxParallel at runtime", async () => {
  let running = 0;
  let maxSeen = 0;
  const s = new TtsScheduler<null>({
    run: async () => {
      running++;
      maxSeen = Math.max(maxSeen, running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
      return null;
    },
    maxParallel: 1,
  });
  for (let i = 0; i < 4; i++) s.request({ text: `line-${i}`, voice: "v", model: "m" }, TTS_PRIORITY.BACKGROUND);
  await new Promise((r) => setTimeout(r, 10));
  s.setMaxParallel(3);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(maxSeen > 1, true, "concurrency rose after setMaxParallel");
  s.dispose();
});

test("tts: scheduler never runs more than maxParallel (CPU=1 case)", async () => {
  let running = 0;
  let maxSeen = 0;
  const s = new TtsScheduler<null>({
    run: async () => {
      running++;
      maxSeen = Math.max(maxSeen, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return null;
    },
    maxParallel: 1,
  });
  for (let i = 0; i < 3; i++) s.request({ text: `x-${i}`, voice: "v", model: "m" }, TTS_PRIORITY.BACKGROUND);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(maxSeen, 1, "a CPU engine must synthesise one line at a time");
  s.dispose();
});

// ------------------------------------------------------------------ 5.1 no infinite waits / dedup

test("tts: scheduler re-request dedups the same identity into ONE job", async () => {
  let runs = 0;
  const s = new TtsScheduler<string>({
    run: async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 20));
      return "clip";
    },
    maxParallel: 2,
  });
  const parts = { text: "same line", voice: "v", model: "m", act: "question", profile: "p" };
  const a = s.request(parts, TTS_PRIORITY.BACKGROUND);
  const b = s.request(parts, TTS_PRIORITY.BACKGROUND);
  const c = s.request(parts, TTS_PRIORITY.CURRENT); // promote, must not re-run
  const [ra, rb, rc] = await Promise.all([a.promise, b.promise, c.promise]);
  assert.equal(ra, "clip");
  assert.equal(rc, "clip");
  assert.equal(runs, 1, "same text+voice+model+act+profile must synthesise exactly once");
  s.dispose();
});

test("tts: failed tasks resolve null within the bounded attempt budget, never hang", async () => {
  const s = new TtsScheduler<null>({
    run: async () => null, // synthesiser keeps failing
    maxAttempts: 1,
    maxParallel: 1,
  });
  const parts = { text: "doomed", voice: "v", model: "m" };
  const t0 = Date.now();
  await s.request(parts, TTS_PRIORITY.CURRENT).promise;
  // A CURRENT re-request allows one extra attempt, but still settles fast.
  await s.request(parts, TTS_PRIORITY.CURRENT).promise;
  const elapsed = Date.now() - t0;
  assert.equal(elapsed < 5000, true, `must not hang (took ${elapsed} ms)`);
  const third = await s.request(parts, TTS_PRIORITY.BACKGROUND).promise;
  assert.equal(third, null, "exhausted failures resolve null instead of retrying forever");
  s.dispose();
});

test("tts: dispose settles every pending promise (exam exit must not hang)", async () => {
  const s = new TtsScheduler<string>({
    run: () => new Promise(() => undefined), // never settles on its own
    maxParallel: 2,
  });
  const p1 = s.request({ text: "a", voice: "v", model: "m" }, TTS_PRIORITY.CURRENT).promise;
  const p2 = s.request({ text: "b", voice: "v", model: "m" }, TTS_PRIORITY.NEXT).promise;
  const settled = await Promise.race([
    Promise.all([p1, p2]).then(() => "settled"),
    new Promise((r) => setTimeout(() => r("hang"), 300)),
  ]);
  s.dispose(); // even a mid-flight hang is released by dispose
  const settled2 = await Promise.race([
    Promise.all([p1, p2]).then(() => "settled"),
    new Promise((r) => setTimeout(() => r("hang"), 300)),
  ]);
  assert.equal(settled2, "settled", "dispose must resolve all callers with null");
  void settled;
});

// ------------------------------------------------------------------ 5.4 failure taxonomy

test("tts: classifyAudioFailure maps provider/config/transport errors", () => {
  const config = classifyAudioFailure({ error: { code: "config", message: "[openai-tts] config: missing API key" } });
  assert.equal(config.kind, "config");
  assert.equal(config.retryable, false);

  const timeout = classifyAudioFailure({ error: { code: "timeout", message: "no response within 120000ms" } });
  assert.equal(timeout.kind, "timeout");
  assert.equal(timeout.retryable, true);

  const rate = classifyAudioFailure({ error: { code: "http", message: "429 Too Many Requests" } });
  assert.equal(rate.kind, "rate_limit");
  assert.equal(rate.retryable, true);

  const conn = classifyAudioFailure({ error: { code: "http", message: "502 Bad Gateway" } });
  assert.equal(conn.kind, "connection");
  assert.equal(conn.retryable, true);

  const invalid = classifyAudioFailure({ error: { code: "invalid_response", message: "no PronunciationAssessment" } });
  assert.equal(invalid.kind, "invalid_audio");
  assert.equal(invalid.retryable, true);
});

test("tts: classifyAudioFailure maps playback outcomes and cancellation", () => {
  const cancelled = classifyAudioFailure({ outcome: outcomeOf("interrupted", "server-cache", { aborted: true }) });
  assert.equal(cancelled.kind, "cancelled");
  assert.equal(cancelled.retryable, false);

  const blocked = classifyAudioFailure({ outcome: outcomeOf("failed", "browser") });
  assert.equal(blocked.kind, "playback_blocked");
  assert.equal(blocked.retryable, false, "a browser playback failure must not re-trigger synthesis retries");

  const stream = classifyAudioFailure({ outcome: outcomeOf("failed", "stream") });
  assert.equal(stream.kind, "invalid_audio");
  assert.equal(stream.retryable, true);

  const synth = classifyAudioFailure({ outcome: outcomeOf("failed", "server-cache") });
  assert.equal(synth.kind, "connection");
  assert.equal(synth.retryable, true);
});
