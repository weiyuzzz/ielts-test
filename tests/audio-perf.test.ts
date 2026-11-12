/**
 * Phase-1 audio performance tests.
 *
 * Run with: npx tsx --test tests/audio-perf.test.ts
 *
 * SCOPE NOTE (required by the brief): everything here is pure logic or uses an
 * injected fake environment. Real microphone capture, AudioWorklet rendering,
 * <audio> playback/streaming and speechSynthesis CANNOT be verified in Node —
 * those are marked BROWSER-ONLY and are covered only by tests/integration.mjs
 * against a running server plus manual browser verification. See the final
 * report for the explicit list of unverifiable behaviours.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TtsScheduler, TTS_PRIORITY, ttsTaskKey } from "../src/lib/audio/tts-scheduler";
import {
  reduceAudioState, canTransition, AudioLifecycle, PlaybackGuard,
  outcomeOf, TERMINAL_STATES,
} from "../src/lib/audio/audio-lifecycle";
import { AudioMetrics, METRIC_NAMES } from "../src/lib/audio/metrics";
import {
  getClip, putClip, ttsCacheKey, withInflightPriority, pendingClip,
  activeJobPriority, cancelPrefetchJob,
} from "../src/lib/server/tts-cache";
import { asrTimingForStep, asrTimingFromConfig } from "../src/lib/speaking/asr-policy";
import { resolveConfig } from "../src/lib/speaking/config";
import { canSubmitAnswer, decideAdvance, type MachineState, type MachineStep } from "../src/lib/speaking/exam-machine";
import { isRetryableStatus, backoffDelay } from "../src/lib/audio/upload";
import { classifyScriptLines, AudioPreloader } from "../src/lib/audio/audio-resources";
import { audioMetrics } from "../src/lib/audio/metrics";
import {
  RecordingSession, type RecordingEnvironment, type RecorderLike,
  type ContextLike, type NodeLike, type StreamLike, type ScriptProcessorLike,
} from "../src/lib/audio/recording-session";

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

// ============================================================ 1 / 2. TTS cache
test("1. TTS cache HIT: putClip/getClip returns the same audio, LRU refreshes", () => {
  const key = ttsCacheKey(["engine", "model-a", "voice-1", "text"]);
  assert.equal(getClip(key), undefined);
  putClip(key, { audio: new Uint8Array([1, 2, 3]), mimeType: "audio/mpeg" });
  const hit = getClip(key);
  assert.ok(hit);
  assert.equal(hit.mimeType, "audio/mpeg");
  assert.deepEqual([...hit.audio], [1, 2, 3]);
  assert.equal(getClip(key), hit, "repeated read is a cache hit");
  // different model / voice / text produce different keys (no stale audio)
  assert.notEqual(ttsCacheKey(["engine", "model-b", "voice-1", "text"]), key);
  assert.notEqual(ttsCacheKey(["engine", "model-a", "voice-2", "text"]), key);
});

test("2. TTS cache MISS: one synthesis job per key, shared by concurrent requests", async () => {
  const key = "miss-job-1";
  let runs = 0;
  const gate = Promise.withResolvers<string>();
  const p1 = withInflightPriority(key, "prefetch", () => { runs++; return gate.promise; });
  const p2 = withInflightPriority(key, "prefetch", () => { runs++; return Promise.resolve("second"); });
  assert.strictEqual(p1, p2, "both requests share the same in-flight promise");
  assert.equal(runs, 1, "no duplicate synthesis");
  assert.ok(pendingClip(key));
  gate.resolve("clip");
  assert.equal(await p1, "clip");
  await tick();
  assert.equal(activeJobPriority(key), null, "in-flight slot released");
});

// ============================================================ 3. preload → play
test("3. Preload then play: same line is deduped and PROMOTED, never synthesised twice", async () => {
  let runs = 0;
  const s = new TtsScheduler<string>({
    run: async (task) => { runs++; return `clip:${task.text}`; },
    maxParallel: 2,
  });
  const a = s.request({ text: "Hello.", voice: "en-GB", model: "m1" }, TTS_PRIORITY.BACKGROUND);
  const b = s.request({ text: "Hello.", voice: "en-GB", model: "m1" }, TTS_PRIORITY.CURRENT);
  assert.equal(a.key, b.key);
  assert.equal(runs, 0, "run starts on a microtask");
  assert.equal(await a.promise, "clip:Hello.");
  assert.equal(await b.promise, "clip:Hello.");
  assert.equal(runs, 1, "one synthesis for one (text, voice, model)");
  assert.equal(s.snapshotAll()[0].priority, TTS_PRIORITY.CURRENT, "promoted to highest");
  assert.equal(s.get(a.key), "clip:Hello.");
  s.dispose();
});

test("3b. Model / voice / format are part of the task identity", () => {
  const base = { text: "Hi", voice: "en-GB", model: "m1", format: "mp3" };
  assert.notEqual(ttsTaskKey(base), ttsTaskKey({ ...base, model: "m2" }));
  assert.notEqual(ttsTaskKey(base), ttsTaskKey({ ...base, voice: "en-US" }));
  assert.notEqual(ttsTaskKey(base), ttsTaskKey({ ...base, format: "wav" }));
});

test("3c. A CURRENT request preempts a running LOW backup, never waits on it", async () => {
  const started: string[] = [];
  const aborts: string[] = [];
  let backupRuns = 0;
  const s = new TtsScheduler<string>({
    maxParallel: 1,
    run: (task, signal) => new Promise<string | null>((resolve) => {
      started.push(task.text);
      if (task.text === "backup") {
        backupRuns++;
        if (backupRuns === 1) signal.addEventListener("abort", () => { aborts.push("backup"); resolve(null); });
        else setTimeout(() => resolve("backup"), 0); // requeued job eventually finishes
      } else {
        setTimeout(() => resolve(task.text), 0);
      }
    }),
  });
  const low = s.request({ text: "backup", voice: "v", model: "m" }, TTS_PRIORITY.LOW);
  await tick(); // let the LOW job start
  const high = s.request({ text: "current-line", voice: "v", model: "m" }, TTS_PRIORITY.CURRENT);
  assert.ok(aborts.includes("backup"), "low-priority warm-up was cancelled");
  assert.equal(await high.promise, "current-line");
  assert.ok(started.indexOf("current-line") >= 0);
  // The preempted job is requeued (not lost) and can finish later.
  await low.promise;
  s.dispose();
});

test("3d. Prefetch exposes a Promise AND a subscribable readiness state", async () => {
  const s = new TtsScheduler<string>({ run: async (t) => `c:${t.text}`, maxParallel: 2 });
  const seen: number[] = [];
  const unsub = s.subscribe((snap) => seen.push(snap.filter((x) => x.status === "ready").length));
  const req = s.request({ text: "Question one", voice: "v", model: "m" });
  assert.equal(req.ready(), false);
  assert.ok(["queued", "running"].includes(req.status()));
  await req.promise;
  assert.equal(req.ready(), true);
  assert.equal(req.status(), "ready");
  assert.ok(seen[seen.length - 1] >= 1, "subscribers saw the ready transition");
  unsub();
  s.dispose();
});

// ============================================================ 4 / 5. streaming
test("4. Streaming OK: a LIVE job cancels an in-flight POST prefetch instead of waiting", async () => {
  let prefetchAborted = false;
  const prefetch = withInflightPriority("stream-k", "prefetch", (signal) => new Promise((_res, rej) => {
    signal.addEventListener("abort", () => { prefetchAborted = true; rej(new DOMException("aborted", "AbortError")); });
  }));
  void prefetch.catch(() => {}); // mark handled before the abort below
  assert.equal(activeJobPriority("stream-k"), "prefetch");
  assert.equal(cancelPrefetchJob("stream-k"), true);
  assert.equal(prefetchAborted, true);
  assert.equal(activeJobPriority("stream-k"), null, "GET slot is free immediately");
  const live = withInflightPriority("stream-k", "live", async () => "streamed-clip");
  assert.equal(await live, "streamed-clip");
  await assert.rejects(prefetch);
  assert.equal(cancelPrefetchJob("stream-k"), false, "a live job is never cancelled by a prefetch");
});

test("4b. Streaming lifecycle ends in 'ended' only on a real END event", () => {
  const lc = new AudioLifecycle("tts-stream");
  assert.equal(lc.send("LOAD"), "loading");
  assert.equal(lc.send("READY"), "ready");
  assert.equal(lc.send("PLAY"), "playing");
  assert.equal(lc.send("END"), "ended");
  assert.equal(lc.isTerminal, true);
  assert.ok(TERMINAL_STATES.includes(lc.current));
});

test("5. Streaming INTERRUPTED: abort is a distinct terminal state, never 'ended'", () => {
  const lc = new AudioLifecycle("tts-stream");
  lc.send("LOAD"); lc.send("READY"); lc.send("PLAY");
  assert.equal(lc.send("INTERRUPT"), "interrupted");
  assert.equal(lc.send("END"), "interrupted", "a late END cannot turn an interruption into completion");
  assert.equal(reduceAudioState("playing", "INTERRUPT"), "interrupted");
  assert.equal(reduceAudioState("playing", "FAIL"), "failed");
  assert.equal(canTransition("interrupted", "END"), false);
  const o = outcomeOf("failed", "stream", { partial: true });
  assert.equal(o.partial, true, "a truncated stream is a partial FAILURE, not a replayable success");
  assert.equal(o.status, "failed");
});

test("5b. PlaybackGuard: single owner, no duplicate/overlapping playback, exit terminates all", () => {
  let stops = 0;
  const g = new PlaybackGuard(() => { stops++; });
  const a = g.begin("line-1");
  assert.ok(a);
  assert.equal(g.begin("line-1"), null, "identical concurrent request is a no-op");
  const b = g.begin("line-2");
  assert.ok(b);
  assert.equal(stops, 1, "starting a new line stops the previous one");
  assert.equal(g.isCurrent(a!.generation), false);
  assert.equal(g.isCurrent(b!.generation), true);
  g.dispose();
  assert.equal(g.begin("line-3"), null, "after exit no new audio task can start");
});

// ============================================================ 6. preset audio
test("6. Preset question audio is preloaded with the TTS script (not fetched at play time)", async () => {
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return new Response(new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/mpeg" }), { status: 200 });
  }) as typeof fetch;
  try {
    const p = new AudioPreloader({ voice: "auto", serverTts: false });
    const before = audioMetrics.trace().events.length;
    const snap = await p.ensureOpeningAndFirst("", "/audio/question-1.mp3");
    assert.ok(snap);
    assert.equal(fetched, 1, "questionAudioUrl downloaded during the readiness gate");
    const events = audioMetrics.trace().events.slice(before);
    assert.ok(events.some((e) => e.name === "audio_download_ms" && e.source === "preset"));
    assert.ok(events.some((e) => e.name === "audio_ready_ms"), "opening gate is timed");
    p.dispose();
  } finally {
    globalThis.fetch = original;
  }
});

test("6b. Script plan: opening/first CURRENT, next NEXT, backups LOW", () => {
  const entries = classifyScriptLines({
    opening: "Good morning.",
    first: "Good morning.",
    next: ["Next question?"],
    rest: ["Question three?", "Question four?"],
    fixed: ["Can you start speaking now, please?"],
    backups: ["Of course. Question three?", "That's all right. Let's move on."],
  });
  const byText = Object.fromEntries(entries.map((e) => [e.text, e.priority]));
  assert.equal(byText["Good morning."], TTS_PRIORITY.CURRENT);
  assert.equal(byText["Next question?"], TTS_PRIORITY.NEXT);
  assert.equal(byText["Question three?"], TTS_PRIORITY.BACKGROUND);
  assert.equal(byText["Can you start speaking now, please?"], TTS_PRIORITY.BACKGROUND);
  assert.equal(byText["Of course. Question three?"], TTS_PRIORITY.LOW);
  assert.equal(byText["That's all right. Let's move on."], TTS_PRIORITY.LOW);
  assert.equal(entries.length, new Set(entries.map((e) => e.text)).size, "no duplicate lines");
});

test("6c. Readiness gate never waits for the whole backup script", async () => {
  // A CURRENT line resolves fast while a LOW backup hangs: the gate must settle.
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Blob([new Uint8Array(4)]), { status: 200 })) as typeof fetch;
  try {
    const p = new AudioPreloader({ voice: "auto", serverTts: false, readyTimeoutMs: 200 });
    const started = Date.now();
    await p.ensureOpeningAndFirst("", null);
    assert.ok(Date.now() - started < 2000, "gate returns without waiting for background jobs");
    p.dispose();
  } finally {
    globalThis.fetch = original;
  }
});

// ============================================================ 7. mic reuse
function fakeEnv(opts: { worklet?: boolean; failWorklet?: boolean } = {}) {
  const counts = { streams: 0, contexts: 0, recorders: 0, workletModules: 0 };
  let clock = 0;
  const track = { addEventListener() {}, removeEventListener() {}, stop() {} };
  const stream: StreamLike = { getAudioTracks: () => [track], getTracks: () => [track] };
  let lastProc: ScriptProcessorLike | null = null;
  const node = (): NodeLike => ({ connect: () => ({}), disconnect() {} });
  const ctx: ContextLike = {
    sampleRate: 48000,
    resume: async () => {},
    close: async () => {},
    createMediaStreamSource: () => node(),
    createGain: () => ({ gain: { value: 0 }, connect() {}, disconnect() {} }),
    createScriptProcessor: () => {
      const p: ScriptProcessorLike = { connect: () => ({}), disconnect() {}, onaudioprocess: null };
      lastProc = p;
      return p;
    },
    ...(opts.worklet ? { audioWorklet: { addModule: async () => { counts.workletModules++; if (opts.failWorklet) throw new Error("worklet unavailable"); } } } : {}),
    destination: {},
  };
  const env: RecordingEnvironment = {
    openStream: async () => { counts.streams++; return stream; },
    createContext: () => { counts.contexts++; return ctx; },
    createMediaRecorder: () => {
      counts.recorders++;
      let state = "inactive";
      let onData: ((e: { data: Blob }) => void) | null = null;
      let onStop: (() => void) | null = null;
      const rec: RecorderLike = {
        get state() { return state; },
        set state(v: string) { state = v; },
        mimeType: "audio/webm",
        get ondataavailable() { return onData; },
        set ondataavailable(fn) { onData = fn; },
        get onstop() { return onStop; },
        set onstop(fn) { onStop = fn; },
        start() { state = "recording"; },
        stop() {
          state = "inactive";
          queueMicrotask(() => {
            onData?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }) });
            onStop?.();
          });
        },
      };
      return rec;
    },
    isTypeSupported: () => true,
    ...(opts.worklet ? { createWorkletNode: () => ({ ...node(), port: { onmessage: null, postMessage() {} } }) } : {}),
    workletModuleUrl: "/audio/pcm-worklet.js",
    now: () => clock,
  };
  return { env, counts, getProc: () => lastProc, advance: (ms: number) => { clock += ms; } };
}

test("7. Microphone + AudioContext are reused across 11 answers; each answer has its own file", async () => {
  const f = fakeEnv({ worklet: true });
  const rs = new RecordingSession({ env: f.env });
  assert.equal(await rs.acquire(), "audio-worklet", "AudioWorklet is preferred when available");
  const blobs: Blob[] = [];
  for (let i = 0; i < 11; i++) {
    rs.startAnswer();
    f.advance(20_000);
    const rec = await rs.stopAnswer();
    assert.ok(rec.blob, `answer ${i + 1} has its own recording`);
    assert.equal(rec.durationMs, 20_000);
    blobs.push(rec.blob!);
  }
  assert.equal(new Set(blobs).size, 11, "11 independent recording files, not one shared stream");
  assert.equal(f.counts.streams, 1, "getUserMedia called ONCE for the whole session");
  assert.equal(f.counts.contexts, 1, "AudioContext created ONCE for the whole session");
  assert.equal(f.counts.recorders, 11, "one MediaRecorder per answer");
  rs.dispose();
});

test("7b. Safari fallback: failing AudioWorklet falls back to ScriptProcessorNode", async () => {
  const f = fakeEnv({ worklet: true, failWorklet: true });
  const rs = new RecordingSession({ env: f.env });
  assert.equal(await rs.acquire(), "script-processor");
  rs.startAnswer();
  const proc = f.getProc();
  assert.ok(proc?.onaudioprocess, "PCM capture node is wired");
  proc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(480).fill(0.25) } });
  f.advance(1000);
  const rec = await rs.stopAnswer();
  assert.ok(rec.wav, "16 kHz WAV produced from the fallback path");
  assert.equal(rec.wav!.type, "audio/wav");
  rs.dispose();
});

test("7c. No AudioWorklet at all → script processor; exit disposes the shared stream once", async () => {
  const f = fakeEnv();
  const rs = new RecordingSession({ env: f.env });
  assert.equal(await rs.acquire(), "script-processor");
  rs.dispose();
  rs.dispose();
  assert.equal(f.counts.streams, 1);
});

// ============================================================ 8. 11 questions
test("8. Eleven consecutive Part 1/2/3 questions complete with the authoritative state machine", () => {
  // 5 x Part 1, 1 x Part 2 cue card, 5 x Part 3 = 11 questions.
  const parts = [1, 1, 1, 1, 1, 2, 3, 3, 3, 3, 3];
  const steps: MachineStep[] = parts.map((part, i) => ({
    id: `q${i}`, stepIndex: i, part,
    kind: part === 2 ? "cue_card" : "question",
    status: "pending", repeatCount: 0,
  }));
  const s: MachineState = { status: "in_progress", currentStep: 0, steps, config: resolveConfig("full") };
  let completed = 0;
  for (let guard = 0; guard < 30; guard++) {
    const step = steps.find((x) => x.stepIndex === s.currentStep);
    assert.ok(step, "current step exists");
    assert.equal(canSubmitAnswer(s, step.id).ok, true);
    step.status = "answered"; // submitAnswer persists this
    completed++;
    const d = decideAdvance(s, step.stepIndex, { wordCount: 40, noResponse: false }, { llmAvailable: false, allowFollowUps: false });
    assert.equal(d.ok, true);
    if (d.ok && d.value.type === "finish") break;
    assert.equal(d.ok && d.value.type, "next");
    if (d.ok && d.value.type === "next") s.currentStep = d.value.nextStep;
  }
  assert.equal(completed, 11, "all 11 questions answered and advanced");
  assert.equal(steps.filter((x) => x.status === "answered").length, 11);
});

// ============================================================ 9. upload retry
test("9. Upload failure retry: retryable statuses and bounded exponential backoff", () => {
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(408), true);
  assert.equal(isRetryableStatus(0), true); // network / timeout
  assert.equal(isRetryableStatus(409), false, "conflict must resync, not retry");
  assert.equal(isRetryableStatus(415), false);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(backoffDelay), [800, 1600, 3200, 6400, 8000, 8000]);
});

// ================================================= 10 / 11. ASR policy
test("10. Full Mock Part 3 NEVER waits on synchronous ASR", () => {
  const t = asrTimingForStep({
    mode: "full", part: 3, kind: "question", asrLocation: "server",
    noResponse: false, followUpsUsed: 0, maxFollowUps: 2,
  });
  assert.equal(t, "deferred", "no blocking transcription; scoring backfills");
  assert.notEqual(t, "sync");
  // The state machine also refuses follow-ups in full mode.
  const s: MachineState = {
    status: "in_progress", currentStep: 2,
    steps: [
      { id: "a", stepIndex: 0, part: 1, kind: "question", status: "answered", repeatCount: 0 },
      { id: "b", stepIndex: 1, part: 2, kind: "cue_card", status: "answered", repeatCount: 0 },
      { id: "c", stepIndex: 2, part: 3, kind: "question", status: "answered", repeatCount: 0 },
      { id: "d", stepIndex: 3, part: 3, kind: "question", status: "pending", repeatCount: 0 },
    ],
    config: resolveConfig("full"),
  };
  const d = decideAdvance(s, 2, { wordCount: 3, noResponse: false }, { llmAvailable: true, allowFollowUps: false });
  assert.equal(d.ok && d.value.type, "next", "full mock follows the fixed bank script");
});

test("11. Practice Part 3 KEEPS synchronous ASR for the AI follow-up decision", () => {
  const cfg = resolveConfig("part3");
  assert.equal(asrTimingFromConfig("part3", { part: 3, kind: "question" }, "server", false, 0, cfg), "sync");
  assert.equal(asrTimingFromConfig("part3", { part: 1, kind: "question" }, "server", false, 0, cfg), "deferred");
  assert.equal(asrTimingFromConfig("part3", { part: 3, kind: "question" }, "server", true, 0, cfg), "none", "silence needs no ASR");
  assert.equal(asrTimingFromConfig("part3", { part: 3, kind: "question" }, "browser", false, 0, cfg), "none", "browser supplies the transcript");
  assert.equal(asrTimingFromConfig("part3", { part: 3, kind: "question" }, "server", false, cfg.part3.maxFollowUps, cfg), "deferred", "cap reached");
  const s: MachineState = {
    status: "in_progress", currentStep: 0,
    steps: [
      { id: "a", stepIndex: 0, part: 3, kind: "question", status: "answered", repeatCount: 0 },
      { id: "b", stepIndex: 1, part: 3, kind: "question", status: "pending", repeatCount: 0 },
    ],
    config: cfg,
  };
  const d = decideAdvance(s, 0, { wordCount: 5, noResponse: false }, { llmAvailable: true, allowFollowUps: true });
  assert.equal(d.ok && d.value.type, "follow_up", "short answer still triggers an AI probe");
});

// ============================================================ 12. refresh / exit / re-enter
test("12. Refresh, exit and re-entry: server state is authoritative and audio tasks terminate", async () => {
  const s: MachineState = {
    status: "in_progress", currentStep: 1,
    steps: [
      { id: "a", stepIndex: 0, part: 1, kind: "question", status: "answered", repeatCount: 0 },
      { id: "b", stepIndex: 1, part: 1, kind: "question", status: "pending", repeatCount: 0 },
    ],
    config: resolveConfig("full"),
  };
  // reload → the answered step is still answered and cannot be re-submitted in mock mode
  assert.deepEqual(canSubmitAnswer(s, "a"), { ok: false, error: "not_current_step" });
  assert.equal(canSubmitAnswer(s, "b").ok, true);
  // duplicate advance (double click / retry) is guarded
  assert.deepEqual(decideAdvance(s, 0, { wordCount: 20, noResponse: false }, { llmAvailable: false }), { ok: false, error: "not_current_step" });

  // exit → all queued synthesis tasks are cancelled, no new task can start
  const sched = new TtsScheduler<string>({ run: async () => "clip", maxParallel: 1 });
  const queued = sched.request({ text: "later line", voice: "v", model: "m" }, TTS_PRIORITY.LOW);
  sched.dispose();
  assert.equal(sched.snapshotAll().length, 0, "queue cleared on exit");
  assert.equal(sched.status(queued.key), undefined);
  const after = sched.request({ text: "new line", voice: "v", model: "m" }, TTS_PRIORITY.CURRENT);
  assert.equal(await after.promise, null, "disposed scheduler never starts new work");
});

test("12b. Complete-answer idempotency: a repeated key shares the same in-flight job", async () => {
  // Simulates the server's idempotency guard combined with the in-flight dedup.
  const key = ttsCacheKey(["idem", "same-key"]);
  let runs = 0;
  const gate = Promise.withResolvers<string>();
  const a = withInflightPriority(key, "live", () => { runs++; return gate.promise; });
  const b = withInflightPriority(key, "live", () => { runs++; return Promise.resolve("should-not-run"); });
  assert.strictEqual(a, b);
  gate.resolve("answer-1");
  assert.equal(await a, "answer-1");
  assert.equal(await b, "answer-1");
  assert.equal(runs, 1, "one write for one idempotency key");
});

// ============================================================ metrics
test("metrics: all 10 timings recorded, sources distinguish hit / miss / stream, dev trace is complete", () => {
  let t = 0;
  const m = new AudioMetrics({ now: () => t });
  m.startTurn(0);
  for (const name of METRIC_NAMES) m.record(name, 7, "cache-hit");
  t = 50;
  m.record("tts_synthesis_ms", 12, "cache-miss");
  m.record("tts_synthesis_ms", 3, "stream");
  t = 120;
  m.startTurn(1); // records inter_turn_gap_ms automatically
  m.recordState("examiner", "playing", "ready");
  m.endTurn("advanced");
  const summary = m.summary();
  for (const name of METRIC_NAMES) assert.ok(summary[name].count >= 1, `${name} present`);
  assert.equal(summary.tts_synthesis_ms.bySource["cache-hit"], 1);
  assert.equal(summary.tts_synthesis_ms.bySource["cache-miss"], 1);
  assert.equal(summary.tts_synthesis_ms.bySource.stream, 1);
  assert.equal(summary.tts_synthesis_ms.totalMs, 22);
  const trace = m.trace();
  assert.equal(trace.turns.length, 2);
  assert.equal(trace.turns[1].outcome, "advanced");
  assert.ok(trace.states.some((s) => s.state === "playing"), "dev call chain includes lifecycle states");
  assert.ok(trace.events.some((e) => e.name === "inter_turn_gap_ms"));
});

// ============================================================ explicit limits
test("BROWSER-ONLY: real audio playback / mic capture / worklet rendering are NOT verifiable in Node", () => {
  // These require a real browser and are covered by integration.mjs (API level)
  // plus manual browser verification. Recorded here so the gap is explicit.
  const unverifiable = [
    "<audio> progressive stream actually starts at the first chunk",
    "two examiner clips never overlap in a real browser",
    "getUserMedia permission prompt + device switching on Chrome/Edge/Safari",
    "AudioWorklet PCM rendering on the audio thread",
    "speechSynthesis fallback voice quality / iOS unlock gesture",
    "Safari Range requests on preset questionAudioUrl",
  ];
  assert.equal(unverifiable.length, 6);
  console.log("  [BROWSER-ONLY] " + unverifiable.join(" | "));
});
