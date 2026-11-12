"use client";
/**
 * Client speech services: examiner TTS (server or browser) and browser ASR (Web Speech API).
 *
 * Latency strategy
 * ----------------
 * All synthesis is owned by ONE priority scheduler (./tts-scheduler.ts). The
 * setup screen queues the whole script at BACKGROUND/LOW priority; the line
 * being played is promoted to CURRENT and the next question to NEXT. A live
 * playback NEVER waits behind a background POST warm-up — it goes straight to
 * the progressive GET stream, which the server no longer blocks on prefetch.
 *
 * Playback has an explicit lifecycle (./audio-lifecycle.ts): loading → ready →
 * playing → ended | interrupted | failed. An abort is NOT a completed play and
 * a truncated stream is NOT a completed play, so the exam can never advance on
 * a broken examiner voice. One PlaybackGuard owns the single live <audio>.
 */
import { TtsScheduler, TTS_PRIORITY, ttsTaskKey, type TtsPriority, type TtsTaskSnapshot } from "./tts-scheduler";
import { AudioLifecycle, PlaybackGuard, outcomeOf, type PlaybackOutcome } from "./audio-lifecycle";
import { audioMetrics, installDevTrace, type AudioSource } from "./metrics";

export { TTS_PRIORITY } from "./tts-scheduler";
export type { TtsPriority, TtsTaskSnapshot } from "./tts-scheduler";
export { audioMetrics } from "./metrics";

type SR = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

export function browserAsrSupported() {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
}

/** Continuous Web Speech recognition that auto-restarts (Chrome stops after silences). */
export class BrowserTranscriber {
  private rec: SR | null = null;
  private finals: string[] = [];
  private interim = "";
  private active = false;
  error: string | null = null;
  onUpdate?: (text: string) => void;

  start() {
    const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
    const C = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!C) {
      this.error = "unsupported";
      return;
    }
    this.active = true;
    this.finals = [];
    const make = () => {
      const r = new C();
      r.lang = "en-GB";
      r.continuous = true;
      r.interimResults = true;
      r.onresult = (e) => {
        this.interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          if (res.isFinal) this.finals.push(res[0].transcript.trim());
          else this.interim += res[0].transcript;
        }
        this.onUpdate?.(this.text());
      };
      r.onerror = (e) => {
        if (e.error !== "no-speech" && e.error !== "aborted") this.error = e.error;
      };
      r.onend = () => {
        if (this.active && !this.error) {
          try {
            this.rec = make();
            this.rec.start();
          } catch { /* ignore */ }
        }
      };
      return r;
    };
    try {
      this.rec = make();
      this.rec.start();
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  text() {
    return [...this.finals, this.interim.trim()].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  /** Stop and wait briefly for trailing final results. */
  async stop(): Promise<string> {
    this.active = false;
    const r = this.rec;
    if (r) {
      await new Promise<void>((res) => {
        const t = setTimeout(res, 1200);
        r.onend = () => {
          clearTimeout(t);
          res();
        };
        try {
          r.stop();
        } catch {
          res();
        }
      });
    }
    const out = this.text();
    if (out && !/[.!?]$/.test(out)) return out + ".";
    return out;
  }
}

// ------------------------------------------------------------------ browser voice (fallback)
let voicesCache: SpeechSynthesisVoice[] = [];
let voicesPromise: Promise<SpeechSynthesisVoice[]> | null = null;

/** Warm the voice list before the first line is spoken (avoids a ~1.5 s first-call stall). */
export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return Promise.resolve([]);
  const immediate = speechSynthesis.getVoices();
  if (immediate.length) {
    voicesCache = immediate;
    return Promise.resolve(immediate);
  }
  if (voicesPromise) return voicesPromise;
  voicesPromise = new Promise((res) => {
    let settled = false;
    const settle = (list: SpeechSynthesisVoice[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      speechSynthesis.removeEventListener("voiceschanged", onChanged);
      voicesCache = list;
      res(list);
    };
    const onChanged = () => {
      const list = speechSynthesis.getVoices();
      if (list.length) settle(list);
    };
    const t = setTimeout(() => settle(speechSynthesis.getVoices()), 1200);
    speechSynthesis.addEventListener("voiceschanged", onChanged);
    setTimeout(onChanged, 0);
  });
  return voicesPromise;
}

export function warmupSpeech(): void {
  if (typeof window === "undefined") return;
  void loadVoices();
  installDevTrace();
}

function voiceScore(v: SpeechSynthesisVoice, pref: string): number {
  let s = 0;
  const lang = v.lang?.toLowerCase() ?? "";
  const name = v.name ?? "";
  if (pref && pref !== "auto" && name === pref) s += 100;
  if (lang.startsWith("en-gb")) s += 30;
  else if (lang.startsWith("en")) s += 10;
  if (/natural|neural|online/i.test(name)) s += 45;
  if (v.localService === false) s += 15;
  if (/google|microsoft|sonia|ryan|libby|daniel|serena|siri/i.test(name)) s += 8;
  return s;
}

function pickVoice(pref: string): SpeechSynthesisVoice | undefined {
  const all = voicesCache.length ? voicesCache : (typeof window !== "undefined" && "speechSynthesis" in window ? speechSynthesis.getVoices() : []);
  const en = all.filter((v) => v.lang?.toLowerCase().startsWith("en"));
  const pool = en.length ? en : all;
  return pool.map((v) => ({ v, score: voiceScore(v, pref) })).sort((a, b) => b.score - a.score)[0]?.v;
}

// ------------------------------------------------------------------ server TTS clip cache
export interface Clip { url: string; audio: HTMLAudioElement }

/** Model/format identity — set from /api/config so a config change never reuses old audio. */
let ttsModel = "auto";
let ttsFormat = "default";
export function configureTtsIdentity(model?: string | null, format?: string | null): void {
  ttsModel = model || "browser";
  ttsFormat = format || "default";
}

export const keyOf = (text: string, voice: string) => ttsTaskKey({ text, voice, model: ttsModel, format: ttsFormat });
const ttsStreamUrl = (text: string, voice: string) => `/api/tts?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(voice)}`;

let liveAudio: HTMLAudioElement | null = null;
const stopLiveAudio = () => {
  if (liveAudio) {
    try { liveAudio.pause(); } catch { /* ignore */ }
    liveAudio = null;
  }
  if (typeof window !== "undefined" && "speechSynthesis" in window) speechSynthesis.cancel();
};
const guard = new PlaybackGuard(stopLiveAudio);

/** POST warm-up. Honours the scheduler's AbortSignal so a live GET can cancel it. */
async function fetchClip(text: string, voice: string, signal?: AbortSignal): Promise<Clip | null> {
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-TTS-Priority": "prefetch" },
      body: JSON.stringify({ text, voice }),
      cache: "no-store",
      signal,
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.size) return null;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.preload = "auto";
    audio.load(); // decode ahead of time → no startup gap at play()
    return { url, audio };
  } catch {
    return null;
  }
}

const releaseClip = (c: Clip) => {
  try { c.audio.pause(); } catch { /* ignore */ }
  URL.revokeObjectURL(c.url);
};

export const ttsScheduler = new TtsScheduler<Clip>({
  run: (task, signal) => {
    const t0 = performance.now();
    return fetchClip(task.text, task.voice, signal).then((clip) => {
      audioMetrics.record("tts_synthesis_ms", performance.now() - t0, "cache-miss", task.text.slice(0, 48));
      audioMetrics.record("audio_download_ms", performance.now() - t0, "cache-miss", task.text.slice(0, 48));
      return clip;
    });
  },
  maxParallel: 2,
  maxCache: 60,
  release: releaseClip,
});

/** Prefetch one line. Returns a promise + live status (void-returning legacy callers still work). */
export function prefetchTTSWithPriority(text: string, voice: string, serverTts: boolean, priority: TtsPriority) {
  if (!serverTts || !text.trim() || typeof window === "undefined") {
    return { key: keyOf(text, voice), promise: Promise.resolve(null), ready: () => false, status: () => "cancelled" as const, promote: () => {}, cancel: () => {} };
  }
  return ttsScheduler.request({ text, voice, model: ttsModel, format: ttsFormat }, priority);
}

/** Legacy signature kept: `priority=true` means NEXT, otherwise BACKGROUND. */
export function prefetchTTS(text: string, voice: string, serverTts: boolean, priority = false): void {
  void prefetchTTSWithPriority(text, voice, serverTts, priority ? TTS_PRIORITY.NEXT : TTS_PRIORITY.BACKGROUND).promise;
}

/** Queue the whole script. Repeat forms and no-response backups are LOW priority. */
export function prefetchManyTTSWithPriorities(
  entries: { text: string; priority: TtsPriority }[],
  voice: string,
  serverTts: boolean,
): void {
  if (!serverTts || typeof window === "undefined") return;
  const seen = new Set<string>();
  for (const e of entries) {
    if (!e.text?.trim() || seen.has(e.text)) continue;
    seen.add(e.text);
    void prefetchTTSWithPriority(e.text, voice, true, e.priority).promise;
  }
}

/** Legacy signature kept for compatibility. */
export function prefetchManyTTS(lines: string[], voice: string, serverTts: boolean): void {
  prefetchManyTTSWithPriorities(lines.map((text) => ({ text, priority: TTS_PRIORITY.BACKGROUND })), voice, serverTts);
}

/** Promote a queued line to CURRENT when playback is about to start. */
export function promoteTTS(text: string, voice: string): void {
  ttsScheduler.promote(keyOf(text, voice), TTS_PRIORITY.CURRENT);
}

export function waitForTTS(text: string, voice: string, timeoutMs = 15000): Promise<Clip | null> {
  const key = keyOf(text, voice);
  const req = ttsScheduler.request({ text, voice, model: ttsModel, format: ttsFormat }, TTS_PRIORITY.CURRENT);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    req.promise,
    new Promise<null>((r) => { timer = setTimeout(() => r(null), timeoutMs); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

export function subscribeTts(fn: (s: TtsTaskSnapshot[]) => void): () => void {
  return ttsScheduler.subscribe(fn);
}
export function ttsSnapshot(): TtsTaskSnapshot[] {
  return ttsScheduler.snapshotAll();
}

// ------------------------------------------------------------------ playback primitives
function bindAudio(audio: HTMLAudioElement, signal: AbortSignal | undefined, lifecycle: AudioLifecycle, source: AudioSource): Promise<PlaybackOutcome> {
  return new Promise((resolve) => {
    let done = false;
    let started = false;
    const t0 = performance.now();
    const finish = (status: "ended" | "interrupted" | "failed", opts: { partial?: boolean; aborted?: boolean } = {}) => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      try { audio.pause(); } catch { /* ignore */ }
      audio.onended = null;
      audio.onerror = null;
      audio.onplaying = null;
      signal?.removeEventListener("abort", onAbort);
      if (status === "interrupted") lifecycle.send("INTERRUPT");
      else if (status === "failed") lifecycle.send("FAIL");
      else lifecycle.send("END");
      const via = source;
      resolve(outcomeOf(status, via, opts));
    };
    const onAbort = () => finish("interrupted", { aborted: true });
    const watchdog = setTimeout(() => { if (!started) finish("failed", { aborted: signal?.aborted }); }, 15000);

    audio.onplaying = () => {
      if (started) return;
      started = true;
      clearTimeout(watchdog);
      lifecycle.send("PLAY");
      audioMetrics.record("playback_start_delay_ms", performance.now() - t0, source);
      audioMetrics.record("audio_ready_ms", performance.now() - t0, source);
    };
    audio.onended = () => finish("ended");
    // A stream that breaks AFTER audio already started is a FAILURE (partial),
    // never a normal completion. Callers must not replay it or advance on it.
    audio.onerror = () => finish("failed", { partial: started, aborted: signal?.aborted });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    void audio.play().catch(() => finish("failed", { aborted: signal?.aborted }));
  });
}

function playClip(clip: Clip, signal?: AbortSignal): Promise<PlaybackOutcome> {
  const audio = clip.audio;
  liveAudio = audio;
  const lifecycle = new AudioLifecycle("tts-clip");
  lifecycle.send("LOAD");
  lifecycle.send("READY");
  lifecycle.subscribe((s, prev) => audioMetrics.recordState("tts-clip", s, prev));
  try { audio.currentTime = 0; } catch { /* not seekable yet */ }
  return bindAudio(audio, signal, lifecycle, "cache-hit");
}

/** Progressive playback: audio starts at the first sentence the engine produces. */
function playStream(text: string, voice: string, signal?: AbortSignal): Promise<PlaybackOutcome> {
  const audio = new Audio(ttsStreamUrl(text, voice));
  audio.preload = "auto";
  liveAudio = audio;
  const lifecycle = new AudioLifecycle("tts-stream");
  lifecycle.send("LOAD");
  lifecycle.subscribe((s, prev) => audioMetrics.recordState("tts-stream", s, prev));
  return bindAudio(audio, signal, lifecycle, "stream");
}

/** Pre-recorded bank audio, played through the SAME single-owner guard. */
export function speakPreset(url: string, signal?: AbortSignal): Promise<PlaybackOutcome> {
  const key = `preset:${url}`;
  const begun = guard.begin(key);
  if (!begun) return Promise.resolve(outcomeOf("interrupted", "preset", { aborted: false }));
  const src = presetUrl(url);
  const audio = new Audio(src);
  audio.preload = "auto";
  liveAudio = audio;
  const lifecycle = new AudioLifecycle("preset");
  lifecycle.send("LOAD");
  lifecycle.send("READY");
  lifecycle.subscribe((s, prev) => audioMetrics.recordState("preset", s, prev));
  return bindAudio(audio, signal, lifecycle, "preset").then((o) => {
    guard.finish(begun.generation, key);
    return o;
  });
}

// ------------------------------------------------------------------ preset audio preloading
const presetCache = new Map<string, Promise<string>>();
const presetObjectUrls = new Map<string, string>();

/** Download questionAudioUrl ahead of time; returns the (possibly blob) URL. */
export function preloadPresetAudio(url: string): Promise<string> {
  const existing = presetCache.get(url);
  if (existing) return existing;
  const p = (async () => {
    const t0 = performance.now();
    try {
      const res = await fetch(url, { cache: "force-cache" });
      if (!res.ok) return url;
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      presetObjectUrls.set(url, objectUrl);
      audioMetrics.record("audio_download_ms", performance.now() - t0, "preset", url.slice(0, 64));
      return objectUrl;
    } catch {
      audioMetrics.record("audio_download_ms", performance.now() - t0, "preset", "failed");
      return url;
    }
  })();
  presetCache.set(url, p);
  return p;
}

function presetUrl(url: string): string {
  return presetObjectUrls.get(url) ?? url;
}

// ------------------------------------------------------------------ speak
export interface SpeakOptions {
  serverTts: boolean;
  voice: string;
  signal?: AbortSignal;
}
export interface SpeakResult {
  ok: boolean;
  via: string;
  /** Explicit lifecycle outcome — never conflates interrupted/failed with ended. */
  outcome: PlaybackOutcome;
}

/** Dedup: two concurrent requests for the same line join ONE playback. */
const activeSpeaks = new Map<string, Promise<SpeakResult>>();

export function speak(text: string, opts: SpeakOptions): Promise<SpeakResult> {
  const key = keyOf(text, opts.voice);
  const existing = activeSpeaks.get(key);
  if (existing) return existing;
  const p = doSpeak(text, opts, key).finally(() => activeSpeaks.delete(key));
  activeSpeaks.set(key, p);
  return p;
}

async function doSpeak(text: string, opts: SpeakOptions, key: string): Promise<SpeakResult> {
  if (!text.trim()) return { ok: true, via: "none", outcome: outcomeOf("ended", "none") };
  const begun = guard.begin(key);
  if (!begun) return { ok: false, via: "duplicate", outcome: outcomeOf("interrupted", "duplicate") };

  const finish = (r: SpeakResult): SpeakResult => {
    guard.finish(begun.generation, key);
    return r;
  };

  if (opts.signal?.aborted) return finish({ ok: false, via: "aborted", outcome: outcomeOf("interrupted", "none", { aborted: true }) });

  if (opts.serverTts) {
    // 1) A finished prefetch plays instantly. No 1500 ms race, no cache deletion.
    const readyClip = ttsScheduler.get(key);
    if (readyClip) {
      audioMetrics.record("tts_synthesis_ms", 0, "cache-hit", text.slice(0, 48));
      const o = await playClip(readyClip, opts.signal);
      if (o.status === "ended") return finish({ ok: true, via: "server-cache", outcome: o });
      if (o.status === "interrupted") return finish({ ok: false, via: "server-cache", outcome: o });
    } else {
      // 2) Promote any in-flight warm-up, but NEVER wait on it: go straight to
      //    the progressive GET stream (dynamic LLM follow-ups take this path).
      promoteTTS(text, opts.voice);
      const streamOutcome = await playStream(text, opts.voice, opts.signal);
      if (streamOutcome.status === "ended") return finish({ ok: true, via: "server-stream", outcome: streamOutcome });
      if (streamOutcome.status === "interrupted") return finish({ ok: false, via: "server-stream", outcome: streamOutcome });
      if (streamOutcome.partial) {
        // Already audible but truncated: do NOT replay the line.
        return finish({ ok: false, via: "server-stream", outcome: streamOutcome });
      }
      // 3) Buffered fallback (also repopulates the client cache).
      const clip = await fetchClip(text, opts.voice, opts.signal);
      if (clip) {
        const o = await playClip(clip, opts.signal);
        // Playback has finished (or been aborted): release the temporary blob
        // URL. The server-side cache retains the clip for any later repeat.
        releaseClip(clip);
        if (o.status !== "failed") return finish({ ok: o.status === "ended", via: "server-buffered", outcome: o });
      }
    }
  }

  // 4) Browser voice fallback (kept from the original implementation).
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return finish({ ok: false, via: "none", outcome: outcomeOf("failed", "none") });
  }
  await loadVoices();
  const browserOutcome = await new Promise<PlaybackOutcome>((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice(opts.voice);
    if (v) u.voice = v;
    u.lang = v?.lang || "en-GB";
    u.rate = 0.92;
    u.pitch = 1;
    const lifecycle = new AudioLifecycle("browser-voice");
    lifecycle.send("LOAD");
    lifecycle.send("READY");
    lifecycle.subscribe((s, prev) => audioMetrics.recordState("browser-voice", s, prev));
    const t0 = performance.now();
    let done = false;
    const heartbeat = setInterval(() => {
      if (speechSynthesis.speaking && !speechSynthesis.paused) {
        speechSynthesis.pause();
        speechSynthesis.resume();
      }
    }, 8000);
    const max = setTimeout(() => end("failed"), Math.max(6000, text.length * 110));
    function end(status: "ended" | "interrupted" | "failed") {
      if (done) return;
      done = true;
      clearTimeout(max);
      clearInterval(heartbeat);
      lifecycle.send(status === "ended" ? "END" : status === "interrupted" ? "INTERRUPT" : "FAIL");
      if (status === "ended") audioMetrics.record("playback_start_delay_ms", performance.now() - t0, "browser");
      resolve(outcomeOf(status, "browser", { aborted: status === "interrupted" }));
    }
    u.onstart = () => lifecycle.send("PLAY");
    u.onend = () => end("ended");
    u.onerror = () => end("failed");
    opts.signal?.addEventListener("abort", () => {
      speechSynthesis.cancel();
      end("interrupted");
    }, { once: true });
    const wasBusy = speechSynthesis.speaking || speechSynthesis.pending;
    if (wasBusy) speechSynthesis.cancel();
    const start = () => { if (!done) speechSynthesis.speak(u); };
    if (wasBusy) setTimeout(start, 80);
    else start();
  });
  return finish({ ok: browserOutcome.status === "ended", via: "browser", outcome: browserOutcome });
}

/** Stop all audio and cancel every queued synthesis task (exam exit / unload). */
export function stopSpeaking(): void {
  guard.interrupt();
  stopLiveAudio();
  ttsScheduler.cancelBelow(TTS_PRIORITY.CURRENT);
}

/** Full teardown: also releases clip URLs and preset blobs. */
export function disposeAudio(): void {
  guard.dispose();
  stopLiveAudio();
  ttsScheduler.dispose();
  activeSpeaks.clear();
  for (const [, objectUrl] of presetObjectUrls) URL.revokeObjectURL(objectUrl);
  presetObjectUrls.clear();
  presetCache.clear();
}

/** Re-arm the module-level singletons after a StrictMode remount. */
export function rearmAudio(): void {
  guard.rearm();
  ttsScheduler.rearm();
}
