"use client";
/**
 * Unified audio resource preloading for a Speaking session.
 *
 * The original code only warmed TTS text. Pre-recorded bank audio
 * (`questionAudioUrl`) was created with `new Audio(url)` at play time, so the
 * candidate waited on a network download right when the examiner should speak.
 * Fixed examiner phrases and TTS lines were also mixed in one unprioritised
 * FIFO queue.
 *
 * This coordinator handles all three resource kinds with explicit priorities:
 *   - opening line + first question  : guaranteed ready BEFORE the exam starts
 *   - next question                  : prepared while the candidate answers
 *   - later script                   : background
 *   - repeat / no-response backups   : low (never allowed to block the exam)
 *
 * `ensureOpeningAndFirst()` is the only awaitable gate and it waits for at most
 * two resources. It NEVER waits for the whole script or the backup voices.
 */
import { TTS_PRIORITY, type TtsPriority, type TtsTaskSnapshot } from "./tts-scheduler";
import {
  configureTtsIdentity, prefetchManyTTSWithPriorities, waitForTTS,
  preloadPresetAudio, loadVoices, subscribeTts, ttsSnapshot, disposeAudio, rearmAudio,
} from "./speech";
import { audioMetrics } from "./metrics";

export interface PreloadEntry { text: string; priority: TtsPriority }

export interface AudioPreloaderOptions {
  voice: string;
  model?: string | null;
  format?: string | null;
  serverTts: boolean;
  /** Bounded readiness gate so a dead TTS engine cannot hang the exam. */
  readyTimeoutMs?: number;
}

export interface ReadinessSnapshot {
  tts: TtsTaskSnapshot[];
  readyCount: number;
  totalCount: number;
  openingReady: boolean;
}

const OPENING_TIMEOUT_MS = 12_000;

export class AudioPreloader {
  private readonly voice: string;
  private readonly serverTts: boolean;
  private readonly readyTimeoutMs: number;
  private readonly listeners = new Set<(s: ReadinessSnapshot) => void>();
  private unsubscribeTts: (() => void) | null = null;
  private openingReady = false;
  private disposed = false;

  constructor(opts: AudioPreloaderOptions) {
    this.voice = opts.voice;
    this.serverTts = opts.serverTts;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? OPENING_TIMEOUT_MS;
    rearmAudio();
    configureTtsIdentity(opts.model, opts.format);
    this.unsubscribeTts = subscribeTts(() => this.emit());
  }

  /** Queue the full script in priority order. Fire-and-forget by design. */
  prepareScript(entries: PreloadEntry[], presetUrls: string[] = []): void {
    if (this.disposed) return;
    prefetchManyTTSWithPriorities(entries, this.voice, this.serverTts);
    for (const url of new Set(presetUrls.filter(Boolean))) void preloadPresetAudio(url);
    this.emit();
  }

  /**
   * Gate before the exam starts: only the opening line and the first question's
   * resources. Backup voices are explicitly NOT awaited.
   */
  async ensureOpeningAndFirst(openingLine: string, firstQuestionAudioUrl: string | null): Promise<ReadinessSnapshot> {
    if (this.disposed) return this.snapshot();
    const jobs: Promise<unknown>[] = [];
    if (this.serverTts) {
      jobs.push(waitForTTS(openingLine, this.voice, this.readyTimeoutMs));
    } else {
      jobs.push(loadVoices()); // browser fallback voice list
    }
    if (firstQuestionAudioUrl) jobs.push(preloadPresetAudio(firstQuestionAudioUrl));

    const t0 = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(jobs),
      new Promise<void>((r) => { timer = setTimeout(r, this.readyTimeoutMs + 1000); }),
    ]);
    if (timer) clearTimeout(timer); // do not keep the event loop / exam alive
    audioMetrics.record("audio_ready_ms", performance.now() - t0, this.serverTts ? "cache-miss" : "browser", "opening gate");
    this.openingReady = true;
    const s = this.snapshot();
    this.emit();
    return s;
  }

  /** Prepare the next question while the candidate is answering the current one. */
  prepareNext(line: string, questionAudioUrl: string | null): void {
    if (this.disposed) return;
    prefetchManyTTSWithPriorities([{ text: line, priority: TTS_PRIORITY.NEXT }], this.voice, this.serverTts);
    if (questionAudioUrl) void preloadPresetAudio(questionAudioUrl);
    this.emit();
  }

  /** A Part 3 follow-up inserted at advance time must be able to stream at once. */
  prepareDynamic(line: string, questionAudioUrl: string | null = null): void {
    if (this.disposed) return;
    prefetchManyTTSWithPriorities([{ text: line, priority: TTS_PRIORITY.CURRENT }], this.voice, this.serverTts);
    if (questionAudioUrl) void preloadPresetAudio(questionAudioUrl);
    this.emit();
  }

  /** Re-plan after a refresh / re-entry: requeue everything from the fresh view. */
  replan(entries: PreloadEntry[], presetUrls: string[], currentLine: string): void {
    if (this.disposed) return;
    this.prepareScript(entries, presetUrls);
    if (currentLine) this.prepareDynamic(currentLine);
    this.emit();
  }

  snapshot(): ReadinessSnapshot {
    const tts = ttsSnapshot();
    return {
      tts,
      readyCount: tts.filter((t) => t.status === "ready").length,
      totalCount: tts.length,
      openingReady: this.openingReady,
    };
  }

  subscribe(fn: (s: ReadinessSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    if (!this.listeners.size) return;
    const s = this.snapshot();
    for (const fn of this.listeners) {
      try { fn(s); } catch { /* ignore */ }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeTts?.();
    this.unsubscribeTts = null;
    this.listeners.clear();
    disposeAudio();
  }
}

/**
 * Pure priority classifier (unit-testable). Kept here so the runner and the
 * preloader agree on which lines may never block the exam.
 */
export function classifyScriptLines(lines: {
  opening: string;
  first: string;
  next: string[];
  rest: string[];
  fixed: string[];
  backups: string[];
}): PreloadEntry[] {
  const out: PreloadEntry[] = [];
  const seen = new Set<string>();
  const add = (text: string | undefined, priority: TtsPriority) => {
    if (!text?.trim() || seen.has(text)) return;
    seen.add(text);
    out.push({ text, priority });
  };
  add(lines.opening, TTS_PRIORITY.CURRENT);
  add(lines.first, TTS_PRIORITY.CURRENT);
  for (const t of lines.next) add(t, TTS_PRIORITY.NEXT);
  for (const t of lines.fixed) add(t, TTS_PRIORITY.BACKGROUND);
  for (const t of lines.rest) add(t, TTS_PRIORITY.BACKGROUND);
  // Repeat forms + no-response/backup feedback are the first to be cut.
  for (const t of lines.backups) add(t, TTS_PRIORITY.LOW);
  return out;
}
