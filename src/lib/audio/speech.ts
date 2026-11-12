"use client";
/**
 * Client speech services: examiner TTS (server or browser) and browser ASR (Web Speech API).
 *
 * Latency strategy for server TTS
 * --------------------------------
 * Local/CPU engines need several seconds per line. The examiner text for a whole
 * session is known up front, so `prefetchManyTTS()` starts synthesising during the
 * setup screen and keeps going while the candidate is answering. Clips are fully
 * downloaded, turned into blob URLs and pre-decoded; playback then starts instantly.
 * Anything that cannot be prefetched (an LLM-generated follow-up) is played from a
 * progressive GET stream, so the first sentence is audible instead of blocking on
 * the whole clip. A complete buffered request and the browser voice are last resorts.
 */
import { speechActStyle, type ExaminerSpeechAct } from "@/lib/speaking/speech-act";

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
          } catch {}
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
    // Some browsers populate the list one tick later without firing the event.
    setTimeout(onChanged, 0);
  });
  return voicesPromise;
}

/** Call as early as possible (setup screen) so the browser fallback is ready too. */
export function warmupSpeech(): void {
  if (typeof window === "undefined") return;
  void loadVoices();
}

function voiceScore(v: SpeechSynthesisVoice, pref: string): number {
  let s = 0;
  const lang = v.lang?.toLowerCase() ?? "";
  const name = v.name ?? "";
  if (pref && pref !== "auto" && name === pref) s += 100;
  if (lang.startsWith("en-gb")) s += 30;
  else if (lang.startsWith("en")) s += 10;
  // Cloud / neural voices are markedly less mechanical than the built-in ones.
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
interface Clip { url: string; audio: HTMLAudioElement }
interface PrefetchTask { text: string; voice: string; act: ExaminerSpeechAct; profileId?: string; key: string; resolve: (c: Clip | null) => void }

const clipCache = new Map<string, Promise<Clip | null>>();
const TTS_CACHE_MAX = 60;
/** A CPU-bound local engine is slower when hammered; two concurrent jobs is the sweet spot. */
const MAX_PARALLEL = 2;
const queue: PrefetchTask[] = [];
let active = 0;
let liveAudio: HTMLAudioElement | null = null;

/** The speech act and voice profile are part of a clip's identity: the same
 *  words delivered as a greeting and as a question are different audio. */
const keyOf = (text: string, voice: string, act: ExaminerSpeechAct, profileId?: string) =>
  `${profileId ?? voice}\u0000${act}\u0000${text}`;

const ttsStreamUrl = (text: string, voice: string, act: ExaminerSpeechAct, profileId?: string) => {
  const q = new URLSearchParams({ text, act });
  if (profileId) q.set("profile", profileId);
  else q.set("voice", voice);
  return `/api/tts?${q.toString()}`;
};

async function fetchClip(text: string, voice: string, act: ExaminerSpeechAct, profileId?: string): Promise<Clip | null> {
  try {
    // Prefetch uses the buffered POST path: a single synthesis job finishes faster
    // than the sentence-by-sentence stream, which matters when warming 30+ lines.
    // It shares the server cache with the progressive GET used for live playback.
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: profileId ? undefined : voice, act, ...(profileId ? { profile: profileId } : {}) }),
      cache: "no-store",
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

function evict() {
  while (clipCache.size > TTS_CACHE_MAX) {
    const oldest = clipCache.keys().next().value as string | undefined;
    if (!oldest) break;
    const p = clipCache.get(oldest);
    clipCache.delete(oldest);
    void p?.then((c) => {
      if (c) {
        c.audio.pause();
        URL.revokeObjectURL(c.url);
      }
    });
  }
}

function pump() {
  while (active < MAX_PARALLEL && queue.length) {
    const task = queue.shift()!;
    active++;
    void fetchClip(task.text, task.voice, task.act, task.profileId)
      .then(task.resolve)
      .finally(() => {
        active--;
        pump();
      });
  }
}

export interface PrefetchOptions {
  /** Which speech act the line belongs to (affects rate, pauses, emphasis). */
  act?: ExaminerSpeechAct;
  /** Voice profile id; when set the server reads the profile instead of `voice`. */
  profileId?: string;
  /** Jump the queue — used for the very next line the examiner will speak. */
  priority?: boolean;
}

/** Queue one line for background synthesis. Failures are not cached, so they can be retried. */
export function prefetchTTS(text: string, voice: string, serverTts: boolean, priorityOrOpts: boolean | PrefetchOptions = false, legacyAct: ExaminerSpeechAct = "question"): void {
  if (!serverTts || !text.trim() || typeof window === "undefined") return;
  const opts: PrefetchOptions = typeof priorityOrOpts === "boolean" ? { priority: priorityOrOpts, act: legacyAct } : priorityOrOpts;
  const act = opts.act ?? "question";
  const key = keyOf(text, voice, act, opts.profileId);
  if (clipCache.has(key)) return;
  const p = new Promise<Clip | null>((resolve) => {
    const task = { text, voice, act, profileId: opts.profileId, key, resolve };
    if (opts.priority) queue.unshift(task);
    else queue.push(task);
    pump();
  });
  clipCache.set(key, p);
  void p.then((clip) => {
    if (!clip) clipCache.delete(key);
    else evict();
  });
}

export interface ScriptLine {
  text: string;
  act: ExaminerSpeechAct;
}

/** Prefetch the whole script in play order (fixed lines first, then every step). */
export function prefetchManyTTS(lines: (string | ScriptLine)[], voice: string, serverTts: boolean, profileId?: string): void {
  if (!serverTts || typeof window === "undefined") return;
  const seen = new Set<string>();
  for (const line of lines) {
    const text = typeof line === "string" ? line : line.text;
    const act: ExaminerSpeechAct = typeof line === "string" ? "question" : line.act;
    if (!text?.trim()) continue;
    const k = `${act}\u0000${text}`;
    if (seen.has(k)) continue;
    seen.add(k);
    prefetchTTS(text, voice, true, { act, profileId });
  }
}

function playClip(clip: Clip, signal?: AbortSignal): Promise<boolean> {
  const audio = clip.audio;
  liveAudio = audio;
  try { audio.currentTime = 0; } catch { /* not seekable yet */ }
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      audio.onended = null;
      audio.onerror = null;
      signal?.removeEventListener("abort", onAbort);
      resolve(ok);
    };
    const onAbort = () => { audio.pause(); finish(false); };
    audio.onended = () => finish(true);
    audio.onerror = () => finish(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    void audio.play().catch(() => finish(false));
  });
}

/** Progressive playback: audio starts at the first sentence the engine produces. */
function playStream(text: string, voice: string, act: ExaminerSpeechAct, profileId: string | undefined, signal?: AbortSignal): Promise<boolean> {
  const audio = new Audio(ttsStreamUrl(text, voice, act, profileId));
  audio.preload = "auto";
  liveAudio = audio;
  return new Promise((resolve) => {
    let started = false;
    let done = false;
    // If the browser cannot play a chunked stream, fall back to the buffered path.
    const timer = setTimeout(() => { if (!started) finish(false); }, 12000);
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      audio.pause();
      audio.onended = null;
      audio.onerror = null;
      signal?.removeEventListener("abort", onAbort);
      resolve(ok);
    };
    const onAbort = () => finish(false);
    audio.addEventListener("playing", () => { started = true; clearTimeout(timer); });
    audio.onended = () => finish(true);
    // If it already started, treat a late network error as "done" rather than replaying the line.
    audio.onerror = () => finish(started);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    void audio.play().catch(() => finish(false));
  });
}

export interface SpeakOptions {
  serverTts: boolean;
  voice: string;
  /** How this line should be delivered (greeting, question, instruction …). */
  act?: ExaminerSpeechAct;
  /** Voice profile id — when set, the server uses it instead of the raw voice name. */
  profileId?: string;
  signal?: AbortSignal;
}

/**
 * Speak examiner text. Resolves when finished. Never throws: on TTS failure the
 * caller still has the on-screen subtitle, so the exam continues.
 */
export async function speak(text: string, opts: SpeakOptions): Promise<{ ok: boolean; via: string }> {
  if (!text.trim()) return { ok: true, via: "none" };
  const act: ExaminerSpeechAct = opts.act ?? "question";
  if (opts.serverTts) {
    const key = keyOf(text, opts.voice, act, opts.profileId);
    const cached = clipCache.get(key);
    if (cached) {
      // A clip queued but not finished yet is usually just about to arrive; don't
      // wait long — the progressive GET below will pick up the server-side job.
      const clip = await Promise.race([cached, new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
      if (clip && (await playClip(clip, opts.signal))) return { ok: true, via: "server-cache" };
      if (clipCache.get(key) === cached) clipCache.delete(key);
    }
    if (await playStream(text, opts.voice, act, opts.profileId, opts.signal)) return { ok: true, via: "server-stream" };
    const clip = await fetchClip(text, opts.voice, act, opts.profileId);
    if (clip) {
      clipCache.set(key, Promise.resolve(clip));
      if (await playClip(clip, opts.signal)) return { ok: true, via: "server-buffered" };
    }
  }

  // -------------------------------------------------------------- browser fallback
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return { ok: false, via: "none" };
  await loadVoices();
  const style = speechActStyle(act);
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice(opts.voice);
    if (v) u.voice = v;
    u.lang = v?.lang || "en-GB";
    // The browser voice has no SSML, but rate/pitch still separate a greeting
    // from an instruction instead of delivering every line identically.
    u.rate = Math.min(2, Math.max(0.5, 0.94 * style.browserRateFactor));
    u.pitch = Math.min(2, Math.max(0, 1 * style.browserPitchFactor));
    let done = false;
    // Chrome stops long utterances after ~15 s unless the engine is nudged.
    const heartbeat = setInterval(() => {
      if (speechSynthesis.speaking && !speechSynthesis.paused) {
        speechSynthesis.pause();
        speechSynthesis.resume();
      }
    }, 8000);
    const max = setTimeout(() => finish(false), Math.max(6000, text.length * 110));
    function finish(ok: boolean) {
      if (done) return;
      done = true;
      clearTimeout(max);
      clearInterval(heartbeat);
      resolve({ ok, via: "browser" });
    }
    u.onend = () => finish(true);
    u.onerror = () => finish(false);
    opts.signal?.addEventListener("abort", () => {
      speechSynthesis.cancel();
      finish(false);
    });
    // Chrome can swallow an utterance spoken immediately after cancel().
    const wasBusy = speechSynthesis.speaking || speechSynthesis.pending;
    if (wasBusy) speechSynthesis.cancel();
    const start = () => { if (!done) speechSynthesis.speak(u); };
    if (wasBusy) setTimeout(start, 80);
    else start();
  });
}

export function stopSpeaking() {
  if (typeof window !== "undefined" && "speechSynthesis" in window) speechSynthesis.cancel();
  liveAudio?.pause();
  liveAudio = null;
}
