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
