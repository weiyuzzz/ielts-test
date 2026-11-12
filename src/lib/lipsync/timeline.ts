/**
 * Viseme timeline: construction, warping and sampling. Pure functions, no DOM,
 * no Three.js — fully unit-testable (see __tests__/timeline.test.ts).
 *
 * Three stages:
 *   1. buildRelativeTrack  text+phonemes → frames in RELATIVE seconds
 *   2. warpToRealTime      relative → the REAL audio element's clock, using
 *                          (best first) word anchors measured by the engine,
 *                          else a global scale to the real duration
 *   3. sampleTrack         time → 15 viseme channel weights (0..1)
 *
 * The playback code must always drive stage 2/3 from the actual audio clock
 * (audio.currentTime), never from a free-running timer.
 */
import {
  type TrackTier, type Viseme, type VisemeFrame, type VisemeTrack, type WarpedTrack, type WordSpan,
  visemeIndex,
} from "./types";
import {
  BASE_DURATION_MS, MISAKI_PHONEMES, VOWEL_VISUMES, punctuationPauseMs, tokenizeMisaki, type VisemeStep,
} from "./viseme-map";
import { tokenizeFromLetters } from "./letter-g2p";

/** One word of source text with its phoneme token (from G2P). */
export interface PhonemeWord {
  word: string;
  /** misaki-style phoneme string, or "" to fall back to letter-driven visemes. */
  phonemes: string;
}

export interface BuildTrackOptions {
  lang?: string;
  tier?: TrackTier;
  source?: VisemeTrack["source"];
  /** Extra silence prepended before the first frame (relative seconds). */
  leadIn?: number;
}

const MIN_FRAME_S = 0.03;

/**
 * Build a relative-time track. Phonemes become one or more viseme frames
 * (diphthongs glide across two); words get spans so a later warp can align
 * them to engine-measured timestamps.
 */
export function buildRelativeTrack(words: PhonemeWord[], opts: BuildTrackOptions = {}): VisemeTrack {
  const frames: VisemeFrame[] = [];
  const spans: WordSpan[] = [];
  let t = Math.max(0, opts.leadIn ?? 0);
  words.forEach((pw, wordIndex) => {
    const start = t;
    const symbols = pw.phonemes ? tokenizeMisaki(pw.phonemes) : tokenizeFromLetters(pw.word);
    for (const sym of symbols) {
      const steps = MISAKI_PHONEMES[sym] ?? letterStep(sym) ?? (sym === "?" ? [{ viseme: "E" as Viseme, share: 1, weight: 0.3 }] : null);
      if (!steps) continue;
      // Each step lasts its viseme's base duration × its share of the phoneme.
      for (const st of steps as VisemeStep[]) {
        const d = Math.max(MIN_FRAME_S, (BASE_DURATION_MS[st.viseme] * st.share) / 1000);
        frames.push({ t, d, viseme: st.viseme, intensity: st.weight ?? 1, wordIndex });
        t += d;
      }
    }
    // Punctuation may ride on the word text or on the phoneme token.
    const pause = Math.max(punctuationPauseMs(pw.word), punctuationPauseMs(pw.phonemes)) / 1000;
    if (pause > 0) {
      frames.push({ t, d: pause, viseme: "sil", intensity: 0, wordIndex });
      t += pause;
    }
    // Guarantee a minimum span so degenerate words still anchor sanely.
    const end = Math.max(t, start + MIN_FRAME_S);
    spans.push({ word: pw.word, start, end, index: wordIndex });
    t = end;
  });
  return {
    frames,
    words: spans,
    duration: t,
    tier: opts.tier ?? "normalized",
    lang: opts.lang ?? "en-GB",
    text: words.map((w) => w.word).join(" "),
    source: opts.source ?? "misaki",
  };
}

/** "#aa"-style symbols produced by the letter fallback map directly to visemes. */
function letterStep(sym: string): VisemeStep[] | null {
  if (!sym.startsWith("#")) return null;
  const v = sym.slice(1) as Viseme;
  return BASE_DURATION_MS[v] ? [{ viseme: v, share: 1, weight: 0.85 }] : null;
}

// ---------------------------------------------------------------------------
// Warping
// ---------------------------------------------------------------------------

export interface WarpOptions {
  /** Real duration of the audio (seconds), e.g. audioElement.duration. */
  realDuration: number;
  /** Word times measured by the actual engine, in REAL seconds. */
  wordAnchors?: WordSpan[] | null;
  /** Strip a known leading silence before scaling (seconds). */
  audioLeadIn?: number;
}

/**
 * Warp a relative track onto the real audio clock.
 *  - With word anchors: piecewise-linear per-word warping (absorbs prosody
 *    differences word by word instead of letting drift accumulate).
 *  - Without: uniform scale so the last frame ends at realDuration.
 * Never throws; a degenerate input falls back to the global scale.
 */
export function warpToRealTime(track: VisemeTrack, opts: WarpOptions): WarpedTrack {
  const real = Number.isFinite(opts.realDuration) && opts.realDuration > 0 ? opts.realDuration : track.duration;
  const lead = Math.max(0, Math.min(opts.audioLeadIn ?? 0, real * 0.25));
  const usable = Math.max(0.05, real - lead);
  const scale = usable / Math.max(0.05, track.duration);

  const anchors = opts.wordAnchors && track.words.length &&
    opts.wordAnchors.length === track.words.length ? opts.wordAnchors : null;
  if (!anchors) {
    return warpLinear(track, (t) => lead + t * scale, real, null);
  }

  // Piecewise warp: every frame is mapped WITHIN its own word's window (both
  // endpoints interpolate into the engine-measured span), so real gaps between
  // anchors become mouth-closed silence and prosody drift is absorbed word by
  // word instead of accumulating. Unsegmented frames fall back to the scale.
  const relWords = track.words;
  const mapFrame = (f: VisemeFrame): [number, number] => {
    const i = f.wordIndex;
    if (i < 0 || i >= anchors.length) return [lead + f.t * scale, lead + (f.t + f.d) * scale];
    const rw = relWords[i];
    const aw = anchors[i];
    const rwSpan = Math.max(0.02, rw.end - rw.start);
    const awSpan = Math.max(0.02, aw.end - aw.start);
    const inWord = (t: number) => aw.start + Math.max(0, Math.min(1, (t - rw.start) / rwSpan)) * awSpan;
    return [inWord(f.t), inWord(f.t + f.d)];
  };

  const frames: VisemeFrame[] = [];
  for (const f of track.frames) {
    const [t0, t1] = mapFrame(f);
    const d = Math.max(0.012, t1 - t0);
    const prev = frames[frames.length - 1];
    if (prev && prev.t + prev.d > t0) prev.d = Math.max(0.012, t0 - prev.t);
    frames.push({ ...f, t: t0, d });
  }
  const realWords: WordSpan[] = anchors.map((a) => ({ ...a }));
  return { ...track, frames, realDuration: real, realWords };
}

function warpLinear(track: VisemeTrack, map: (t: number) => number, real: number, realWords: WordSpan[] | null): WarpedTrack {
  const frames: VisemeFrame[] = [];
  for (const f of track.frames) {
    const t0 = map(f.t);
    const t1 = map(f.t + f.d);
    const d = Math.max(0.012, t1 - t0);
    const prev = frames[frames.length - 1];
    if (prev && prev.t + prev.d > t0) prev.d = Math.max(0.012, t0 - prev.t); // keep frames sorted, no overlap
    frames.push({ ...f, t: t0, d });
  }
  return { ...track, frames, realDuration: real, realWords };
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

export interface SampleOptions {
  /** Crossfade window at frame edges (seconds) to avoid mouth snapping. */
  edgeBlend?: number;
}

/**
 * Sample the track at `timeSec` (REAL audio seconds) into `out` (length 15,
 * indexed by VISEME_CHANNELS). Membership is 1 inside a frame and crossfades
 * over `edgeBlend` on both sides, so neighbouring frames blend into each other
 * and `sil` frames close the mouth gradually.
 */
export function sampleTrack(track: WarpedTrack, timeSec: number, out: Float32Array, opts: SampleOptions = {}): void {
  out.fill(0);
  const frames = track.frames;
  if (!frames.length) return;
  const blend = Math.max(0.012, opts.edgeBlend ?? 0.032);
  for (const f of frames) {
    const end = f.t + f.d;
    if (f.t > timeSec + blend) break; // sorted → nothing further can contribute
    if (end < timeSec - blend) continue;
    let w = 1;
    if (timeSec < f.t) w = Math.min(w, Math.max(0, 1 - (f.t - timeSec) / blend));
    if (timeSec > end) w = Math.min(w, Math.max(0, 1 - (timeSec - end) / blend));
    if (w <= 0 || f.viseme === "sil") continue;
    const weight = Math.max(0, Math.min(1, w * f.intensity));
    const idx = visemeIndex(f.viseme);
    out[idx] = Math.max(out[idx], weight);
  }
}

/** Jaw openness 0..1 from sampled channels (vowels open, consonants barely). */
export function jawFromChannels(ch: Float32Array): number {
  let jaw = 0;
  for (const v of VOWEL_VISUMES) jaw = Math.max(jaw, ch[visemeIndex(v)]);
  for (const v of ["DD", "nn", "RR", "TH", "SS", "CH", "kk", "FF"] as Viseme[]) {
    jaw = Math.max(jaw, ch[visemeIndex(v)] * 0.35);
  }
  return Math.min(1, jaw);
}

/** Largest channel weight (for emphasis-driven brow/head motion). */
export function emphasisFromChannels(ch: Float32Array): number {
  let m = 0;
  for (let i = 1; i < ch.length; i++) m = Math.max(m, ch[i]);
  return m;
}
