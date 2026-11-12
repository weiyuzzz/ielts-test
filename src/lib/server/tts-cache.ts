/**
 * Process-local LRU cache for synthesised examiner clips.
 *
 * Examiner lines repeat constantly (fixed script, re-tests, "Test voice", reloads),
 * and local/CPU TTS takes seconds per line. Caching the finished audio turns those
 * repeats into a sub-millisecond read. Entries are keyed by everything that changes
 * the audio, so switching voice/speed/format/prosody never serves a stale clip.
 *
 * In-flight jobs are priority-aware and cancellable:
 *   "live"      a GET stream triggered by actual playback (highest priority)
 *   "prefetch"  a background POST warm-up (best effort, may be cancelled)
 * A live request never has to queue behind a prefetch; the prefetch for the same
 * line is aborted so the engine spends its time on what the candidate is hearing.
 */
import { createHash } from "node:crypto";

export interface CachedClip {
  audio: Uint8Array;
  mimeType: string;
}

const MAX_ENTRIES = Number(process.env.TTS_CACHE_ENTRIES || 80);
const MAX_BYTES = Number(process.env.TTS_CACHE_BYTES || 32 * 1024 * 1024);

const entries = new Map<string, CachedClip>();

export type TtsJobPriority = "live" | "prefetch";

interface InflightJob {
  promise: Promise<unknown>;
  priority: TtsJobPriority;
  controller: AbortController;
}

/** In-flight synthesis/collection promises, so concurrent requests share one job. */
const inflight = new Map<string, InflightJob>();
let totalBytes = 0;

export function ttsCacheKey(parts: (string | number | boolean | undefined | null)[]): string {
  return createHash("sha256").update(parts.map((p) => String(p ?? "")).join("\u0001")).digest("hex");
}

export function getClip(key: string): CachedClip | undefined {
  const hit = entries.get(key);
  if (!hit) return undefined;
  // refresh LRU order
  entries.delete(key);
  entries.set(key, hit);
  return hit;
}

export function putClip(key: string, clip: CachedClip): void {
  const old = entries.get(key);
  if (old) {
    totalBytes -= old.audio.byteLength;
    entries.delete(key);
  }
  entries.set(key, clip);
  totalBytes += clip.audio.byteLength;
  while (entries.size > MAX_ENTRIES || totalBytes > MAX_BYTES) {
    const oldest = entries.keys().next().value as string | undefined;
    if (!oldest) break;
    const e = entries.get(oldest);
    entries.delete(oldest);
    if (e) totalBytes -= e.audio.byteLength;
  }
}

/**
 * Share one job between concurrent requests for the same line, with priority.
 * A `live` request cancels an in-flight `prefetch` instead of waiting for it.
 */
export function withInflightPriority<T>(
  key: string,
  priority: TtsJobPriority,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const existing = inflight.get(key);
  if (existing) {
    const liveBeatsPrefetch = priority === "live" && existing.priority === "prefetch";
    if (!liveBeatsPrefetch) return existing.promise as Promise<T>;
    // Cancel the best-effort warm-up. Its caller (prefetch) will get an abort
    // and simply not cache the clip — the live stream repopulates the cache.
    existing.controller.abort();
    inflight.delete(key);
  }
  const controller = new AbortController();
  // Invoke `fn` SYNCHRONOUSLY so its AbortSignal listener is registered before
  // this call returns. A live GET arriving in the same tick must be able to
  // cancel a prefetch that was only just started.
  let started: Promise<T>;
  try {
    started = Promise.resolve(fn(controller.signal));
  } catch (e) {
    started = Promise.reject(e);
  }
  const job: InflightJob = { controller, priority, promise: started };
  // Guard the cleanup with identity: an aborted older job must never delete a
  // newer job that has since taken the same key.
  job.promise = started.finally(() => {
    if (inflight.get(key) === job) inflight.delete(key);
  });
  inflight.set(key, job);
  return job.promise as Promise<T>;
}

/** Backwards-compatible wrapper: a plain shared job with no priority. */
export function withInflight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return withInflightPriority(key, "prefetch", fn);
}

export function pendingClip(key: string): Promise<unknown> | undefined {
  return inflight.get(key)?.promise;
}

export function activeJobPriority(key: string): TtsJobPriority | null {
  return inflight.get(key)?.priority ?? null;
}

/** Cancel a best-effort prefetch job so a live playback can start immediately. */
export function cancelPrefetchJob(key: string): boolean {
  const job = inflight.get(key);
  if (!job || job.priority !== "prefetch") return false;
  job.controller.abort();
  inflight.delete(key);
  return true;
}

export function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
