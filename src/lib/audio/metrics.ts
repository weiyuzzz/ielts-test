/**
 * Audio performance telemetry for the Speaking mock exam.
 *
 * All ten required timings are recorded here, each tagged with the resource
 * source so cache hits, misses and progressive streams can be compared. The
 * collector is DOM-free and injectable (clock) so it is unit-testable; the dev
 * call-chain view is installed separately by `installDevTrace()`.
 */
export const METRIC_NAMES = [
  "tts_synthesis_ms",
  "audio_download_ms",
  "audio_ready_ms",
  "playback_start_delay_ms",
  "recording_duration_ms",
  "audio_encoding_ms",
  "upload_duration_ms",
  "asr_duration_ms",
  "advance_duration_ms",
  "inter_turn_gap_ms",
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

/** Distinguishes the three delivery paths plus preset/bank audio and browser TTS. */
export type AudioSource = "cache-hit" | "cache-miss" | "stream" | "preset" | "buffered" | "browser" | "none";

export interface MetricEvent {
  name: MetricName;
  ms: number;
  source: AudioSource;
  turn: number;
  stepIndex: number | null;
  at: number;
  detail?: string;
}

export interface StateChange {
  at: number;
  turn: number;
  key: string;
  state: string;
  prev: string;
}

export interface TurnRecord {
  turn: number;
  stepIndex: number | null;
  startedAt: number;
  endedAt: number | null;
  events: MetricEvent[];
  outcome: string | null;
}

export interface AudioTrace {
  turns: TurnRecord[];
  states: StateChange[];
  events: MetricEvent[];
}

/** True in dev builds; avoids any telemetry overhead in production bundles. */
export const audioTelemetryEnabled = (): boolean => process.env.NODE_ENV !== "production";

export class AudioMetrics {
  private readonly clock: () => number;
  private readonly events: MetricEvent[] = [];
  private readonly states: StateChange[] = [];
  private readonly turns: TurnRecord[] = [];
  private readonly listeners = new Set<(e: MetricEvent) => void>();
  private turn = 0;
  private stepIndex: number | null = null;
  private turnStart = 0;
  private lastTurnEndedAt: number | null = null;
  private current: TurnRecord | null = null;

  constructor(opts: { now?: () => number } = {}) {
    this.clock = opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  }

  startTurn(stepIndex: number | null): number {
    this.endTurn("superseded");
    this.turn++;
    this.stepIndex = stepIndex;
    this.turnStart = this.clock();
    this.current = { turn: this.turn, stepIndex, startedAt: this.turnStart, endedAt: null, events: [], outcome: null };
    this.turns.push(this.current);
    // Time between the previous examiner voice ending and this turn starting.
    if (this.lastTurnEndedAt !== null) {
      this.record("inter_turn_gap_ms", this.turnStart - this.lastTurnEndedAt, "none", "gap between turns");
    }
    return this.turn;
  }

  endTurn(outcome: string): void {
    if (!this.current) return;
    const now = this.clock();
    this.current.endedAt = now;
    this.current.outcome = outcome;
    this.lastTurnEndedAt = now;
    this.current = null;
  }

  record(name: MetricName, ms: number, source: AudioSource = "none", detail?: string): MetricEvent {
    const e: MetricEvent = {
      name,
      ms: Math.max(0, Math.round(ms)),
      source,
      turn: this.turn,
      stepIndex: this.stepIndex,
      at: this.clock(),
      ...(detail ? { detail } : {}),
    };
    this.events.push(e);
    this.current?.events.push(e);
    for (const fn of this.listeners) {
      try { fn(e); } catch { /* a bad listener must not break the exam */ }
    }
    return e;
  }

  /** Convenience: time an async operation and record it under `name`. */
  async time<T>(name: MetricName, source: AudioSource, fn: () => Promise<T>, detail?: string): Promise<T> {
    const t0 = this.clock();
    try {
      return await fn();
    } finally {
      this.record(name, this.clock() - t0, source, detail);
    }
  }

  recordState(key: string, state: string, prev: string): void {
    if (!this.states.length || this.states[this.states.length - 1].state !== state || this.states[this.states.length - 1].key !== key) {
      this.states.push({ at: this.clock(), turn: this.turn, key, state, prev });
    }
  }

  subscribe(fn: (e: MetricEvent) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  trace(): AudioTrace {
    return {
      turns: this.turns.map((t) => ({ ...t, events: [...t.events] })),
      states: [...this.states],
      events: [...this.events],
    };
  }

  /** Aggregate view used by the dev console and by performance assertions. */
  summary(): Record<string, { count: number; totalMs: number; maxMs: number; bySource: Record<string, number> }> {
    const out: Record<string, { count: number; totalMs: number; maxMs: number; bySource: Record<string, number> }> = {};
    for (const name of METRIC_NAMES) out[name] = { count: 0, totalMs: 0, maxMs: 0, bySource: {} };
    for (const e of this.events) {
      const row = out[e.name];
      row.count++;
      row.totalMs += e.ms;
      row.maxMs = Math.max(row.maxMs, e.ms);
      row.bySource[e.source] = (row.bySource[e.source] ?? 0) + 1;
    }
    return out;
  }

  reset(): void {
    this.events.length = 0;
    this.states.length = 0;
    this.turns.length = 0;
    this.turn = 0;
    this.current = null;
    this.lastTurnEndedAt = null;
  }
}

export const audioMetrics = new AudioMetrics();

/**
 * Dev-only full audio call-chain view. Exposes the live trace on `window` and
 * logs a compact table; production builds do nothing.
 */
let installedUnsub: (() => void) | undefined;
export function installDevTrace(metrics: AudioMetrics = audioMetrics): (() => void) | undefined {
  if (!audioTelemetryEnabled() || typeof window === "undefined") return undefined;
  if (installedUnsub) return installedUnsub; // StrictMode double-effect safe
  const w = window as unknown as Record<string, unknown>;
  w.__B9_AUDIO_TRACE__ = () => metrics.trace();
  w.__B9_AUDIO_METRICS__ = () => metrics.summary();
  w.__B9_AUDIO_CHAIN__ = () => metrics.trace().states;
  installedUnsub = metrics.subscribe((e) => {
    if (typeof console !== "undefined") console.debug(`[audio] ${e.name}=${e.ms}ms source=${e.source} step=${e.stepIndex ?? "-"}${e.detail ? ` ${e.detail}` : ""}`);
  });
  return installedUnsub;
}
