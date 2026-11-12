/**
 * Learning sidecar storage tests (atomic writes, per-season serialisation,
 * config diagnostics, corrupt-file recovery).
 *
 * Run with: npx tsx --test tests/learning-store.test.ts
 *
 * These use a real temp directory — no mocks — because the thing under test is
 * filesystem behaviour.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  contentDirInfo, parseSeasonFile, probeContentDir, readSeasonFile,
  upsertSeasonEntries, type SeasonEntry,
} from "../src/lib/content/store";

const SEASON = "2026-09-12";

function entry(text: string, topicKey = "hometown"): SeasonEntry {
  return {
    topicKey, part: 1, text,
    learning: {
      sampleAnswer: {
        paragraphs: [`Sample answer for: ${text}`],
        source: { kind: "team", label: "test fixture" },
        reviewStatus: "draft",
        targetBandHint: null,
      },
      ideaNotes: [],
      keyPhrases: [],
      followAudio: null,
    },
  };
}

/** Run `fn` with LEARNING_CONTENT_DIR pointed at a fresh temp directory. */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "b9-learning-"));
  const prev = process.env.LEARNING_CONTENT_DIR;
  process.env.LEARNING_CONTENT_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.LEARNING_CONTENT_DIR;
    else process.env.LEARNING_CONTENT_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("store: upsert writes a readable season file (atomic replace)", async () => {
  await withTempDir(async (dir) => {
    const n = await upsertSeasonEntries(SEASON, "大陆地区", [entry("Where is your hometown?")]);
    assert.equal(n, 1);

    const raw = await readFile(path.join(dir, `${SEASON}.json`), "utf8");
    assert.ok(raw.endsWith("\n"), "file ends with a newline");
    const parsed = JSON.parse(raw) as { version: number; season: string; entries: unknown[] };
    assert.equal(parsed.season, SEASON);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.entries.length, 1);

    const loaded = await readSeasonFile(SEASON);
    assert.equal(loaded.warnings.length, 0);
    assert.equal(loaded.file?.entries[0].text, "Where is your hometown?");
  });
});

test("store: upsert is idempotent per content key", async () => {
  await withTempDir(async () => {
    await upsertSeasonEntries(SEASON, undefined, [entry("Where is your hometown?")]);
    const n = await upsertSeasonEntries(SEASON, undefined, [entry("Where is your hometown?")]);
    assert.equal(n, 1, "same (part, topicKey, text) replaces rather than duplicates");
  });
});

test("store: concurrent upserts do not lose entries (per-season serialisation)", async () => {
  await withTempDir(async () => {
    const texts = Array.from({ length: 6 }, (_, i) => `Question number ${i + 1}?`);
    // Fired together: without the in-process lock these read-modify-write cycles
    // interleave and the last writer drops the others.
    await Promise.all(texts.map((t) => upsertSeasonEntries(SEASON, undefined, [entry(t)])));
    const loaded = await readSeasonFile(SEASON);
    assert.equal(loaded.warnings.length, 0);
    const stored = (loaded.file?.entries ?? []).map((e) => e.text).sort();
    assert.deepEqual(stored, [...texts].sort());
  });
});

test("store: a corrupt sidecar does not block a later successful write", async () => {
  await withTempDir(async (dir) => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${SEASON}.json`), "{ this is not json", "utf8");

    const broken = await readSeasonFile(SEASON);
    assert.equal(broken.file, null);
    assert.ok(broken.warnings.length > 0, "parse failure is reported, not thrown");

    const n = await upsertSeasonEntries(SEASON, undefined, [entry("Where is your hometown?")]);
    assert.equal(n, 1);
    const ok = await readSeasonFile(SEASON);
    assert.equal(ok.warnings.length, 0);
    assert.equal(ok.file?.entries.length, 1);
  });
});

test("store: probeContentDir reports an unusable path instead of pretending it works", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "b9-probe-"));
  const asFile = path.join(dir, "not-a-dir");
  const prev = process.env.LEARNING_CONTENT_DIR;
  try {
    await writeFile(asFile, "x", "utf8");
    process.env.LEARNING_CONTENT_DIR = asFile;
    const probe = await probeContentDir();
    assert.equal(probe.ok, false);
    assert.equal(probe.writable, false);
    assert.ok(probe.error && probe.error.length > 0, "error explains the problem");
  } finally {
    if (prev === undefined) delete process.env.LEARNING_CONTENT_DIR;
    else process.env.LEARNING_CONTENT_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("store: config diagnostics warn about the source-tree default and relative paths", () => {
  const prev = process.env.LEARNING_CONTENT_DIR;
  try {
    delete process.env.LEARNING_CONTENT_DIR;
    const def = contentDirInfo();
    assert.equal(def.isDefault, true);
    assert.equal(def.source, "default");
    assert.ok(def.warnings.some((w) => /read-only|persistent/i.test(w)), "default dir is flagged as unsafe for production");

    process.env.LEARNING_CONTENT_DIR = "relative/learning";
    const rel = contentDirInfo();
    assert.equal(rel.source, "env");
    assert.equal(rel.absolute, true, "relative paths are resolved");
    assert.ok(rel.warnings.some((w) => /relative/i.test(w)), "relative path is flagged");

    process.env.LEARNING_CONTENT_DIR = path.join(tmpdir(), "abs-learning");
    const abs = contentDirInfo();
    assert.equal(abs.absolute, true);
    assert.equal(abs.warnings.length, 0, "an absolute path is not flagged");
  } finally {
    if (prev === undefined) delete process.env.LEARNING_CONTENT_DIR;
    else process.env.LEARNING_CONTENT_DIR = prev;
  }
});

test("store: untrusted season files are sanitised, never trusted", () => {
  assert.equal(parseSeasonFile({ season: "not/a/season" }).file, null);
  assert.equal(parseSeasonFile(null).file, null);

  const parsed = parseSeasonFile({
    season: SEASON,
    entries: [
      { topicKey: "hometown", part: 1, text: "Where is your hometown?" },
      { topicKey: "hometown", part: 9, text: "wrong part" },
      { topicKey: "", part: 1, text: "no topic key" },
      { topicKey: "hometown", part: 2, text: "" },
    ],
  });
  assert.equal(parsed.file?.entries.length, 1, "only the valid entry survives");
  assert.ok(parsed.warnings.length >= 3, "each dropped entry is explained");
});
