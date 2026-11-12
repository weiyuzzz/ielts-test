/**
 * Live amplitude of the examiner's voice, for mouth movement.
 *
 * The mouth should follow what is actually being said, so we measure the real
 * audio instead of guessing: the playing <audio> element is routed through an
 * AnalyserNode and its RMS is returned. Two safety rules keep this from ever
 * being able to break playback:
 *
 *  1. We never create a MediaElementSource while the AudioContext is not
 *     running — routing a playing element into a suspended graph would silence it.
 *  2. Any failure disables the meter permanently and returns -1; the caller then
 *     falls back to a syllable-paced mouth, and the audio is untouched.
 *
 * Browser speech synthesis has no audio element, so it also returns -1.
 */
import { currentAudioElement } from "./speech";

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let samples: Float32Array<ArrayBuffer> | null = null;
const sources = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>();
let disabled = false;

function ensureContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) { disabled = true; return null; }
  try {
    ctx = new Ctor();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    analyser.connect(ctx.destination); // pass-through: silence would be fatal
    samples = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
    return ctx;
  } catch {
    disabled = true;
    return null;
  }
}

/** Create/resume the context inside a user gesture (exam start button). */
export function primeEnvelope(): void {
  const c = ensureContext();
  if (c && c.state === "suspended") void c.resume().catch(() => {});
}

/**
 * Current loudness 0..1, or -1 when the meter is unavailable (browser voice,
 * suspended context, unsupported browser). Never throws.
 */
export function examinerEnvelope(): number {
  if (disabled) return -1;
  const el = currentAudioElement();
  if (!el || el.paused || el.ended) return -1;
  const c = ensureContext();
  if (!c || !analyser || !samples) return -1;
  if (c.state !== "running") {
    void c.resume().catch(() => {});
    return -1;
  }
  if (!sources.has(el)) {
    try {
      const src = c.createMediaElementSource(el);
      src.connect(analyser);
      sources.set(el, src);
    } catch {
      disabled = true;
      return -1;
    }
  }
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  // Speech RMS sits around 0.02–0.15; scale it into a usable 0..1 range.
  return Math.min(1, rms * 4);
}
