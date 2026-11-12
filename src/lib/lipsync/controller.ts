"use client";
/**
 * Client-side lip-sync controller (singleton).
 *
 * Owns the ACTIVE viseme track and samples it against the REAL audio clock:
 *  - <audio> playback: time comes from `element.currentTime` every frame, so
 *    pause/resume/seek/speed changes are inherently respected and an aborted
 *    or finished audio naturally closes the mouth.
 *  - Browser speechSynthesis (no element): wall-clock sampling from utterance
 *    start, progressively corrected by `onboundary` word events — always
 *    labelled "approximate" (browser mode), never presented as exact.
 *
 * The controller never touches playback: speech.ts calls begin()/end() and the
 * avatar's RAF loop calls sample(). No React state, no timers of its own.
 */
import { emphasisFromChannels, jawFromChannels, sampleTrack, warpToRealTime } from "./timeline";
import { VISEME_CHANNELS, type VisemeTrack, type WarpedTrack, type WordSpan } from "./types";

export type PlaybackMode = "clip" | "stream" | "preset" | "browser";

export interface PlaybackBegin {
  mode: PlaybackMode;
  /** The exact text being spoken (track identity). */
  text: string;
  /** The live <audio> element, or null for browser speech synthesis. */
  element: HTMLAudioElement | null;
  /** Engine-measured word times in REAL seconds (Kokoro timestamps). */
  wordAnchors?: WordSpan[] | null;
  /** performance.now() when browser speech started (browser mode only). */
  startedAtWallMs?: number;
}

export interface LipSyncSample {
  /** 15 viseme channel weights, smoothed (index = VISEME_CHANNELS). */
  channels: Float32Array;
  /** Jaw openness 0..1 (viseme-driven, RMS-modulated by the caller). */
  jaw: number;
  /** Strongest channel weight — drives brow/head emphasis. */
  emphasis: number;
  /** Data quality of what is currently sampled. */
  tier: "anchored" | "normalized" | "rms";
  /** Current playback time used for sampling (seconds). */
  time: number;
}

const TRACK_CACHE_MAX = 48;
const trackCache = new Map<string, Promise<VisemeTrack | null>>();

/** Fetch the text-derived track (relative time). Deduped + LRU-cached. */
export function fetchVisemeTrack(text: string, lang = "en-GB"): Promise<VisemeTrack | null> {
  if (typeof window === "undefined" || !text.trim()) return Promise.resolve(null);
  const key = `${lang}\u0000${text}`;
  const hit = trackCache.get(key);
  if (hit) return hit;
  const p = (async () => {
    try {
      const res = await fetch("/api/lipsync/timeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, lang }),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { track?: VisemeTrack };
      return j.track ?? null;
    } catch {
      return null;
    }
  })();
  if (trackCache.size >= TRACK_CACHE_MAX) {
    const oldest = trackCache.keys().next().value;
    if (oldest !== undefined) trackCache.delete(oldest);
  }
  trackCache.set(key, p);
  return p;
}

class LipSyncController {
  private track: VisemeTrack | null = null;
  private warped: WarpedTrack | null = null;
  private element: HTMLAudioElement | null = null;
  private mode: PlaybackMode | null = null;
  private text = "";
  private wordAnchors: WordSpan[] | null = null;
  private browserStartedAt = 0;
  private browserOffset = 0;
  private browserBoundaries: { wordIndex: number; time: number }[] = [];

  readonly channels = new Float32Array(VISEME_CHANNELS.length);
  private readonly smoothed = new Float32Array(VISEME_CHANNELS.length);
  private smoothedJaw = 0;
  private smoothedEmphasis = 0;

  /** True while a playback this controller knows about is active. */
  active = false;

  /** Called by speech.ts when a playback actually starts making sound. */
  begin(ev: PlaybackBegin): void {
    this.active = true;
    this.mode = ev.mode;
    this.text = ev.text;
    this.element = ev.element ?? null;
    this.wordAnchors = ev.wordAnchors ?? null;
    this.warped = null;
    this.track = null;
    this.browserStartedAt = ev.startedAtWallMs ?? performance.now();
    this.browserOffset = 0;
    this.browserBoundaries = [];
    this.smoothed.fill(0);
    if (ev.text.trim()) {
      void fetchVisemeTrack(ev.text).then((track) => {
        if (this.active && track && track.text === this.text) this.setTrack(track);
      });
    }
  }

  /** Attach a (possibly late-arriving) relative track. */
  setTrack(track: VisemeTrack): void {
    this.track = track;
    this.warped = null; // re-warp with whatever clock info we have
  }

  /** Called by speech.ts when the playback ends / is aborted / fails. */
  end(): void {
    this.active = false;
    this.element = null;
    this.mode = null;
    this.wordAnchors = null;
  }

  /** Engine word boundary (browser mode): correct the drift progressively. */
  onBrowserBoundary(wordIndex: number, wallTimeSec: number): void {
    if (this.mode !== "browser" || !this.warped) return;
    this.browserBoundaries.push({ wordIndex, time: wallTimeSec });
    // Piecewise re-anchor once we have at least two measured words.
    const pts = this.browserBoundaries;
    if (pts.length >= 2) {
      const words = this.warped.words;
      const anchors: WordSpan[] = [];
      for (let i = 0; i < words.length; i++) {
        const measured = pts.filter((p) => p.wordIndex === i).pop();
        const nextMeasured = pts.find((p) => p.wordIndex > i);
        const start = measured?.time ?? nextMeasured?.time ?? null;
        const prevMeasured = [...pts].reverse().find((p) => p.wordIndex < i);
        if (start !== null) {
          const next = words[i + 1];
          const est = next ? Math.max(0.08, next.start - words[i].start) : Math.max(0.12, words[i].end - words[i].start);
          const end = measured ? measured.time + est : start + est;
          anchors.push({ word: words[i].word, start, end, index: i });
        } else if (prevMeasured) {
          anchors.push({ word: words[i].word, start: prevMeasured.time, end: prevMeasured.time + 0.12, index: i });
        } else {
          anchors.push({ word: words[i].word, start: words[i].start, end: words[i].end, index: i });
        }
      }
      const relative = this.track;
      if (relative) {
        // Warp the RELATIVE track with browser-measured anchors (real seconds).
        this.warped = warpToRealTime(relative, { realDuration: this.warped.realDuration, wordAnchors: anchors });
      }
    }
  }

  /** One RAF sample. `rms` modulates the jaw on top of the viseme target. */
  sample(rms: number, nowWallMs: number): LipSyncSample {
    const target = this.channels;
    let tier: LipSyncSample["tier"] = "rms";
    let time = 0;

    if (this.active && this.track) {
      const el = this.element;
      if (el && this.mode !== "browser") {
        const dur = el.duration;
        if (!this.warped && Number.isFinite(dur) && dur > 0) {
          this.warped = warpToRealTime(this.track, {
            realDuration: dur,
            wordAnchors: this.wordAnchors,
          });
        }
        if (this.warped) {
          time = el.currentTime;
          tier = this.wordAnchors ? "anchored" : "normalized";
        }
      } else if (this.mode === "browser") {
        if (!this.warped) {
          // Estimated duration: ~14 chars/second of speech, clamped.
          const est = Math.max(1, Math.min(60, (this.text.length / 14) * 1));
          this.warped = warpToRealTime(this.track, { realDuration: est });
        }
        time = Math.max(0, (nowWallMs - this.browserStartedAt) / 1000 - this.browserOffset);
        tier = "normalized"; // browser mode is always approximate
      }
      if (this.warped) {
        sampleTrack(this.warped, time, target);
      }
    } else {
      target.fill(0);
    }

    // Smooth channels: gentle attack, slower release — real jaws never snap.
    for (let i = 0; i < this.smoothed.length; i++) {
      const t = target[i];
      const s = this.smoothed[i];
      this.smoothed[i] = s + (t - s) * (t > s ? 0.4 : 0.18);
    }
    const visemeJaw = jawFromChannels(this.smoothed);
    const emphasis = emphasisFromChannels(this.smoothed);
    // RMS adds organic micro-variation on top of the content-driven opening.
    const jawTarget = this.active ? Math.min(1, visemeJaw * 0.72 + Math.min(0.1, rms * 0.18)) : 0;
    this.smoothedJaw += (jawTarget - this.smoothedJaw) * (jawTarget > this.smoothedJaw ? 0.5 : 0.16);
    this.smoothedEmphasis += (emphasis - this.smoothedEmphasis) * 0.15;

    return {
      channels: this.smoothed,
      jaw: this.smoothedJaw,
      emphasis: this.smoothedEmphasis,
      tier: this.active ? tier : "rms",
      time,
    };
  }

  /** Debug info for the Lip Sync lab page. */
  debug(): { text: string; mode: PlaybackMode | null; hasTrack: boolean; warped: boolean } {
    return { text: this.text, mode: this.mode, hasTrack: !!this.track, warped: !!this.warped };
  }
}

export const lipSync = new LipSyncController();
