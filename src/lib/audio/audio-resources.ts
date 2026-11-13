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
import { TTS_PRIORITY, type TtsPriority, type TtsTaskSnapshot, type TtsTaskStatus } from "./tts-scheduler";
import type { ExaminerSpeechAct } from "@/lib/speaking/speech-act";
import {
  configureTtsIdentity, prefetchManyTTSWithPriorities, waitForTTS, keyOf,
  preloadPresetAudio, loadVoices, subscribeTts, ttsSnapshot, disposeAudio, rearmAudio,
} from "./speech";
import { audioMetrics } from "./metrics";

/** A line to warm up, with the delivery it will be spoken in. */
export interface PreloadEntry { text: string; priority: TtsPriority; act?: ExaminerSpeechAct }

/** Classifier input: a bare string (legacy) or a line with its speech act. */
export type ScriptLineLike = string | { text: string; act?: ExaminerSpeechAct };

export interface AudioPreloaderOptions {
  voice: string;
  /** VoiceProfile id. When set, every warm-up is synthesised with exactly the
   *  profile the session will play with — never the deployment default. */
  profile?: string;
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

/**
 * REAL preparation result (5.2): derived from the scheduler's task statuses
 * after the gate — never a blanket "true because the timeout fired".
 */
export interface PreparationResult {
  /** Every opening line ready (and the preset clip, when one is used). */
  ok: boolean;
  /** True only when the bounded gate elapsed without everything ready. */
  timedOut: boolean;
  elapsedMs: number;
  total: number;
  readyCount: number;
  /** Per-line actual scheduler status: ready | queued | running | failed | cancelled. */
  lines: { text: string; act: string; status: TtsTaskStatus; ready: boolean }[];
  /** The bank clip's readiness when a preset audio is used for question 1. */
  presetReady: boolean | null;
  /** Human-readable first failure reason (failed/cancelled task, if any). */
  firstFailure: string | null;
}

const OPENING_TIMEOUT_MS = 12_000;

export class AudioPreloader {
  private readonly voice: string;
  private readonly profile: string | undefined;
  private readonly serverTts: boolean;
  private readonly readyTimeoutMs: number;
  private readonly listeners = new Set<(s: ReadinessSnapshot) => void>();
  private unsubscribeTts: (() => void) | null = null;
  private openingReady = false;
  private disposed = false;

  constructor(opts: AudioPreloaderOptions) {
    this.voice = opts.voice;
    this.profile = opts.profile;
    this.serverTts = opts.serverTts;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? OPENING_TIMEOUT_MS;
    rearmAudio();
    configureTtsIdentity(opts.model, opts.format);
    this.unsubscribeTts = subscribeTts(() => this.emit());
  }

  /** Queue the full script in priority order. Fire-and-forget by design. */
  prepareScript(entries: PreloadEntry[], presetUrls: string[] = []): void {
    if (this.disposed) return;
    prefetchManyTTSWithPriorities(entries, this.voice, this.serverTts, this.profile);
    for (const url of new Set(presetUrls.filter(Boolean))) void preloadPresetAudio(url);
    this.emit();
  }

  /**
   * Gate before the exam starts: only the opening utterance (one or more lines)
   * and the first question's resources. Backup voices are explicitly NOT awaited.
   * `timeoutMs` overrides the constructor default. The default is bounded
   * (~90–120 s, operator-tunable via TTS_START_GATE_MS on the server) — a slow
   * engine surfaces as a REAL PreparationResult with per-line statuses instead
   * of a 10-minute silent wait, and `ok` is only true when the audio is
   * ACTUALLY ready (never because a timeout elapsed).
   */
  async ensureOpeningAndFirst(
    opening: ScriptLineLike | ScriptLineLike[],
    firstQuestionAudioUrl: string | null,
    act: ExaminerSpeechAct = "question",
    timeoutMs?: number,
  ): Promise<PreparationResult> {
    const t0 = performance.now();
    if (this.disposed) return { ok: false, timedOut: false, elapsedMs: 0, total: 0, readyCount: 0, lines: [], presetReady: null, firstFailure: "Audio preloader was disposed (exam exit)." };
    const gate = timeoutMs ?? this.readyTimeoutMs;
    const openingLines = toLines(opening).filter((l) => l.text.trim());
    const jobs: Promise<unknown>[] = [];
    // The bank clip does NOT go through the TTS scheduler; its readiness is
    // the preload promise resolving to a blob URL (≠ the original URL — the
    // original URL is returned when the fetch failed).
    let presetDone = false;
    let presetOk = false;
    if (firstQuestionAudioUrl) {
      const p = preloadPresetAudio(firstQuestionAudioUrl).then((resolved) => {
        presetDone = true;
        presetOk = !!resolved && resolved !== firstQuestionAudioUrl;
        return resolved;
      });
      jobs.push(p);
    }
    if (this.serverTts) {
      jobs.push(...openingLines.map((l) => waitForTTS(l.text, this.voice, gate, l.act ?? act, this.profile)));
      if (!openingLines.length) jobs.push(loadVoices());
    } else {
      jobs.push(loadVoices()); // browser fallback voice list
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const gateExpired = new Promise<void>((r) => { timer = setTimeout(r, gate + 1000); });
    await Promise.race([Promise.allSettled(jobs), gateExpired]);
    if (timer) clearTimeout(timer); // do not keep the event loop / exam alive
    const elapsedMs = performance.now() - t0;

    // Inspect ACTUAL task statuses instead of assuming readiness on timeout.
    // keyOf() is the SAME identity the scheduler and speech.ts use, so a ready
    // line is only counted when its real clip exists.
    const wanted = new Map<string, { text: string; act: string }>();
    for (const l of openingLines) {
      wanted.set(keyOf(l.text, this.voice, l.act ?? act, this.profile), { text: l.text, act: l.act ?? act });
    }
    const snap = ttsSnapshot();
    const lines: PreparationResult["lines"] = [];
    for (const [key, meta] of wanted) {
      const task = snap.find((t) => t.key === key);
      const status = task?.status ?? "cancelled";
      lines.push({ ...meta, status, ready: status === "ready" && !!task?.hasResource });
    }
    const readyCount = lines.filter((l) => l.ready).length;
    // presetReady: true (blob cached) / false (fetch definitively failed) /
    // null (still downloading — never treated as a failure on its own).
    const presetReady: boolean | null = firstQuestionAudioUrl ? (presetDone ? presetOk : null) : null;
    const failedLine = lines.find((l) => l.status === "failed" || l.status === "cancelled");
    const firstFailure = failedLine
      ? `Opening line not available (status: ${failedLine.status}): "${failedLine.text.slice(0, 60)}"`
      : presetReady === false
        ? "The first question's recorded audio did not finish loading."
        : null;
    const ok = (lines.length === 0 || lines.every((l) => l.ready)) && presetReady !== false;
    if (ok) this.openingReady = true; // only a REAL readiness flips this
    audioMetrics.record("audio_ready_ms", elapsedMs, this.serverTts ? "cache-miss" : "browser", ok ? "opening gate ok" : "opening gate incomplete");
    const result: PreparationResult = { ok, timedOut: !ok && elapsedMs >= gate, elapsedMs, total: lines.length, readyCount, lines, presetReady, firstFailure };
    this.emit();
    return result;
  }

  /** Prepare the next question while the candidate is answering the current one. */
  prepareNext(line: ScriptLineLike | ScriptLineLike[], questionAudioUrl: string | null): void {
    if (this.disposed) return;
    prefetchManyTTSWithPriorities(
      toLines(line).map((l) => ({ ...l, priority: TTS_PRIORITY.NEXT })),
      this.voice, this.serverTts, this.profile,
    );
    if (questionAudioUrl) void preloadPresetAudio(questionAudioUrl);
    this.emit();
  }

  /** A Part 3 follow-up inserted at advance time must be able to stream at once. */
  prepareDynamic(line: ScriptLineLike | ScriptLineLike[], questionAudioUrl: string | null = null): void {
    if (this.disposed) return;
    prefetchManyTTSWithPriorities(
      toLines(line).map((l) => ({ ...l, priority: TTS_PRIORITY.CURRENT })),
      this.voice, this.serverTts, this.profile,
    );
    if (questionAudioUrl) void preloadPresetAudio(questionAudioUrl);
    this.emit();
  }

  /** Re-plan after a refresh / re-entry: requeue everything from the fresh view. */
  replan(entries: PreloadEntry[], presetUrls: string[], currentLine: ScriptLineLike | ScriptLineLike[]): void {
    if (this.disposed) return;
    this.prepareScript(entries, presetUrls);
    if (toLines(currentLine).some((l) => l.text.trim())) this.prepareDynamic(currentLine);
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

function normalizeLine(l: ScriptLineLike): { text: string; act?: ExaminerSpeechAct } {
  return typeof l === "string" ? { text: l } : { text: l.text, act: l.act };
}

/** Accept one line or a list of lines (an examiner turn is often several parts). */
function toLines(l: ScriptLineLike | ScriptLineLike[]): { text: string; act?: ExaminerSpeechAct }[] {
  return (Array.isArray(l) ? l : [l]).map(normalizeLine);
}

/** The spoken text of a line (used for emptiness checks). */
export function lineOf(l: ScriptLineLike): string {
  return typeof l === "string" ? l : l.text;
}

/**
 * Pure priority classifier (unit-testable). Kept here so the runner and the
 * preloader agree on which lines may never block the exam.
 */
export function classifyScriptLines(lines: {
  opening: ScriptLineLike | ScriptLineLike[];
  first: ScriptLineLike | ScriptLineLike[];
  next: ScriptLineLike | ScriptLineLike[];
  rest: ScriptLineLike | ScriptLineLike[];
  fixed: ScriptLineLike | ScriptLineLike[];
  backups: ScriptLineLike | ScriptLineLike[];
}): PreloadEntry[] {
  const out: PreloadEntry[] = [];
  const seen = new Set<string>();
  const addAll = (line: ScriptLineLike | ScriptLineLike[] | undefined, priority: TtsPriority) => {
    if (!line) return;
    for (const l of toLines(line)) {
      const { text, act } = l;
      if (!text?.trim()) continue;
      // Identity includes the speech act: the same sentence as a question and as a
      // closing is two different clips, so both must be warmed.
      const id = `${act ?? "question"}\u0000${text}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ text, priority, act });
    }
  };
  addAll(lines.opening, TTS_PRIORITY.CURRENT);
  addAll(lines.first, TTS_PRIORITY.CURRENT);
  addAll(lines.next, TTS_PRIORITY.NEXT);
  addAll(lines.fixed, TTS_PRIORITY.BACKGROUND);
  addAll(lines.rest, TTS_PRIORITY.BACKGROUND);
  // Repeat forms + no-response/backup feedback are the first to be cut.
  addAll(lines.backups, TTS_PRIORITY.LOW);
  return out;
}
