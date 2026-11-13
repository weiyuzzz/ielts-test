/**
 * Explicit audio lifecycle for examiner playback.
 *
 * Previously `speak()` collapsed every non-success into `ok:false`, and
 * `playStream()` even reported a truncated stream as a completed play. That
 * made "interrupted", "failed" and "ended" indistinguishable, so an aborted or
 * broken examiner voice could still advance the exam.
 *
 * This module is pure and DOM-free so the transitions are unit-testable; the
 * real <audio>/speechSynthesis driver lives in speech.ts.
 */
export type AudioState =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "ended"
  | "interrupted"
  | "failed";

export type AudioEvent =
  | "LOAD"
  | "READY"
  | "PLAY"
  | "END"
  | "INTERRUPT"
  | "FAIL"
  | "RESET";

/** Terminal states are never treated as "normal playback finished" by callers. */
export const TERMINAL_STATES: readonly AudioState[] = ["ended", "interrupted", "failed"];
export const COMPLETED_STATE: AudioState = "ended";

const TRANSITIONS: Record<AudioState, Partial<Record<AudioEvent, AudioState>>> = {
  idle: { LOAD: "loading", PLAY: "playing", INTERRUPT: "interrupted", FAIL: "failed", RESET: "idle" },
  loading: { READY: "ready", PLAY: "playing", END: "ended", INTERRUPT: "interrupted", FAIL: "failed", RESET: "idle" },
  ready: { PLAY: "playing", END: "ended", INTERRUPT: "interrupted", FAIL: "failed", RESET: "idle" },
  playing: { END: "ended", INTERRUPT: "interrupted", FAIL: "failed", RESET: "idle" },
  ended: { LOAD: "loading", RESET: "idle" },
  interrupted: { LOAD: "loading", RESET: "idle" },
  failed: { LOAD: "loading", RESET: "idle" },
};

export function canTransition(from: AudioState, event: AudioEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

/** Pure reducer. Invalid transitions are ignored (never silently "completed"). */
export function reduceAudioState(from: AudioState, event: AudioEvent): AudioState {
  return TRANSITIONS[from][event] ?? from;
}

export type PlaybackOutcomeStatus = "ended" | "interrupted" | "failed";

export interface PlaybackOutcome {
  status: PlaybackOutcomeStatus;
  /** How the audio was produced: cache / stream / buffered / preset / browser. */
  via: string;
  /** A stream that stopped after it had already started is still a FAILURE,
   *  but the caller should not replay the line (it would be heard twice). */
  partial: boolean;
  /** Explicitly aborted by the user / exam exit. */
  aborted: boolean;
}

export const outcomeOf = (
  status: PlaybackOutcomeStatus,
  via: string,
  opts: { partial?: boolean; aborted?: boolean } = {},
): PlaybackOutcome => ({ status, via, partial: opts.partial ?? false, aborted: opts.aborted ?? false });

// ------------------------------------------------------------------ failure taxonomy (5.4)

/**
 * One failure vocabulary for every audio path (synthesis, playback, transport):
 *   config           provider misconfigured / key missing   → do NOT retry blindly
 *   connection       engine or network unreachable          → retry makes sense
 *   timeout          no answer in time                      → retry makes sense
 *   rate_limit       provider throttling (429)              → retry with backoff
 *   invalid_audio    answer came back but is not audio      → retry once, then stop
 *   playback_blocked browser refused/failed to play         → do NOT synth-retry
 *   cancelled        user aborted / exam exit               → never retry
 */
export type AudioFailureKind =
  | "config"
  | "connection"
  | "timeout"
  | "rate_limit"
  | "invalid_audio"
  | "playback_blocked"
  | "cancelled";

export interface AudioFailure {
  kind: AudioFailureKind;
  retryable: boolean;
  /** Short, user-facing reason (no credentials, no stack traces). */
  message: string;
}

/**
 * Classify ANY audio failure from its observable shape. Pure and DOM-free so
 * the exam runner's blocked panel and the tests agree on retryability.
 */
export function classifyAudioFailure(input: {
  outcome?: Pick<PlaybackOutcome, "status" | "via" | "aborted"> | null;
  error?: unknown;
}): AudioFailure {
  const err = input.error as { code?: string; message?: string; name?: string } | undefined;
  const errText = (err?.message ?? (typeof input.error === "string" ? input.error : "")).toLowerCase();
  if (input.outcome?.aborted || err?.name === "AbortError") {
    return { kind: "cancelled", retryable: false, message: "Playback was cancelled." };
  }
  if (err) {
    if (err.code === "config" || /not configured|missing (api )?key/.test(errText)) {
      return { kind: "config", retryable: false, message: "The voice provider is not configured correctly (check the AI settings)." };
    }
    if (err.code === "timeout" || /timed? ?out|no response within/.test(errText)) {
      return { kind: "timeout", retryable: true, message: "The voice engine did not answer in time." };
    }
    if (/429|rate limit|too many requests/.test(errText)) {
      return { kind: "rate_limit", retryable: true, message: "The voice provider is rate limiting requests." };
    }
    if (err.code === "invalid_response" || /not valid audio|empty audio|invalid_response|no content|no audio/.test(errText)) {
      return { kind: "invalid_audio", retryable: true, message: "The engine answered but the audio was invalid." };
    }
    if (err.code === "http" || /fetch|network|econnrefused|failed to fetch|502|503|504/.test(errText)) {
      return { kind: "connection", retryable: true, message: "The voice engine could not be reached." };
    }
  }
  if (input.outcome) {
    const { status, via } = input.outcome;
    if (status === "interrupted") return { kind: "cancelled", retryable: false, message: "Playback was interrupted." };
    if (status === "failed") {
      if (via === "browser" || via === "none") {
        return { kind: "playback_blocked", retryable: false, message: "This browser could not play the examiner's audio." };
      }
      if (via === "stream") return { kind: "invalid_audio", retryable: true, message: "The audio stream broke before it finished." };
      return { kind: "connection", retryable: true, message: "The examiner's voice could not be synthesised." };
    }
  }
  return { kind: "connection", retryable: true, message: "The examiner's voice is temporarily unavailable." };
}

/** Observable state holder with a subscribe() hook for the dev call-chain view. */
export class AudioLifecycle {
  private state: AudioState = "idle";
  private readonly listeners = new Set<(s: AudioState, prev: AudioState, key: string) => void>();
  constructor(public readonly key: string = "examiner") {}

  get current(): AudioState { return this.state; }
  get isTerminal(): boolean { return TERMINAL_STATES.includes(this.state); }
  get isActive(): boolean { return this.state === "loading" || this.state === "ready" || this.state === "playing"; }

  send(event: AudioEvent): AudioState {
    const prev = this.state;
    this.state = reduceAudioState(prev, event);
    if (prev !== this.state) {
      for (const fn of this.listeners) {
        try { fn(this.state, prev, this.key); } catch { /* ignore */ }
      }
    }
    return this.state;
  }

  subscribe(fn: (s: AudioState, prev: AudioState, key: string) => void): () => void {
    this.listeners.add(fn);
    fn(this.state, this.state, this.key);
    return () => { this.listeners.delete(fn); };
  }

  reset(): void { this.send("RESET"); }
}

/**
 * Single owner for examiner playback. A generation token guarantees:
 *  - a second concurrent play stops the first (no two examiner voices overlap),
 *  - a repeated request for the identical key while it is playing is a no-op,
 *  - a late callback from an old playback cannot complete the current one.
 */
export class PlaybackGuard {
  private generation = 0;
  private activeKey: string | null = null;
  private stopped = false;
  private readonly stopCurrent: () => void;

  constructor(stopCurrent: () => void) { this.stopCurrent = stopCurrent; }

  /** Returns null when this request is a duplicate of the in-flight playback. */
  begin(key: string): { generation: number; duplicate: boolean } | null {
    if (this.stopped) return null;
    if (this.activeKey === key) return null;
    if (this.activeKey !== null) {
      // Starting a new line always interrupts the previous one first.
      this.stopCurrent();
    }
    this.activeKey = key;
    return { generation: ++this.generation, duplicate: false };
  }

  isCurrent(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  finish(generation: number, key: string): boolean {
    if (generation !== this.generation) return false;
    if (this.activeKey === key) this.activeKey = null;
    return true;
  }

  /** Abort everything in flight (exam exit / page unload). */
  interrupt(): void {
    this.generation++;
    this.activeKey = null;
    this.stopCurrent();
  }

  dispose(): void {
    this.stopped = true;
    this.interrupt();
  }

  /** Re-arm after a dev-mode StrictMode remount. */
  rearm(): void {
    this.stopped = false;
    this.activeKey = null;
    this.generation++;
  }
}
