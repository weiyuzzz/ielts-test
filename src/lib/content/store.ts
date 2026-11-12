/**
 * Sidecar storage for learning content — one versioned JSON file per season.
 *
 * Why a file and not a column: `src/db/schema.ts` is owned by the shared
 * interface and is frozen for this phase; it has no `learningContent` column.
 * A sidecar also has a useful property — study material physically cannot leak
 * into an exam query, because no exam query reads this file.
 *
 * Layout (default `src/data/learning/<season>.json`, override with
 * `LEARNING_CONTENT_DIR`):
 *
 *   {
 *     "version": 1,
 *     "season": "2026-09-12",
 *     "region": "大陆地区",
 *     "entries": [
 *       { "topicKey": "hometown", "part": 1, "text": "Where is your hometown?",
 *         "learning": { "sampleAnswer": {...}, "ideaNotes": [...], ... } }
 *     ]
 *   }
 *
 * Entries are matched to questions by (part, topicKey, normalised text), not by
 * row id: `importBank()` deletes and reinserts a season, so ids are not stable
 * across imports and would silently detach the content.
 */
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  contentKey,
  sanitizeLearning,
} from "./validate";
import {
  EMPTY_LEARNING,
  hasLearning,
  type QuestionLearningContent,
} from "./types";

export const LEARNING_VERSION = 1;
const DEFAULT_DIR = path.join(process.cwd(), "src", "data", "learning");

export interface ContentDirInfo {
  dir: string;
  source: "env" | "default";
  isDefault: boolean;
  absolute: boolean;
  /** Human-readable configuration problems, surfaced by /admin and the docs. */
  warnings: string[];
}

/**
 * Where the sidecar lives, and why that may be wrong in production.
 *
 * The default sits inside the application source tree. That is fine for local
 * development, but on a read-only image / serverless runtime the write fails,
 * and on redeploy the directory is replaced so content is lost. We cannot pick
 * a deployment-specific volume for the operator, so we report it explicitly.
 */
export function contentDirInfo(): ContentDirInfo {
  const raw = process.env.LEARNING_CONTENT_DIR?.trim();
  const warnings: string[] = [];
  if (raw) {
    const absolute = path.isAbsolute(raw);
    if (!absolute) {
      warnings.push(`LEARNING_CONTENT_DIR="${raw}" is relative and is resolved against the working directory (${process.cwd()}). Use an absolute path in production.`);
    }
    return { dir: absolute ? raw : path.resolve(process.cwd(), raw), source: "env", isDefault: false, absolute: true, warnings };
  }
  warnings.push("Using the default learning directory inside the application source tree. Writes fail on a read-only filesystem and content is lost when the image or code is replaced. Set LEARNING_CONTENT_DIR to a persistent, writable volume in production.");
  return { dir: DEFAULT_DIR, source: "default", isDefault: true, absolute: path.isAbsolute(DEFAULT_DIR), warnings };
}

export function contentDir(): string {
  return contentDirInfo().dir;
}

/** Turn a raw fs error into an actionable message (permissions, read-only, disk). */
function writeError(e: unknown, target: string): Error {
  const err = e as NodeJS.ErrnoException;
  const base = `cannot write learning content to ${target}`;
  switch (err.code) {
    case "EACCES":
    case "EPERM":
      return new Error(`${base}: permission denied. Point LEARNING_CONTENT_DIR at a writable directory.`);
    case "EROFS":
      return new Error(`${base}: read-only filesystem. Point LEARNING_CONTENT_DIR at a writable persistent volume.`);
    case "ENOSPC":
      return new Error(`${base}: no space left on device.`);
    case "ENOTDIR":
    case "EEXIST":
      return new Error(`${base}: path is not a usable directory.`);
    default:
      return new Error(`${base}: ${err.message ?? String(e)}`);
  }
}

/**
 * Atomic JSON write: write a sibling temp file, then rename over the target.
 * A crash mid-write leaves the previous file intact instead of a truncated one.
 * rename() is atomic within a filesystem on POSIX and replaces on Windows.
 */
async function writeJsonAtomic(file: string, payload: unknown): Promise<void> {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, body, "utf8");
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw writeError(e, file);
  }
}

/**
 * Serialise read-modify-write per season INSIDE this process.
 *
 * Two concurrent imports of the same season would otherwise both read the old
 * file and the last writer would silently drop the other's entries.
 *
 * This is process-local only. It does NOT provide consistency across multiple
 * processes or instances — that needs a shared store (object storage or the DB).
 */
const seasonChains = new Map<string, Promise<unknown>>();
function withSeasonLock<T>(season: string, fn: () => Promise<T>): Promise<T> {
  const prev = seasonChains.get(season) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  seasonChains.set(season, tail);
  void tail.then(() => { if (seasonChains.get(season) === tail) seasonChains.delete(season); });
  return run;
}

/** Probe the configured directory once (used by /admin and ops checks). */
export async function probeContentDir(): Promise<{ ok: boolean; dir: string; writable: boolean; error?: string }> {
  const { dir } = contentDirInfo();
  const probe = path.join(dir, `.probe-${process.pid}-${Date.now()}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, "ok", "utf8");
    await unlink(probe);
    return { ok: true, dir, writable: true };
  } catch (e) {
    return { ok: false, dir, writable: false, error: writeError(e, dir).message };
  }
}

export interface SeasonEntry {
  topicKey: string;
  part: number;
  text: string;
  learning: QuestionLearningContent;
}

export interface SeasonFile {
  version: number;
  season: string;
  region?: string;
  notes?: string;
  entries: SeasonEntry[];
}

export interface LoadResult {
  file: SeasonFile | null;
  warnings: string[];
}

const SEASON_RE = /^[0-9A-Za-z._-]{1,40}$/;

function emptyLearning(): QuestionLearningContent {
  return { ...EMPTY_LEARNING, ideaNotes: [], keyPhrases: [] };
}

/** Parse an untrusted season file. Optional content is dropped, never fatal. */
export function parseSeasonFile(raw: unknown): LoadResult {
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object") return { file: null, warnings: ["season file is not an object"] };
  const r = raw as Record<string, unknown>;
  const season = typeof r.season === "string" ? r.season.trim() : "";
  if (!SEASON_RE.test(season)) return { file: null, warnings: ["season file has no valid season key"] };
  const entries: SeasonEntry[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(r.entries) ? r.entries : [];
  list.forEach((e, i) => {
    const x = (e ?? {}) as Record<string, unknown>;
    const topicKey = typeof x.topicKey === "string" ? x.topicKey.trim() : "";
    const part = Number(x.part);
    const text = typeof x.text === "string" ? x.text.trim() : "";
    if (!topicKey || !text || ![1, 2, 3].includes(part)) {
      warnings.push(`entry ${i}: skipped (topicKey/part/text required)`);
      return;
    }
    const { learning, warnings: w } = sanitizeLearning(x.learning, `entry ${i} (${topicKey})`);
    warnings.push(...w);
    const key = contentKey(part, topicKey, text);
    if (seen.has(key)) {
      warnings.push(`entry ${i}: duplicate key for "${text.slice(0, 40)}" — last one wins`);
    }
    seen.add(key);
    entries.push({ topicKey, part, text, learning: hasLearning(learning) ? learning : emptyLearning() });
  });
  return {
    file: {
      version: typeof r.version === "number" ? r.version : LEARNING_VERSION,
      season,
      region: typeof r.region === "string" ? r.region : undefined,
      notes: typeof r.notes === "string" ? r.notes : undefined,
      entries,
    },
    warnings,
  };
}

export async function readSeasonFile(season: string): Promise<LoadResult> {
  if (!SEASON_RE.test(season)) return { file: null, warnings: [`invalid season key: ${season}`] };
  const file = path.join(contentDir(), `${season}.json`);
  try {
    const text = await readFile(file, "utf8");
    return parseSeasonFile(JSON.parse(text));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { file: null, warnings: [] };
    return { file: null, warnings: [`cannot read ${file}: ${(e as Error).message}`] };
  }
}

/** Map keyed by `contentKey(part, topicKey, text)`. */
export function buildIndex(entries: SeasonEntry[]): Map<string, QuestionLearningContent> {
  const index = new Map<string, QuestionLearningContent>();
  for (const e of entries) index.set(contentKey(e.part, e.topicKey, e.text), e.learning);
  return index;
}

export async function loadSeasonIndex(season: string): Promise<{ index: Map<string, QuestionLearningContent>; warnings: string[] }> {
  const { file, warnings } = await readSeasonFile(season);
  return { index: buildIndex(file?.entries ?? []), warnings };
}

/** Attach content to question rows (or to any object with part/topicKey/text). */
export function attachLearning<T extends { part: number; topicKey: string; text: string }>(
  rows: T[],
  index: Map<string, QuestionLearningContent>,
): Array<T & { learning: QuestionLearningContent }> {
  return rows.map((r) => ({ ...r, learning: index.get(contentKey(r.part, r.topicKey, r.text)) ?? emptyLearning() }));
}

export interface Coverage {
  total: number;
  withSampleAnswer: number;
  withFollowAudio: number;
  withAnyContent: number;
  reviewed: number;
  /** 0–100, one decimal. */
  sampleAnswerPercent: number;
}

export function computeCoverage(rows: Array<{ part: number; topicKey: string; text: string }>, index: Map<string, QuestionLearningContent>): Coverage {
  let withSampleAnswer = 0;
  let withFollowAudio = 0;
  let withAnyContent = 0;
  let reviewed = 0;
  for (const r of rows) {
    const c = index.get(contentKey(r.part, r.topicKey, r.text));
    if (!c) continue;
    if (c.sampleAnswer?.paragraphs?.length) {
      withSampleAnswer += 1;
      if (c.sampleAnswer.reviewStatus === "reviewed") reviewed += 1;
    }
    if (c.followAudio?.url) withFollowAudio += 1;
    if (hasLearning(c)) withAnyContent += 1;
  }
  const total = rows.length;
  return {
    total,
    withSampleAnswer,
    withFollowAudio,
    withAnyContent,
    reviewed,
    sampleAnswerPercent: total ? Math.round((withSampleAnswer / total) * 1000) / 10 : 0,
  };
}

/**
 * Merge entries into the season file (idempotent per content key) and write it.
 * Returns the number of entries in the file afterwards.
 */
export async function upsertSeasonEntries(season: string, region: string | undefined, entries: SeasonEntry[]): Promise<number> {
  if (!SEASON_RE.test(season)) throw new Error(`invalid season key: ${season}`);
  // Serialise read-modify-write for this season, then replace the file atomically.
  return withSeasonLock(season, async () => {
    const existing = await readSeasonFile(season);
    const merged = new Map<string, SeasonEntry>();
    for (const e of existing.file?.entries ?? []) merged.set(contentKey(e.part, e.topicKey, e.text), e);
    for (const e of entries) merged.set(contentKey(e.part, e.topicKey, e.text), e);
    const payload: SeasonFile = {
      version: LEARNING_VERSION,
      season,
      region: region ?? existing.file?.region,
      notes: existing.file?.notes,
      entries: [...merged.values()].filter((e) => hasLearning(e.learning)),
    };
    await writeJsonAtomic(path.join(contentDir(), `${season}.json`), payload);
    return payload.entries.length;
  });
}

/** Seasons that already have a content file (used by the admin overview). */
export async function listContentSeasons(): Promise<string[]> {
  try {
    const files = await readdir(contentDir());
    return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
  } catch {
    return [];
  }
}
