/**
 * Offline tests for the audio analysis pipeline (no DB, no paid API).
 * Run with: npx tsx --test tests/audio-analysis.test.ts
 *
 * Acoustic fixtures are synthetic PCM/timing arrays with known ground truth
 * (tone on/off segments, fixed F0s, hand-placed pauses) — they exercise the
 * real algorithms; they are not recordings of real candidates.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeWavPcm16, detectSpeech, analyzeProsody } from "../src/lib/speaking/audio-signal";
import {
  analyzeWordTimings, analyzeTokenFeatures, buildAudioAnalysis, aggregateSessionAudio,
  formatAudioEvidenceBlock, audioAnalysisConfigFromEnv, DEFAULT_AUDIO_ANALYSIS_CONFIG,
} from "../src/lib/speaking/audio-analysis";
import type { WordTiming } from "../src/db/schema";

const RATE = 16000;

/** Encode mono 16-bit PCM WAV from a sample generator. */
function wavBytes(seconds: number, gen: (t: number) => number, rate = RATE): Uint8Array {
  const n = Math.round(rate * seconds);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, gen(i / rate)));
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Uint8Array(buf);
}

const tone = (freq: number, amp = 0.2) => (t: number) => amp * Math.sin(2 * Math.PI * freq * t);
const silence = () => 0;

function timing(word: string, startSec: number, endSec: number, confidence?: number): WordTiming {
  return { word, start: startSec, end: endSec, confidence };
}

// ------------------------------------------------------------- signal layer
test("wav: decodes 16-bit PCM mono and rejects non-RIFF input", () => {
  const decoded = decodeWavPcm16(wavBytes(0.5, tone(200)));
  assert.ok(decoded.ok);
  if (decoded.ok) {
    assert.equal(decoded.wav.sampleRate, RATE);
    assert.equal(decoded.wav.durationMs, 500);
    assert.equal(decoded.wav.samples.length, RATE * 0.5);
  }
  const bad = decodeWavPcm16(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.reason, /too short|RIFF/);
});

test("vad: finds two speech segments between silences; silence-only yields none", () => {
  // 0.5s silence | 1.0s tone | 0.5s silence | 1.0s tone | 0.5s silence
  const gen = (t: number) => (t >= 0.5 && t < 1.5) || (t >= 2.0 && t < 3.0) ? tone(300)(t) : silence();
  const wav = decodeWavPcm16(wavBytes(3.5, gen));
  assert.ok(wav.ok);
  if (!wav.ok) return;
  const vad = detectSpeech(wav.wav.samples, RATE, wav.wav.durationMs);
  assert.ok(vad.segments.length >= 2, `expected ≥2 segments, got ${vad.segments.length}`);
  assert.ok(vad.speechMs > 1600 && vad.speechMs < 2400, `speechMs ${vad.speechMs} out of range`);
  assert.ok(!vad.lowSnr, `expected healthy SNR, got ${vad.snrDb?.toFixed(1)} dB`);

  const quiet = decodeWavPcm16(wavBytes(1.0, silence));
  assert.ok(quiet.ok);
  if (quiet.ok) {
    const none = detectSpeech(quiet.wav.samples, RATE, 1000);
    assert.equal(none.segments.length, 0);
    assert.equal(none.speechMs, 0);
  }
});

test("prosody: stable tone → low pitch std; two tones → wide range", () => {
  const one = analyzeProsody({ sampleRate: RATE, channels: 1, samples: new Float32Array(Array.from({ length: RATE * 2 }, (_, i) => tone(220)(i / RATE))), durationMs: 2000 });
  assert.ok(one.f0MedianHz !== null);
  assert.ok(Math.abs((one.f0MedianHz as number) - 220) < 15, `median F0 ${one.f0MedianHz}`);
  assert.ok((one.f0StdHz as number) < 15, `std ${one.f0StdHz} should be small for a steady tone`);

  const twoGen = (t: number) => (t < 1 ? tone(220)(t) : tone(330)(t));
  const two = analyzeProsody({ sampleRate: RATE, channels: 1, samples: new Float32Array(Array.from({ length: RATE * 2 }, (_, i) => twoGen(i / RATE))), durationMs: 2000 });
  assert.ok((two.f0RangeHz as number) > 60, `range ${two.f0RangeHz} should exceed 60 Hz`);
});

// ------------------------------------------------------------- word timings
test("word timings: pauses, rates and runs from real timestamps", () => {
  // hello(0-0.2) there(0.3-0.5) [1.2s gap] world(1.7-1.9)
  const words = [timing("hello", 0, 0.2), timing("there", 0.3, 0.5), timing("world", 1.7, 1.9)];
  const cfg = DEFAULT_AUDIO_ANALYSIS_CONFIG;
  const r = analyzeWordTimings(words, "Hello there. World", cfg);
  assert.ok(r);
  if (!r) return;
  assert.equal(r.pauses.length, 1);
  assert.equal(r.pauses[0].durationMs, 1200);
  assert.equal(r.pauses[0].position, "sentence-boundary");
  assert.equal(r.pauses[0].beforeText, "hello there");
  assert.equal(r.pauses[0].afterText, "world");
  assert.equal(r.spanMs, 1900);
  assert.equal(r.speechMs, 700);
  assert.deepEqual(r.runs, [2, 1]);
  assert.equal(r.speechRateWpm, Math.round((3 / 1.9) * 60));
  assert.equal(r.articulationRateWpm, Math.round((3 / 0.7) * 60));
});

test("word timings: no pause below the configured minimum", () => {
  const words = [timing("a", 0, 0.2), timing("b", 0.35, 0.5), timing("c", 0.6, 0.8)];
  const r = analyzeWordTimings(words, "a b c", DEFAULT_AUDIO_ANALYSIS_CONFIG);
  assert.ok(r);
  if (r) {
    assert.equal(r.pauses.length, 0);
    assert.deepEqual(r.runs, [3]);
  }
});

// ------------------------------------------------------------- token features
test("token features: pure fillers counted, 'like'/'kind of' never", () => {
  const f = analyzeTokenFeatures(["um", "i", "like", "it", "kind", "of", "uh"], null);
  assert.equal(f.fillerCount, 2);
  assert.ok(f.fillers.includes("um×1") && f.fillers.includes("uh×1"));
  assert.ok(!f.fillers.some((x) => x.startsWith("like")));
});

test("token features: 'you know' counted; 'very very' is emphasis, not repetition", () => {
  const f = analyzeTokenFeatures(["you", "know", "it", "was", "very", "very", "good"], null);
  assert.equal(f.fillerCount, 1);
  assert.equal(f.repetitionCount, 0);
});

test("token features: 'I mean' is repair only after a real pause", () => {
  const withPause = analyzeTokenFeatures(["it", "was", "i", "mean", "it", "helped"], new Map([[2, 700]]));
  assert.equal(withPause.selfCorrectionCount, 1);
  assert.ok(withPause.selfCorrections[0].includes("i mean"));
  const withoutPause = analyzeTokenFeatures(["it", "was", "i", "mean", "it", "helped"], null);
  assert.equal(withoutPause.selfCorrectionCount, 0);
});

test("token features: immediate 2-gram restart is a self-correction", () => {
  const f = analyzeTokenFeatures(["i", "went", "i", "went", "home"], null);
  assert.ok(f.selfCorrectionCount >= 1);
  assert.ok(f.selfCorrections.some((c) => c.includes("i went")));
});

// ------------------------------------------------------------- fusion
test("buildAudioAnalysis: full sources → all coverage true, honest numbers", () => {
  const gen = (t: number) => (t >= 0.2 && t < 1.8) ? tone(280)(t) : silence();
  const wav = wavBytes(2.0, gen);
  const words = [timing("hello", 0.2, 0.5), timing("there", 0.6, 0.8), timing("world", 1.0, 1.3)];
  const a = buildAudioAnalysis({ text: "hello there world", durationMs: 2000, words, wav });
  assert.equal(a.coverage.transcriptAvailable, true);
  assert.equal(a.coverage.wordTimingAvailable, true);
  assert.equal(a.coverage.vadAvailable, true);
  assert.equal(a.coverage.prosodyAvailable, true);
  assert.equal(a.pauseStats.count, 0, "0.8s→1.0s gap is 200ms, below the 250ms pause minimum");
  assert.ok(a.speechRateWpm !== null && a.speechRateWpm > 0);
  assert.equal(a.durationMs, 2000);
});

test("buildAudioAnalysis: no sources → degraded coverage with warnings, never zeros-as-data", () => {
  const a = buildAudioAnalysis({ text: "", durationMs: 4000 });
  assert.equal(a.coverage.transcriptAvailable, false);
  assert.equal(a.coverage.wordTimingAvailable, false);
  assert.equal(a.coverage.vadAvailable, false);
  assert.equal(a.coverage.prosodyAvailable, false);
  assert.equal(a.speechRateWpm, null);
  assert.equal(a.fluency.meanLengthOfRun, null);
  assert.ok(a.warnings.some((w) => w.includes("word timings")));
  assert.ok(a.warnings.some((w) => w.includes("pcm_wav")));
});

test("buildAudioAnalysis: words only (no wav) → rates present, VAD unavailable", () => {
  const words = [timing("i", 0, 0.1), timing("think", 0.15, 0.35), timing("so", 0.4, 0.6)];
  const a = buildAudioAnalysis({ text: "I think so", durationMs: 800, words, wav: null });
  assert.equal(a.coverage.wordTimingAvailable, true);
  assert.equal(a.coverage.vadAvailable, false);
  assert.equal(a.coverage.prosodyAvailable, false);
  assert.ok(a.speechRateWpm !== null);
});

// ------------------------------------------------------------- session + prompt
test("aggregateSessionAudio: duration-weighted means and summed events", () => {
  const mk = (wpm: number, fillers: number, part: number): { part: number; analysis: ReturnType<typeof buildAudioAnalysis> } => ({
    part,
    analysis: {
      version: "audio-analysis-v1",
      durationMs: 10000,
      speechDurationMs: 8000,
      silenceDurationMs: 2000,
      speechRateWpm: wpm,
      articulationRateWpm: null,
      pauseStats: { count: fillers, meanDurationMs: 500, medianDurationMs: 400, byLength: { short: fillers, medium: 0, long: 0 }, longPauseCount: 0, pauses: [] },
      fluency: { meanLengthOfRun: 8, longestRun: 12, runCount: 5, fillerCount: fillers, fillers: [], repetitionCount: fillers, repeatedPhrases: [], selfCorrectionCount: 1, selfCorrections: [] },
      prosody: null,
      coverage: { transcriptAvailable: true, wordTimingAvailable: true, vadAvailable: true, prosodyAvailable: false },
      warnings: [],
    },
  });
  const session = aggregateSessionAudio([mk(100, 3, 1), mk(200, 5, 1), mk(150, 0, 3)]);
  assert.ok(session);
  if (!session) return;
  // equal weights (all 8s speech) → mean = 150
  assert.equal(session.speechRateWpm, 150);
  assert.equal(session.fluency.fillerCount, 8);
  assert.equal(session.fluency.repetitionCount, 8);
  assert.equal(session.pauseStats.count, 8);
  assert.equal(session.perPart.length, 2);
  const p1 = session.perPart.find((r) => r.part === 1);
  assert.ok(p1 && p1.fillerCount === 8);
});

test("prompt block: rates, pauses and availability are surfaced to the scorer", () => {
  const words = [timing("hello", 0, 0.2), timing("there", 1.0, 1.3)];
  const a = buildAudioAnalysis({ text: "hello there", durationMs: 1500, words, wav: null });
  const block = formatAudioEvidenceBlock([{ index: 1, part: 1, analysis: a }], null);
  assert.ok(block);
  if (block) {
    assert.match(block, /wpm/);
    assert.match(block, /pauses 1/);
    assert.match(block, /availability:/);
    assert.match(block, /warnings:/);
  }
});

test("config: env overrides are validated and clamped", () => {
  const cfg = audioAnalysisConfigFromEnv({ AUDIO_MIN_PAUSE_MS: "500", AUDIO_RUN_BREAK_MS: "99999" });
  assert.equal(cfg.minPauseMs, 500);
  assert.equal(cfg.runBreakMs, DEFAULT_AUDIO_ANALYSIS_CONFIG.runBreakMs, "out-of-range values fall back to default");
});
