/**
 * Process-local LRU cache for synthesised examiner clips.
 *
 * Examiner lines repeat constantly (fixed script, re-tests, "Test voice", reloads),
 * and local/CPU TTS takes seconds per line. Caching the finished audio turns those
 * repeats into a sub-millisecond read. Entries are keyed by everything that changes
 * the audio, so switching voice/speed/format/prosody never serves a stale clip.
 */
import { createHash } from "node:crypto";

export interface CachedClip {
  audio: Uint8Array;
  mimeType: string;
}

const MAX_ENTRIES = Number(process.env.TTS_CACHE_ENTRIES || 80);
const MAX_BYTES = Number(process.env.TTS_CACHE_BYTES || 32 * 1024 * 1024);

const entries = new Map<string, CachedClip>();
/** In-flight synthesis promises, so concurrent requests for one line share one job. */
const inflight = new Map<string, Promise<unknown>>();
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

/** Share one synthesis job between concurrent requests for the same line. */
export function withInflight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export function pendingClip(key: string): Promise<unknown> | undefined {
  return inflight.get(key);
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
