/**
 * Acoustic signal primitives: WAV (16-bit PCM) decoding and frame energy.
 * Pure TypeScript, zero runtime dependencies, deterministic — unit-tested with
 * synthetic PCM.
 *
 * Why not a heavy DSP library? The `pcm_wav` asset is always 16 kHz mono
 * 16-bit PCM produced by the browser recorder, so decoding needs no ffmpeg.
 * Other encodings are rejected with a clear reason so callers can mark
 * VAD/prosody honestly `unavailable` instead of guessing.
 */
import { resample } from "@/lib/audio/wav";

export const VAD_FRAME_MS = 30;
export const VAD_HOP_MS = 10;
/** Pitch runs on an 8 kHz downsample — ample for the 60–400 Hz voice range. */
const PITCH_RATE = 8000;
/** Cap on analysed pitch frames so a 3-minute answer stays fast. */
const PITCH_FRAME_BUDGET = 6000;

export interface WavInfo {
  sampleRate: number;
  channels: number;
  /** Decoded mono samples in [-1, 1]. */
  samples: Float32Array;
  durationMs: number;
}

export type WavDecodeResult =
  | { ok: true; wav: WavInfo }
  | { ok: false; reason: string };

/**
 * Decode 16-bit PCM WAV (mono, or stereo averaged to mono). Chunk-walking
 * parser tolerates extra RIFF chunks before `data`.
 */
export function decodeWavPcm16(buf: Uint8Array): WavDecodeResult {
  if (buf.byteLength < 44) return { ok: false, reason: "file too short to be a WAV" };
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag4 = (o: number) =>
    String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag4(0) !== "RIFF") return { ok: false, reason: "not a RIFF file" };
  if (tag4(8) !== "WAVE") return { ok: false, reason: "not a RIFF/WAVE file" };

  let off = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let dataOff = -1;
  let dataLen = -1;
  while (off + 8 <= buf.byteLength) {
    const id = tag4(off);
    const size = v.getUint32(off + 4, true);
    if (id === "fmt " && size >= 16) {
      fmt = {
        format: v.getUint16(off + 8, true),
        channels: v.getUint16(off + 10, true),
        sampleRate: v.getUint32(off + 12, true),
        bits: v.getUint16(off + 22, true),
      };
    } else if (id === "data") {
      dataOff = off + 8;
      dataLen = size;
    }
    off += 8 + size + (size & 1);
  }
  if (!fmt || dataOff < 0) return { ok: false, reason: "missing fmt or data chunk" };
  if (fmt.format !== 1) return { ok: false, reason: `unsupported WAV format tag ${fmt.format}; only PCM is decoded` };
  const bits = fmt.bits;
  if (bits !== 16 && bits !== 8) return { ok: false, reason: `unsupported sample width ${bits} bits` };
  const bytesPer = bits / 8;
  const dataLenClamped = Math.min(dataLen, buf.byteLength - dataOff);
  const frameCount = Math.floor(dataLenClamped / (bytesPer * fmt.channels));
  if (frameCount <= 0) return { ok: false, reason: "empty data chunk" };
  if (fmt.sampleRate < 8000 || fmt.sampleRate > 96000) {
    return { ok: false, reason: `unexpected sample rate ${fmt.sampleRate}` };
  }
  const samples = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    let acc = 0;
    for (let ch = 0; ch < fmt.channels; ch++) {
      const o = dataOff + i * bytesPer * fmt.channels + ch * bytesPer;
      acc += bits === 16 ? v.getInt16(o, true) / 32768 : (v.getUint8(o) - 128) / 128;
    }
    samples[i] = acc / fmt.channels;
  }
  return {
    ok: true,
    wav: { sampleRate: fmt.sampleRate, channels: fmt.channels, samples, durationMs: Math.round((frameCount / fmt.sampleRate) * 1000) },
  };
}

// ------------------------------------------------------------------ framing
export interface FrameEnergy {
  /** RMS per frame. */
  rms: Float32Array;
  /** Hop size in ms used to map frame index → time. */
  hopMs: number;
  /** Frame window in ms. */
  frameMs: number;
}

/** Fixed framing used by both VAD and energy statistics. */
export function frameRms(samples: Float32Array, sampleRate: number, frameMs: number, hopMs: number): FrameEnergy {
  const frameLen = Math.max(1, Math.round((frameMs / 1000) * sampleRate));
  const hop = Math.max(1, Math.round((hopMs / 1000) * sampleRate));
  const n = samples.length >= frameLen ? Math.floor((samples.length - frameLen) / hop) + 1 : 0;
  const rms = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const s = f * hop;
    let sum = 0;
    for (let i = 0; i < frameLen; i++) sum += samples[s + i] * samples[s + i];
    rms[f] = Math.sqrt(sum / frameLen);
  }
  return { rms, hopMs, frameMs };
}

/** Quantile of unsorted values (0 ≤ q ≤ 1), linearly interpolated. */
export function quantile(values: Float32Array | number[], q: number): number {
  const arr = Array.from(values).sort((a, b) => a - b);
  if (!arr.length) return 0;
  const pos = clamp(q, 0, 1) * (arr.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return arr[lo];
  return arr[lo] + (pos - lo) * (arr[hi] - arr[lo]);
}

/** Clamp x into [lo, hi]. */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Sample standard deviation; 0 for fewer than 2 values. */
export function std(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const acc = values.reduce((s, v) => s + (v - mean) * (v - mean), 0);
  return Math.sqrt(acc / (values.length - 1));
}

// ------------------------------------------------------------------ VAD
export interface VadSegment {
  startMs: number;
  endMs: number;
}

export interface VadResult {
  /** Merged speech segments (ms from recording start). */
  segments: VadSegment[];
  /** Total speech time = Σ segment durations. */
  speechMs: number;
  /** recording duration − speechMs, never negative. */
  silenceMs: number;
  /** 10th-percentile frame level in dBFS (noise estimate). */
  noiseFloorDb: number | null;
  /** p90/p10 frame-level ratio in dB. */
  snrDb: number | null;
  /** SNR below ~8 dB — VAD pause statistics are then unreliable. */
  lowSnr: boolean;
}

export interface VadOptions {
  /** Enter speech when RMS > max(noiseFloor × enterFactor, minEnterRms). */
  enterFactor?: number;
  /** Leave speech when RMS < max(noiseFloor × exitFactor, minEnterRms × 0.6). */
  exitFactor?: number;
  /** Absolute RMS floor so near-silence recordings are not judged all-speech. */
  minEnterRms?: number;
  /** Speech segments shorter than this fold back into silence. */
  blipMs?: number;
  /** Gaps shorter than this between speech segments merge into one run. */
  minSilenceMs?: number;
}

const VAD_DEFAULTS: Required<VadOptions> = {
  enterFactor: 3,
  exitFactor: 1.6,
  minEnterRms: 0.004,
  blipMs: 150,
  minSilenceMs: 200,
};

/**
 * Adaptive energy VAD with hysteresis. Thresholds track a percentile noise
 * floor, so it adapts from quiet rooms to noisy ones without per-deployment
 * tuning. Frame level enters/leaves speech with separate thresholds; short
 * blips are folded away and short gaps are bridged.
 */
export function detectSpeech(
  samples: Float32Array,
  sampleRate: number,
  durationMs: number,
  opts: VadOptions = {},
): VadResult {
  const o = { ...VAD_DEFAULTS, ...opts };
  const { rms, hopMs } = frameRms(samples, sampleRate, VAD_FRAME_MS, VAD_HOP_MS);
  const p10 = quantile(rms, 0.10);
  const p90 = quantile(rms, 0.90);
  const enter = Math.max(p10 * o.enterFactor, o.minEnterRms);
  const exit = Math.max(p10 * o.exitFactor, o.minEnterRms * 0.6);
  const noiseFloorDb = 20 * Math.log10(p10 + 1e-9);
  const snrDb = 20 * Math.log10((p90 + 1e-9) / (p10 + 1e-9));
  const lowSnr = snrDb < 8;

  // Near-silence: even the loud frames are under the absolute floor.
  if (p90 < o.minEnterRms) {
    return { segments: [], speechMs: 0, silenceMs: Math.max(0, durationMs), noiseFloorDb, snrDb, lowSnr: false };
  }

  const raw: VadSegment[] = [];
  let cur: VadSegment | null = null;
  for (let f = 0; f < rms.length; f++) {
    const t = f * hopMs;
    if (cur === null) {
      if (rms[f] >= enter) cur = { startMs: t, endMs: t + VAD_FRAME_MS };
    } else if (rms[f] < exit) {
      raw.push(cur);
      cur = null;
    } else {
      cur.endMs = t + VAD_FRAME_MS;
    }
  }
  if (cur) raw.push(cur);

  const speech = raw.filter((s) => s.endMs - s.startMs >= o.blipMs);
  const merged: VadSegment[] = [];
  for (const s of speech) {
    const prev = merged[merged.length - 1];
    if (prev && s.startMs - prev.endMs < o.minSilenceMs) prev.endMs = s.endMs;
    else merged.push({ startMs: s.startMs, endMs: s.endMs });
  }
  const speechMs = merged.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
  return {
    segments: merged,
    speechMs,
    silenceMs: Math.max(0, durationMs - speechMs),
    noiseFloorDb,
    snrDb,
    lowSnr,
  };
}

// ------------------------------------------------------------------ prosody
export interface ProsodyResult {
  /** Voiced frames / analysed frames (0–1); null when nothing was analysed. */
  voicedRatio: number | null;
  /** Median F0 of voiced frames (Hz). */
  f0MedianHz: number | null;
  /** Std-dev of F0 across voiced frames (Hz). */
  f0StdHz: number | null;
  /** p90 − p10 of voiced F0 (Hz) — intonation span. */
  f0RangeHz: number | null;
  /** Std-dev of speech-frame level in dB. */
  energyVariationDb: number | null;
  /** Frames actually analysed for pitch (diagnostics). */
  analysedFrames: number;
}

const PROSODY_DEFAULTS = {
  frameMs: 40,
  hopMs: 20,
  /** Normalised-autocorrelation clarity required to call a frame voiced. */
  minClarity: 0.5,
  minVoicedFrames: 8,
};

const DB_EPS = 1e-9;

/**
 * Pitch & energy variation over the speech part of the recording. A coarse
 * autocorrelation pitch tracker on the 8 kHz downsampled signal. Pitch numbers
 * are PROSODY EVIDENCE ONLY — they must never be turned into a band by
 * arithmetic (enforced in `audio-analysis.ts` / the scoring prompt).
 */
export function analyzeProsody(wav: WavInfo, vad?: VadResult | null): ProsodyResult {
  const rate = wav.sampleRate > PITCH_RATE ? PITCH_RATE : wav.sampleRate;
  const sig = wav.sampleRate > PITCH_RATE ? resample(wav.samples, wav.sampleRate, PITCH_RATE) : wav.samples;
  const frameLen = Math.round((PROSODY_DEFAULTS.frameMs / 1000) * rate);
  const hop = Math.round((PROSODY_DEFAULTS.hopMs / 1000) * rate);
  const n = sig.length >= frameLen ? Math.floor((sig.length - frameLen) / hop) + 1 : 0;
  if (n < 4) return { voicedRatio: null, f0MedianHz: null, f0StdHz: null, f0RangeHz: null, energyVariationDb: null, analysedFrames: 0 };

  const lagMin = Math.max(2, Math.floor(rate / 400)); // 400 Hz
  const lagMax = Math.ceil(rate / 60);                // 60 Hz
  const stride = Math.max(1, Math.ceil(n / PITCH_FRAME_BUDGET));
  const mask = vad ? segmentMask(vad.segments, n, hop) : null;

  const dbs: number[] = [];
  const f0s: number[] = [];
  let analysed = 0;
  for (let f = 0; f < n; f += stride) {
    if (mask && mask[f] !== 1) continue;
    const s = f * hop;
    const frame = sig.subarray(s, s + frameLen);
    let rms = 0;
    for (let i = 0; i < frameLen; i++) rms += frame[i] * frame[i];
    dbs.push(20 * Math.log10(Math.sqrt(rms / frameLen) + DB_EPS));
    analysed++;
    const f0 = pitchFrame(frame, rate, lagMin, lagMax);
    if (f0 !== null) f0s.push(f0);
  }

  const energyVariationDb = dbs.length >= 3 ? std(dbs) : null;
  if (f0s.length < PROSODY_DEFAULTS.minVoicedFrames) {
    return { voicedRatio: analysed ? f0s.length / analysed : null, f0MedianHz: null, f0StdHz: null, f0RangeHz: null, energyVariationDb, analysedFrames: analysed };
  }
  f0s.sort((a, b) => a - b);
  const at = (q: number) => f0s[Math.round(q * (f0s.length - 1))];
  return {
    voicedRatio: f0s.length / Math.max(1, analysed),
    f0MedianHz: f0s[Math.floor(f0s.length / 2)],
    f0StdHz: std(f0s),
    f0RangeHz: at(0.9) - at(0.1),
    energyVariationDb,
    analysedFrames: analysed,
  };
}

/** 1 = frame inside a speech segment. */
function segmentMask(segments: VadSegment[], frameCount: number, hopMs: number): Uint8Array {
  const mask = new Uint8Array(frameCount);
  for (const seg of segments) {
    const from = Math.max(0, Math.floor(seg.startMs / hopMs));
    const to = Math.min(frameCount - 1, Math.ceil(seg.endMs / hopMs));
    for (let f = from; f <= to; f++) mask[f] = 1;
  }
  return mask;
}

/**
 * Normalised autocorrelation pitch estimate for one frame. Returns null when
 * the frame is unvoiced or the periodicity peak is weak.
 */
function pitchFrame(frame: Float32Array, rate: number, lagMin: number, lagMax: number): number | null {
  const len = frame.length;
  let mean = 0;
  for (let i = 0; i < len; i++) mean += frame[i];
  mean /= len;
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) x[i] = frame[i] - mean;
  let r0 = 0;
  for (let i = 0; i < len; i++) r0 += x[i] * x[i];
  if (r0 < 1e-7) return null;

  let bestLag = -1;
  let bestVal = PROSODY_DEFAULTS.minClarity * r0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let r = 0;
    const nSub = len - lag;
    for (let i = 0; i < nSub; i++) r += x[i] * x[i + lag];
    if (r > bestVal) {
      bestVal = r;
      bestLag = lag;
    }
  }
  if (bestLag < 0) return null;
  // Parabolic refinement around the chosen lag.
  const rL = autocorrAt(x, bestLag - 1);
  const rR = autocorrAt(x, bestLag + 1);
  const denom = rL - 2 * bestVal + rR;
  const shift = denom !== 0 ? 0.5 * ((rL - rR) / denom) : 0;
  const lagF = bestLag + clamp(shift, -1, 1);
  const f0 = rate / lagF;
  if (f0 < 55 || f0 > 420) return null;
  return f0;
}

function autocorrAt(x: Float32Array, lag: number): number {
  let r = 0;
  const nSub = x.length - lag;
  for (let i = 0; i < nSub; i++) r += x[i] * x[i + lag];
  return r;
}
