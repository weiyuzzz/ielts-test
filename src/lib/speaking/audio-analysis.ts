/**
 * Unified audio analysis for IELTS Speaking answers.
 *
 * Combines three DISTINCT input kinds (never merged into one opaque string):
 *   1. raw audio            → VAD speech/silence + prosody (energy/pitch)
 *   2. ASR transcript + word timings → pauses, rates, runs, filler context
 *   3. derived acoustic metrics computed from 1 + 2
 *
 * Honesty rules enforced here:
 *   - Every feature reports whether it is available; missing sources yield
 *     `null` + a warning, never a fabricated number.
 *   - Word timings from ASR are the primary pause source; VAD is the fallback.
 *   - Prosody is evidence for the model only — nothing in this module maps
 *     acoustic numbers to bands.
 */
import type { WordTiming } from "@/db/schema";
import { analyzeProsody, decodeWavPcm16, detectSpeech, type VadResult, type WavInfo } from "./audio-signal";
import { tokenize } from "./metrics";

export const AUDIO_ANALYSIS_VERSION = "audio-analysis-v1";

export interface PauseInfo {
  startMs: number;
  endMs: number;
  durationMs: number;
  /** Up to 4 words before the pause (lowercased). */
  beforeText?: string;
  /** Up to 4 words after the pause (lowercased). */
  afterText?: string;
  /** "unknown" when word timings are missing or the transcript cannot be aligned. */
  position?: "mid-sentence" | "sentence-boundary" | "unknown";
}

export interface PauseStats {
  count: number;
  meanDurationMs: number;
  medianDurationMs: number;
  /** short < shortPauseMaxMs, medium < mediumPauseMaxMs, long ≥ mediumPauseMaxMs. */
  byLength: { short: number; medium: number; long: number };
  longPauseCount: number;
  /** Longest pauses first, capped at `maxPausesKept`. */
  pauses: PauseInfo[];
}

export interface FluencyFeatures {
  /** Mean words spoken between consecutive run-breaking pauses. */
  meanLengthOfRun: number | null;
  longestRun: number | null;
  runCount: number | null;
  fillerCount: number;
  /** Breakdown like ["um×2", "you know×1"], capped. */
  fillers: string[];
  repetitionCount: number;
  repeatedPhrases: string[];
  selfCorrectionCount: number | null;
  /** Quoted snippets of detected restarts / corrections, capped. */
  selfCorrections: string[];
}

export interface ProsodyFeatures {
  /** Std-dev of F0 over voiced frames (Hz). */
  pitchVariationHz: number | null;
  pitchMedianHz: number | null;
  /** p90 − p10 of voiced F0 (Hz). */
  pitchRangeHz: number | null;
  /** Std-dev of speech-frame level (dB). */
  energyVariationDb: number | null;
  /** Voiced / analysed frames (0–1). */
  voicedRatio: number | null;
}

export interface AudioAnalysisCoverage {
  transcriptAvailable: boolean;
  wordTimingAvailable: boolean;
  vadAvailable: boolean;
  prosodyAvailable: boolean;
}

export interface AudioAnalysis {
  version: string;
  /** Total recording duration (asset metadata when available, else decoded WAV). */
  durationMs: number;
  speechDurationMs: number | null;
  silenceDurationMs: number | null;
  /** Words per minute over the speech span (pauses INCLUDED). */
  speechRateWpm: number | null;
  /** Words per minute excluding pauses ≥ minPauseMs. */
  articulationRateWpm: number | null;
  pauseStats: PauseStats;
  fluency: FluencyFeatures;
  prosody: ProsodyFeatures | null;
  coverage: AudioAnalysisCoverage;
  warnings: string[];
}

export interface AudioAnalysisConfig {
  /** Gaps ≥ this (ms) between consecutive words count as pauses. */
  minPauseMs: number;
  shortPauseMaxMs: number;
  mediumPauseMaxMs: number;
  /** A silence ≥ this (ms) splits two "runs" of continuous speech. */
  runBreakMs: number;
  maxPausesKept: number;
  /** Words of before/after context kept per pause. */
  contextWords: number;
}

export const DEFAULT_AUDIO_ANALYSIS_CONFIG: AudioAnalysisConfig = {
  minPauseMs: 250,
  shortPauseMaxMs: 800,
  mediumPauseMaxMs: 2000,
  runBreakMs: 400,
  maxPausesKept: 40,
  contextWords: 4,
};

/**
 * Thresholds are configurable because they need validation against real
 * recordings; these env names keep deployments adjustable without code edits.
 */
export function audioAnalysisConfigFromEnv(env: Record<string, string | undefined> = process.env): AudioAnalysisConfig {
  const num = (v: string | undefined, dflt: number, lo: number, hi: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
  };
  const d = DEFAULT_AUDIO_ANALYSIS_CONFIG;
  return {
    minPauseMs: num(env.AUDIO_MIN_PAUSE_MS, d.minPauseMs, 100, 3000),
    shortPauseMaxMs: num(env.AUDIO_SHORT_PAUSE_MAX_MS, d.shortPauseMaxMs, 300, 1500),
    mediumPauseMaxMs: num(env.AUDIO_MEDIUM_PAUSE_MAX_MS, d.mediumPauseMaxMs, 800, 5000),
    runBreakMs: num(env.AUDIO_RUN_BREAK_MS, d.runBreakMs, 200, 2000),
    maxPausesKept: num(env.AUDIO_MAX_PAUSES_KEPT, d.maxPausesKept, 10, 200),
    contextWords: num(env.AUDIO_CONTEXT_WORDS, d.contextWords, 0, 10),
  };
}

// ------------------------------------------------------------- word timings
export interface WordTimingAnalysis {
  pauses: PauseInfo[];
  /** First word start → last word end. */
  spanMs: number;
  /** Span minus pauses ≥ minPauseMs. */
  speechMs: number;
  speechRateWpm: number;
  articulationRateWpm: number;
  /** Word counts of continuous runs split at gaps ≥ runBreakMs. */
  runs: number[];
  /** True when transcript tokens could be aligned 1:1 onto the word timings. */
  aligned: boolean;
}

/** Sentence-final token indices of the transcript, when alignable 1:1 with timings. */
function sentenceEndIndices(text: string, tokenCount: number): Set<number> {
  const tokens = tokenize(text);
  if (tokens.length !== tokenCount) return new Set();
  const ends = new Set<number>();
  let idx = 0;
  for (const sentence of text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean)) {
    idx += tokenize(sentence).length;
    if (idx > 0) ends.add(idx - 1);
  }
  return ends;
}

/**
 * Pause/rate/run analysis from REAL ASR word timestamps. No time averaging is
 * ever invented: if timings are missing the whole layer is skipped.
 */
export function analyzeWordTimings(words: WordTiming[], text: string, cfg: AudioAnalysisConfig): WordTimingAnalysis | null {
  const w = [...words].sort((a, b) => a.start - b.start).filter(
    (x) => Number.isFinite(x.start) && Number.isFinite(x.end) && x.end >= x.start,
  );
  if (w.length < 2) return null;

  const tokens = w.map((x) => x.word.toLowerCase());
  const sentenceEnds = sentenceEndIndices(text, tokens.length);
  const aligned = sentenceEnds.size > 0;

  const pauses: PauseInfo[] = [];
  const runBreaks: number[] = [0];
  for (let i = 1; i < w.length; i++) {
    const gapMs = (w[i].start - w[i - 1].end) * 1000;
    if (gapMs >= cfg.minPauseMs) {
      pauses.push({
        startMs: Math.round(w[i - 1].end * 1000),
        endMs: Math.round(w[i].start * 1000),
        durationMs: Math.round(gapMs),
        beforeText: tokens.slice(Math.max(0, i - cfg.contextWords), i).join(" ") || undefined,
        afterText: tokens.slice(i, i + cfg.contextWords).join(" ") || undefined,
        position: aligned
          ? sentenceEnds.has(i - 1) ? "sentence-boundary" : "mid-sentence"
          : "unknown",
      });
    }
    if (gapMs >= cfg.runBreakMs) runBreaks.push(i);
  }

  const spanMs = Math.round((w[w.length - 1].end - w[0].start) * 1000);
  const pauseMs = pauses.reduce((s, p) => s + p.durationMs, 0);
  const speechMs = Math.max(1, spanMs - pauseMs);
  const minutes = spanMs / 60000;
  const runs: number[] = [];
  for (let r = 0; r < runBreaks.length; r++) {
    const to = r + 1 < runBreaks.length ? runBreaks[r + 1] : w.length;
    runs.push(to - runBreaks[r]);
  }
  return {
    pauses,
    spanMs,
    speechMs,
    speechRateWpm: minutes > 0 ? Math.round((tokens.length / minutes)) : 0,
    articulationRateWpm: speechMs > 0 ? Math.round((tokens.length / speechMs) * 60000) : 0,
    runs,
    aligned,
  };
}

function summarizePauses(all: PauseInfo[], cfg: AudioAnalysisConfig): PauseStats {
  const sorted = [...all].sort((a, b) => b.durationMs - a.durationMs);
  const kept = sorted.slice(0, cfg.maxPausesKept);
  const byLength = { short: 0, medium: 0, long: 0 };
  for (const p of all) {
    if (p.durationMs >= cfg.mediumPauseMaxMs) byLength.long++;
    else if (p.durationMs >= cfg.shortPauseMaxMs) byLength.medium++;
    else byLength.short++;
  }
  const durations = all.map((p) => p.durationMs).sort((a, b) => a - b);
  const mean = all.length ? durations.reduce((s, v) => s + v, 0) / all.length : 0;
  const median = all.length ? durations[Math.floor(all.length / 2)] : 0;
  return { count: all.length, meanDurationMs: Math.round(mean), medianDurationMs: median, byLength, longPauseCount: byLength.long, pauses: kept };
}

// ------------------------------------------------------------- token features
/**
 * Fillers that are unambiguous hesitation sounds. "like", "kind of",
 * "sort of" are deliberately EXCLUDED (normal semantic uses dominate), and
 * "you know" is kept because IELTS descriptors treat it as a fluency filler.
 */
const PURE_FILLERS = ["um", "uh", "uhm", "erm", "er", "hmm", "ah"];
const PHRASE_FILLERS: string[] = ["you know"];
/** Immediate repeats that are emphasis, not hesitation. */
const EMPHASIS_REPEATS = new Set(["very", "really", "so", "no", "yeah", "yes", "okay", "ok", "bye", "never", "not"]);
/** Explicit repair markers: what follows is a re-phrasing. */
const REPAIR_MARKERS = ["or rather", "no wait", "or well", "sorry i mean"];

export interface TokenFeatures {
  fillerCount: number;
  fillers: string[];
  repetitionCount: number;
  repeatedPhrases: string[];
  selfCorrectionCount: number;
  selfCorrections: string[];
}

/**
 * Fluency events from the token stream. `pauseBefore[i]` (word index → gap
 * ms) is only available with word timings; without them "I mean" is never
 * counted as a filler/correction marker because its hesitation sense cannot
 * be distinguished from normal clarification ("…which I mean sincerely").
 */
export function analyzeTokenFeatures(tokens: string[], pauseBefore: Map<number, number> | null): TokenFeatures {
  const fillerCounts = new Map<string, number>();
  let fillerCount = 0;
  const addFiller = (name: string) => {
    fillerCounts.set(name, (fillerCounts.get(name) ?? 0) + 1);
    fillerCount++;
  };

  const lower = tokens.map((t) => t.toLowerCase());
  for (let i = 0; i < lower.length; i++) {
    if (PURE_FILLERS.includes(lower[i])) addFiller(lower[i]);
  }
  for (const phrase of PHRASE_FILLERS) {
    const parts = phrase.split(" ");
    let count = 0;
    for (let i = 0; i + parts.length <= lower.length; i++) {
      if (parts.every((p, j) => lower[i + j] === p)) count++;
    }
    if (count) {
      fillerCounts.set(phrase, (fillerCounts.get(phrase) ?? 0) + count);
      fillerCount += count;
    }
  }

  const repeats: string[] = [];
  let repetitionCount = 0;
  const corrections: string[] = [];
  let selfCorrectionCount = 0;
  const pushCorrection = (snippet: string) => {
    selfCorrectionCount++;
    if (corrections.length < 8) corrections.push(snippet);
  };
  for (let i = 0; i < lower.length; i++) {
    // Immediate single-word repeat ("I I", "the the") unless emphasis.
    if (i > 0 && lower[i] === lower[i - 1] && !EMPHASIS_REPEATS.has(lower[i])) {
      repetitionCount++;
      if (repeats.length < 8) repeats.push(`${lower[i - 1]} ${lower[i]}`);
    }
    // Immediate 2-gram restart ("I went I went") — a self-correction, not a repeat.
    if (i >= 2 && lower[i] === lower[i - 2] && lower[i - 1] === lower[i - 3] && lower[i] !== lower[i - 1]) {
      pushCorrection(lower.slice(i - 3, i + 1).join(" "));
    }
    // Repair markers.
    const pair = i >= 1 ? `${lower[i - 1]} ${lower[i]}` : "";
    if (REPAIR_MARKERS.includes(pair)) pushCorrection(pair);
    // "I mean" after a real pause is hesitation-led repair; otherwise it is
    // ordinary clarification and must not be penalised. The pause precedes
    // the "I", so the gap is looked up at index i−1.
    if (i >= 1 && pair === "i mean" && pauseBefore && (pauseBefore.get(i - 1) ?? 0) >= 400) {
      pushCorrection("i mean (after pause)");
    }
  }
  return {
    fillerCount,
    fillers: [...fillerCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}×${v}`),
    repetitionCount,
    repeatedPhrases: [...new Set(repeats)].slice(0, 8),
    selfCorrectionCount,
    selfCorrections: corrections,
  };
}

// ------------------------------------------------------------- fusion
export interface AudioAnalysisInput {
  /** Transcript text ("" when unavailable). */
  text: string;
  /** Asset duration in ms. */
  durationMs: number;
  /** ASR word timings when the provider supplied them. */
  words?: WordTiming[] | null;
  /** `pcm_wav` bytes (16 kHz mono PCM) when the asset exists. */
  wav?: Uint8Array | null;
}

/**
 * Build the unified analysis for one answer. Sources are combined honestly:
 * word timings drive pauses/rates/runs when present, VAD drives
 * speech/silence (and is the pause fallback), prosody only from WAV.
 */
export function buildAudioAnalysis(input: AudioAnalysisInput, cfg: AudioAnalysisConfig = DEFAULT_AUDIO_ANALYSIS_CONFIG): AudioAnalysis {
  const warnings: string[] = [];
  const transcriptAvailable = input.text.trim().length > 0;
  const wordsOk = Array.isArray(input.words) && input.words.length >= 2;
  const wordTimingAnalysis = wordsOk ? analyzeWordTimings(input.words!, input.text, cfg) : null;
  const wordTimingAvailable = wordTimingAnalysis !== null;

  let wavDurationMs: number | null = null;
  let vad: VadResult | null = null;
  let decodedWav: WavInfo | null = null;
  const haveWav = !!(input.wav && input.wav.byteLength > 44);
  if (input.wav && input.wav.byteLength > 44) {
    const decoded = decodeWavPcm16(input.wav);
    if (decoded.ok) {
      decodedWav = decoded.wav;
      wavDurationMs = decoded.wav.durationMs;
      vad = detectSpeech(decoded.wav.samples, decoded.wav.sampleRate, decoded.wav.durationMs);
      if (vad.lowSnr) warnings.push(`low SNR (${vad.snrDb?.toFixed(1)} dB) — VAD speech/silence unreliable`);
    } else {
      warnings.push(`WAV not decodable: ${decoded.reason}`);
    }
  } else {
    warnings.push("no decodable pcm_wav — VAD and prosody unavailable");
  }

  const durationMs = Math.max(input.durationMs || 0, wavDurationMs ?? 0, wordTimingAnalysis ? Math.round((input.words!.reduce((acc, x) => Math.max(acc, x.end), 0)) * 1000) : 0);

  // Pauses: word timings first, VAD speech gaps as fallback.
  const vadOk: VadResult | null = vad && vad.lowSnr === false ? vad : null;
  let pauses: PauseInfo[] = [];
  if (wordTimingAnalysis) {
    pauses = wordTimingAnalysis.pauses;
  } else if (vadOk && vadOk.segments.length >= 2) {
    for (let i = 1; i < vadOk.segments.length; i++) {
      const gapMs = vadOk.segments[i].startMs - vadOk.segments[i - 1].endMs;
      if (gapMs >= cfg.minPauseMs) {
        pauses.push({ startMs: vadOk.segments[i - 1].endMs, endMs: vadOk.segments[i].startMs, durationMs: Math.round(gapMs), position: "unknown" });
      }
    }
    if (!transcriptAvailable) warnings.push("pauses located by VAD only — no before/after text");
  }
  if (!wordTimingAnalysis) warnings.push("word timings unavailable — speech rate, runs and pause context degraded");

  const speechDurationMs = wordTimingAnalysis
    ? wordTimingAnalysis.speechMs
    : vadOk ? vadOk.speechMs : null;
  const silenceDurationMs = vadOk ? vadOk.silenceMs : null;

  // Rates: prefer word timings; fall back to tokens over VAD speech time.
  let speechRateWpm: number | null = wordTimingAnalysis?.speechRateWpm ?? null;
  let articulationRateWpm: number | null = wordTimingAnalysis?.articulationRateWpm ?? null;
  const tokens = wordsOk ? input.words!.map((x) => x.word.toLowerCase()) : transcriptAvailable ? tokenize(input.text) : [];
  if (speechRateWpm === null && vadOk && vadOk.speechMs > 3000 && tokens.length >= 5) {
    speechRateWpm = Math.round((tokens.length / vadOk.speechMs) * 60000);
    warnings.push("speech rate derived from VAD speech time (no word timings)");
  }
  if (articulationRateWpm === null && wordTimingAnalysis === null) {
    articulationRateWpm = null; // needs per-word gaps; VAD fallback cannot provide it honestly
  }

  const pauseBefore = new Map<number, number>();
  if (wordTimingAnalysis) {
    const w = [...input.words!].sort((a, b) => a.start - b.start);
    for (let i = 1; i < w.length; i++) {
      const gapMs = (w[i].start - w[i - 1].end) * 1000;
      if (gapMs >= cfg.runBreakMs) pauseBefore.set(i, Math.round(gapMs));
    }
  }
  const tokenFeatures = tokens.length ? analyzeTokenFeatures(tokens, pauseBefore) : null;
  if (!tokenFeatures) warnings.push(transcriptAvailable ? "transcript present but no tokens recognised" : "no transcript — lexical fluency events unavailable");

  const runs = wordTimingAnalysis?.runs ?? null;
  const meanLengthOfRun = runs && runs.length ? Math.round((tokens.length / runs.length) * 10) / 10 : null;
  const longestRun = runs && runs.length ? Math.max(...runs) : null;

  let prosody: ProsodyFeatures | null = null;
  if (decodedWav) {
    const p = analyzeProsody(decodedWav, vadOk);
    const hasPitch = p.f0MedianHz !== null;
    if (hasPitch || p.energyVariationDb !== null) {
      prosody = {
        pitchVariationHz: p.f0StdHz,
        pitchMedianHz: p.f0MedianHz,
        pitchRangeHz: p.f0RangeHz,
        energyVariationDb: p.energyVariationDb,
        voicedRatio: p.voicedRatio,
      };
    }
  }

  // A large mismatch between the stored duration and decoded WAV hints at
  // truncated uploads or bad metadata — surface it rather than guessing.
  if (input.durationMs > 500 && wavDurationMs !== null && Math.abs(input.durationMs - wavDurationMs) > 1500) {
    warnings.push(`duration mismatch: asset ${Math.round(input.durationMs)}ms vs decoded WAV ${wavDurationMs}ms`);
  }

  return {
    version: AUDIO_ANALYSIS_VERSION,
    durationMs,
    speechDurationMs,
    silenceDurationMs,
    speechRateWpm: speechRateWpm !== null && speechRateWpm > 0 ? speechRateWpm : null,
    articulationRateWpm: articulationRateWpm !== null && articulationRateWpm > 0 ? articulationRateWpm : null,
    pauseStats: summarizePauses(pauses, cfg),
    fluency: {
      meanLengthOfRun,
      longestRun,
      runCount: runs ? runs.length : null,
      fillerCount: tokenFeatures?.fillerCount ?? 0,
      fillers: tokenFeatures?.fillers ?? [],
      repetitionCount: tokenFeatures?.repetitionCount ?? 0,
      repeatedPhrases: tokenFeatures?.repeatedPhrases ?? [],
      selfCorrectionCount: tokenFeatures ? tokenFeatures.selfCorrectionCount : null,
      selfCorrections: tokenFeatures?.selfCorrections ?? [],
    },
    prosody,
    coverage: {
      transcriptAvailable,
      wordTimingAvailable,
      vadAvailable: vadOk !== null,
      prosodyAvailable: prosody !== null,
    },
    warnings: [...new Set(warnings)].slice(0, 12),
  };
}

// ------------------------------------------------------------- whole session
export interface SessionAudioInput {
  part: number;
  analysis: AudioAnalysis;
}

export interface SessionAudioAnalysis extends AudioAnalysis {
  perPart: {
    part: number;
    speechRateWpm: number | null;
    meanLengthOfRun: number | null;
    fillerCount: number;
    pauseCount: number;
    longPauseCount: number;
    selfCorrectionCount: number | null;
  }[];
}

/**
 * Whole-exam view: duration-weighted means, summed event counts and per-part
 * one-line summaries so the scorer can judge fluency across the whole test,
 * not just per answer.
 */
export function aggregateSessionAudio(items: SessionAudioInput[]): SessionAudioAnalysis | null {
  if (!items.length) return null;
  const weight = (a: AudioAnalysis) => a.speechDurationMs ?? a.durationMs;
  const wsum = items.reduce((s, it) => s + Math.max(1, weight(it.analysis)), 0);
  const wmean = (vals: (number | null)[]): number | null => {
    const pairs = items.map((it, i) => ({ v: vals[i], w: Math.max(1, weight(it.analysis)) })).filter((p) => p.v !== null);
    if (!pairs.length) return null;
    return Math.round((pairs.reduce((s, p) => s + (p.v as number) * p.w, 0) / pairs.reduce((s, p) => s + p.w, 0)) * 100) / 100;
  };
  const sums = (get: (a: AudioAnalysis) => number) => items.reduce((s, it) => s + get(it.analysis), 0);
  const pauses = items.flatMap((it) => it.analysis.pauseStats.pauses).sort((a, b) => b.durationMs - a.durationMs);

  const merged: AudioAnalysis = {
    version: AUDIO_ANALYSIS_VERSION,
    durationMs: sums((a) => a.durationMs),
    speechDurationMs: wmean(items.map((it) => it.analysis.speechDurationMs)),
    silenceDurationMs: wmean(items.map((it) => it.analysis.silenceDurationMs)),
    speechRateWpm: wmean(items.map((it) => it.analysis.speechRateWpm)),
    articulationRateWpm: wmean(items.map((it) => it.analysis.articulationRateWpm)),
    pauseStats: {
      count: sums((a) => a.pauseStats.count),
      meanDurationMs: wmean(items.map((it) => it.analysis.pauseStats.meanDurationMs)) ?? 0,
      medianDurationMs: wmean(items.map((it) => it.analysis.pauseStats.medianDurationMs)) ?? 0,
      byLength: {
        short: sums((a) => a.pauseStats.byLength.short),
        medium: sums((a) => a.pauseStats.byLength.medium),
        long: sums((a) => a.pauseStats.byLength.long),
      },
      longPauseCount: sums((a) => a.pauseStats.longPauseCount),
      pauses: pauses.slice(0, DEFAULT_AUDIO_ANALYSIS_CONFIG.maxPausesKept),
    },
    fluency: {
      meanLengthOfRun: wmean(items.map((it) => it.analysis.fluency.meanLengthOfRun)),
      longestRun: wmean(items.map((it) => it.analysis.fluency.longestRun)),
      runCount: sums((a) => a.fluency.runCount ?? 0) || null,
      fillerCount: sums((a) => a.fluency.fillerCount),
      fillers: [...items.flatMap((it) => it.analysis.fluency.fillers)].slice(0, 8),
      repetitionCount: sums((a) => a.fluency.repetitionCount),
      repeatedPhrases: [...new Set(items.flatMap((it) => it.analysis.fluency.repeatedPhrases))].slice(0, 8),
      selfCorrectionCount: sums((a) => a.fluency.selfCorrectionCount ?? 0),
      selfCorrections: [...new Set(items.flatMap((it) => it.analysis.fluency.selfCorrections))].slice(0, 8),
    },
    prosody: null,
    coverage: {
      transcriptAvailable: items.every((it) => it.analysis.coverage.transcriptAvailable),
      wordTimingAvailable: items.some((it) => it.analysis.coverage.wordTimingAvailable),
      vadAvailable: items.some((it) => it.analysis.coverage.vadAvailable),
      prosodyAvailable: items.some((it) => it.analysis.coverage.prosodyAvailable),
    },
    warnings: [...new Set(items.flatMap((it) => it.analysis.warnings))].slice(0, 12),
  };
  const perPartKeys = [...new Set(items.map((it) => it.part))].sort((a, b) => a - b);
  return {
    ...merged,
    // keep the merged pause list honest: the cap must reflect what is kept
    pauseStats: { ...merged.pauseStats, pauses: pauses.slice(0, DEFAULT_AUDIO_ANALYSIS_CONFIG.maxPausesKept) },
    perPart: perPartKeys.map((part) => {
      const rows = items.filter((it) => it.part === part);
      return {
        part,
        speechRateWpm: wmean(rows.map((r) => r.analysis.speechRateWpm)),
        meanLengthOfRun: wmean(rows.map((r) => r.analysis.fluency.meanLengthOfRun)),
        fillerCount: rows.reduce((s, r) => s + r.analysis.fluency.fillerCount, 0),
        pauseCount: rows.reduce((s, r) => s + r.analysis.pauseStats.count, 0),
        longPauseCount: rows.reduce((s, r) => s + r.analysis.pauseStats.longPauseCount, 0),
        selfCorrectionCount: rows.reduce((s, r) => s + (r.analysis.fluency.selfCorrectionCount ?? 0), 0),
      };
    }),
  };
}

// ------------------------------------------------------------- prompt text
/** One compact evidence line per answer — no band suggestions, evidence only. */
export function summarizeAnalysisForPrompt(index: number, part: number, a: AudioAnalysis): string {
  const s: string[] = [];
  s.push(`#${index} (Part ${part})`);
  s.push(`duration ${(a.durationMs / 1000).toFixed(1)}s`);
  if (a.speechDurationMs !== null) s.push(`speech ${(a.speechDurationMs / 1000).toFixed(1)}s`);
  if (a.silenceDurationMs !== null) s.push(`silence ${(a.silenceDurationMs / 1000).toFixed(1)}s`);
  if (a.speechRateWpm !== null) s.push(`speech rate ${a.speechRateWpm} wpm`);
  if (a.articulationRateWpm !== null) s.push(`articulation rate ${a.articulationRateWpm} wpm`);
  const p = a.pauseStats;
  s.push(`pauses ${p.count} (short ${p.byLength.short}, medium ${p.byLength.medium}, long ${p.byLength.long}; mean ${(p.meanDurationMs / 1000).toFixed(1)}s)`);
  if (a.fluency.meanLengthOfRun !== null) s.push(`mean run ${a.fluency.meanLengthOfRun} words (longest ${a.fluency.longestRun})`);
  s.push(`fillers ${a.fluency.fillerCount}${a.fluency.fillers.length ? ` [${a.fluency.fillers.join(", ")}]` : ""}`);
  s.push(`repeats ${a.fluency.repetitionCount}`);
  if (a.fluency.selfCorrectionCount !== null) s.push(`self-corrections ${a.fluency.selfCorrectionCount}${a.fluency.selfCorrections.length ? ` [${a.fluency.selfCorrections.join("; ")}]` : ""}`);
  if (a.prosody) {
    if (a.prosody.pitchVariationHz !== null) s.push(`pitch variation ${a.prosody.pitchVariationHz.toFixed(0)} Hz (median ${a.prosody.pitchMedianHz?.toFixed(0)} Hz, range ${a.prosody.pitchRangeHz?.toFixed(0)} Hz)`);
    if (a.prosody.energyVariationDb !== null) s.push(`energy variation ${a.prosody.energyVariationDb.toFixed(1)} dB`);
  }
  const cov = a.coverage;
  s.push(`availability: transcript ${cov.transcriptAvailable ? "yes" : "no"}, word timings ${cov.wordTimingAvailable ? "yes" : "no"}, VAD ${cov.vadAvailable ? "yes" : "no"}, prosody ${cov.prosodyAvailable ? "yes" : "no"}`);
  if (a.warnings.length) s.push(`warnings: ${a.warnings.join("; ")}`);
  return `- ${s.join("; ")}`;
}

/** Render the whole evidence block for the scoring prompt. */
export function formatAudioEvidenceBlock(
  perAnswer: { index: number; part: number; analysis: AudioAnalysis }[],
  session: SessionAudioAnalysis | null,
): string | null {
  if (!perAnswer.length) return null;
  const lines: string[] = [];
  if (session) {
    const p = session.pauseStats;
    lines.push(
      `WHOLE EXAM: duration ${(session.durationMs / 1000).toFixed(0)}s, speech rate ${session.speechRateWpm ?? "n/a"} wpm, ` +
      `pauses ${p.count} (long ≥2s: ${p.longPauseCount}), mean run ${session.fluency.meanLengthOfRun ?? "n/a"} words, ` +
      `fillers ${session.fluency.fillerCount}, repeats ${session.fluency.repetitionCount}, self-corrections ${session.fluency.selfCorrectionCount ?? "n/a"}` +
      (session.perPart.length ? `; per part: ${session.perPart.map((r) => `P${r.part} ${r.speechRateWpm ?? "n/a"} wpm/${r.pauseCount} pauses`).join(", ")}` : ""),
    );
  }
  for (const { index, part, analysis } of perAnswer) lines.push(summarizeAnalysisForPrompt(index, part, analysis));
  return lines.join("\n");
}
