/**
 * Unified TTS task scheduler (framework-free, unit-testable).
 *
 * Replaces the old FIFO `queue` in speech.ts. Every synthesis job is a task with
 * an explicit priority, a stable identity key and a cancellable AbortSignal:
 *
 *   CURRENT(0)    the line being played right now          — never preempted
 *   NEXT(1)       the next question / fixed line           — may preempt LOW
 *   BACKGROUND(2) later script lines                      — filled while idle
 *   LOW(3)        repeat forms, no-response / backup lines — first to be cut
 *
 * Guarantees:
 *  - one job per (text, voice, model, format): requesting the same line again
 *    returns the SAME promise, and a higher priority request *promotes* it.
 *  - a high-priority request never waits behind a full queue: a lower-priority
 *    running job is aborted and requeued to free a slot (bounded preemption).
 *  - `request()` returns a promise AND a subscribable status, so the UI can
 *    tell which resources are ready instead of firing and forgetting.
 *  - failures are not cached forever, but repeated low-priority re-requests
 *    cannot create an infinite retry storm (bounded attempts).
 */
export const TTS_PRIORITY = {
  CURRENT: 0,
  NEXT: 1,
  BACKGROUND: 2,
  LOW: 3,
} as const;
export type TtsPriority = (typeof TTS_PRIORITY)[keyof typeof TTS_PRIORITY];

export type TtsTaskStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

export interface TtsKeyParts {
  text: string;
  voice: string;
  model: string;
  format?: string;
  /** Examiner speech act (greeting / question / closing …). Part of the identity:
   *  the same sentence delivered as a question and as a closing must not share a clip. */
  act?: string;
  /** VoiceProfile id (or "provider:voice"); omitted when the deployment default applies. */
  profile?: string;
}

export interface TtsTaskSnapshot {
  key: string;
  text: string;
  voice: string;
  model: string;
  format: string;
  /** Speech act used for this synthesis ("" when not applicable). */
  act: string;
  /** VoiceProfile id used for this synthesis ("" when the default applies). */
  profile: string;
  priority: TtsPriority;
  status: TtsTaskStatus;
  attempts: number;
  hasResource: boolean;
}

export interface TtsRequest<T> {
  key: string;
  /** Resolves with the resource, or null when the job failed / was cancelled. */
  promise: Promise<T | null>;
  /** Current status (live, not a copy). */
  status: () => TtsTaskStatus;
  ready: () => boolean;
  /** Promote an already-queued / running task (used when playback starts). */
  promote: (priority: TtsPriority) => void;
  cancel: () => void;
}

export interface TtsSchedulerOptions<T> {
  /** Perform one synthesis. Must honour the AbortSignal. */
  run: (task: TtsTaskSnapshot, signal: AbortSignal) => Promise<T | null>;
  maxParallel?: number;
  maxAttempts?: number;
  maxCache?: number;
  keyOf?: (parts: TtsKeyParts) => string;
  /** Release a resource (e.g. revoke a blob URL) when it is evicted / disposed. */
  release?: (resource: T) => void;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
}

interface InternalTask<T> extends TtsTaskSnapshot {
  seq: number;
  parts: Required<TtsKeyParts>;
  promise: Promise<T | null>;
  resolve: (v: T | null) => void;
  controller: AbortController;
  resource: T | null;
  runId: number;
  lastStateAt: number;
}

export function ttsTaskKey(parts: TtsKeyParts): string {
  // Model + format + speech act + voice profile are all part of the identity:
  // changing the engine, voice, delivery or format must never reuse a clip
  // produced by a different configuration.
  return [
    parts.model, parts.voice, parts.format, parts.act ?? "", parts.profile ?? "", parts.text,
  ].join("\u0000");
}

export class TtsScheduler<T> {
  private readonly tasks = new Map<string, InternalTask<T>>();
  private readonly listeners = new Set<(snapshot: TtsTaskSnapshot[]) => void>();
  private readonly run: TtsSchedulerOptions<T>["run"];
  private readonly maxParallel: number;
  private readonly maxAttempts: number;
  private readonly maxCache: number;
  private readonly keyOf: (parts: TtsKeyParts) => string;
  private readonly release?: (resource: T) => void;
  private readonly now: () => number;
  private running = new Set<string>();
  private seq = 0;
  private disposed = false;

  constructor(opts: TtsSchedulerOptions<T>) {
    this.run = opts.run;
    this.maxParallel = Math.max(1, opts.maxParallel ?? 2);
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    this.maxCache = Math.max(1, opts.maxCache ?? 60);
    this.keyOf = opts.keyOf ?? ttsTaskKey;
    this.release = opts.release;
    this.now = opts.now ?? (() => Date.now());
  }

  request(parts: TtsKeyParts, priority: TtsPriority = TTS_PRIORITY.BACKGROUND): TtsRequest<T> {
    const full: Required<TtsKeyParts> = { format: "default", act: "", profile: "", ...parts };
    const key = this.keyOf(full);
    if (this.disposed) {
      // No work may start after teardown, and the promise must still settle so
      // callers awaiting it cannot hang on exam exit.
      return {
        key, promise: Promise.resolve(null), status: () => "cancelled", ready: () => false,
        promote: () => {}, cancel: () => {},
      };
    }
    const existing = this.tasks.get(key);

    if (existing && existing.status !== "failed" && existing.status !== "cancelled") {
      this.promote(key, priority);
      return this.wrap(existing);
    }

    // A CURRENT request is a real playback: always allow one more attempt, but
    // still bound it so a permanently broken engine cannot spin forever.
    if (existing) {
      if (priority === TTS_PRIORITY.CURRENT && existing.attempts < this.maxAttempts + 2) {
        existing.status = "queued";
        existing.resource = null;
        existing.resolve(null); // settle the old promise; callers already moved on
        existing.promise = new Promise<T | null>((res) => { existing.resolve = res; });
        existing.controller = new AbortController();
      } else {
        return this.wrap(existing); // failed and exhausted → resolve null, no new job
      }
    }

    const task = this.makeTask(key, full, priority, existing?.attempts ?? 0);
    this.tasks.set(key, task);
    this.enqueue(task);
    return this.wrap(task);
  }

  private makeTask(key: string, parts: Required<TtsKeyParts>, priority: TtsPriority, attempts: number): InternalTask<T> {
    let resolve!: (v: T | null) => void;
    const promise = new Promise<T | null>((res) => { resolve = res; });
    const t: InternalTask<T> = {
      key, parts, text: parts.text, voice: parts.voice, model: parts.model, format: parts.format,
      act: parts.act ?? "", profile: parts.profile ?? "",
      priority, status: "queued", attempts, hasResource: false,
      seq: this.seq++, promise, resolve, controller: new AbortController(),
      resource: null, runId: 0, lastStateAt: this.now(),
    };
    return t;
  }

  private wrap(t: InternalTask<T>): TtsRequest<T> {
    return {
      key: t.key,
      promise: t.promise,
      status: () => t.status,
      ready: () => t.status === "ready" && t.resource !== null,
      promote: (p) => this.promote(t.key, p),
      cancel: () => this.cancel(t.key),
    };
  }

  /** Raise the priority of a pending task; never lowers it. */
  promote(key: string, priority: TtsPriority): void {
    const t = this.tasks.get(key);
    if (!t || this.disposed) return;
    if (priority >= t.priority) return; // lower number = more urgent
    t.priority = priority;
    t.lastStateAt = this.now();
    this.emit();
    // If a more urgent task arrived while all slots are busy with low-priority
    // work, free a slot immediately instead of waiting for a slow synthesis.
    if (priority <= TTS_PRIORITY.NEXT && this.running.size >= this.maxParallel) {
      this.preemptOne(priority);
    }
    this.pump();
  }

  /** Abort the least-urgent running job so a higher-priority one can start. */
  private preemptOne(incoming: TtsPriority): void {
    let victim: InternalTask<T> | null = null;
    for (const key of this.running) {
      const t = this.tasks.get(key);
      if (!t || t.priority <= incoming) continue;
      if (!victim || t.priority > victim.priority || (t.priority === victim.priority && t.seq > victim.seq)) victim = t;
    }
    if (!victim) return;
    victim.controller.abort();
    victim.runId++; // invalidate the in-flight completion handler
    this.running.delete(victim.key);
    victim.status = "queued";
    victim.controller = new AbortController();
    victim.lastStateAt = this.now();
    this.emit();
  }

  private enqueue(t: InternalTask<T>): void {
    t.status = "queued";
    t.lastStateAt = this.now();
    this.emit();
    if (t.priority <= TTS_PRIORITY.NEXT && this.running.size >= this.maxParallel) this.preemptOne(t.priority);
    this.pump();
  }

  private pump(): void {
    if (this.disposed) return;
    const queued = [...this.tasks.values()]
      .filter((t) => t.status === "queued")
      .sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    for (const t of queued) {
      if (this.running.size >= this.maxParallel) break;
      this.start(t);
    }
  }

  private start(t: InternalTask<T>): void {
    t.status = "running";
    t.attempts++;
    t.lastStateAt = this.now();
    const runId = ++t.runId;
    const signal = t.controller.signal;
    this.running.add(t.key);
    this.emit();
    void Promise.resolve()
      .then(() => this.run(this.snapshot(t), signal))
      .then((resource) => {
        // A preempted / cancelled run must not overwrite the newer state.
        if (t.runId !== runId || this.disposed) return;
        this.running.delete(t.key);
        if (resource !== null) {
          t.resource = resource;
          t.hasResource = true;
          t.status = "ready";
          t.resolve(resource);
          this.evict();
        } else {
          t.status = "failed";
          t.resolve(null);
        }
        t.lastStateAt = this.now();
        this.emit();
        this.pump();
      })
      .catch(() => {
        if (t.runId !== runId || this.disposed) return;
        this.running.delete(t.key);
        t.status = "failed";
        t.resolve(null);
        t.lastStateAt = this.now();
        this.emit();
        this.pump();
      });
  }

  /** Bound memory: drop the oldest LOW/BACKGROUND ready resources first. */
  private evict(): void {
    const ready = [...this.tasks.values()].filter((t) => t.status === "ready");
    if (ready.length <= this.maxCache) return;
    ready.sort((a, b) => b.priority - a.priority || a.lastStateAt - b.lastStateAt);
    for (const t of ready.slice(0, ready.length - this.maxCache)) {
      if (t.resource !== null) this.release?.(t.resource);
      t.resource = null;
      t.hasResource = false;
      t.status = "cancelled";
      this.tasks.delete(t.key);
      t.resolve(null);
    }
    this.emit();
  }

  private snapshot(t: InternalTask<T>): TtsTaskSnapshot {
    return {
      key: t.key, text: t.text, voice: t.voice, model: t.model, format: t.format,
      act: t.act, profile: t.profile,
      priority: t.priority, status: t.status, attempts: t.attempts, hasResource: t.hasResource,
    };
  }

  cancel(key: string): void {
    const t = this.tasks.get(key);
    if (!t) return;
    if (this.running.has(key)) {
      t.controller.abort();
      t.runId++;
      this.running.delete(key);
    }
    if (t.resource !== null) {
      this.release?.(t.resource);
      t.resolve(null);
    }
    t.status = "cancelled";
    t.resource = null;
    t.hasResource = false;
    this.tasks.delete(key);
    this.emit();
    this.pump();
  }

  /** Cancel everything below a priority (used when the current line changes). */
  cancelBelow(priority: TtsPriority): void {
    for (const t of [...this.tasks.values()]) {
      if (t.priority > priority && t.status !== "ready") this.cancel(t.key);
    }
  }

  status(key: string): TtsTaskStatus | undefined {
    return this.tasks.get(key)?.status;
  }

  get(key: string): T | null {
    const t = this.tasks.get(key);
    return t?.status === "ready" ? t.resource : null;
  }

  snapshotAll(): TtsTaskSnapshot[] {
    return [...this.tasks.values()].map((t) => this.snapshot(t));
  }

  /** Subscribe to readiness changes. Returns an unsubscribe function. */
  subscribe(fn: (snapshot: TtsTaskSnapshot[]) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshotAll());
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    if (!this.listeners.size) return;
    const s = this.snapshotAll();
    for (const fn of this.listeners) {
      try { fn(s); } catch { /* a bad listener must not break synthesis */ }
    }
  }

  /** Stop every task and release resources. Called when the user exits the exam. */
  dispose(): void {
    this.disposed = true;
    for (const t of this.tasks.values()) {
      t.controller.abort();
      t.runId++;
      if (t.resource !== null) this.release?.(t.resource);
      t.status = "cancelled";
      t.resolve(null);
    }
    this.tasks.clear();
    this.running.clear();
    this.emit();
    this.listeners.clear();
  }

  /** Re-arm after a dev-mode StrictMode remount (same module instance). */
  rearm(): void {
    this.disposed = false;
  }
}
