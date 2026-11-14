/**
 * Question-bank data integrity guard.
 *
 * Run with: npx tsx --test tests/bank-data.test.ts
 *
 * Why this exists: the 2026-09-12 bank was scraped from a table whose columns
 * drifted, which produced rows like "How often?" (English cell lost, Chinese
 * cell kept) and "Does this time work for you?" (a vocabulary note swallowed the
 * question). Those shipped into real mock exams. These assertions catch the same
 * class of corruption at CI time instead of in a user's exam.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

interface Q { text?: string; textZh?: string; cuePoints?: string[]; gate?: boolean; audience?: string }
interface Topic { key: string; name: string; part1?: Q[]; part2?: Q[]; part3?: Q[] }
interface Bank { season: string; topics: Topic[] }

const dir = path.join(process.cwd(), "src", "data", "question-banks");
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

/** Phrases that only ever appeared because of a bad scrape, never as a question. */
const KNOWN_JUNK = [/^how often\??$/i, /does this time work for you/i];

for (const file of files) {
  const bank = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as Bank;

  test(`bank ${file}: every question has usable text`, () => {
    for (const t of bank.topics) {
      for (const part of ["part1", "part2", "part3"] as const) {
        for (const q of t[part] ?? []) {
          const text = (q.text ?? "").trim();
          assert.ok(text.length >= 12, `${file} ${t.key}/${part}: question too short: ${JSON.stringify(text)}`);
          for (const junk of KNOWN_JUNK) {
            assert.equal(junk.test(text), false, `${file} ${t.key}/${part}: known junk row ${JSON.stringify(text)}`);
          }
        }
      }
    }
  });

  test(`bank ${file}: Part 1 and Part 3 are questions; Part 2 is a cue card`, () => {
    for (const t of bank.topics) {
      for (const part of ["part1", "part3"] as const) {
        for (const q of t[part] ?? []) {
          const text = (q.text ?? "").trim();
          assert.ok(text.endsWith("?"), `${file} ${t.key}/${part}: not phrased as a question: ${JSON.stringify(text)}`);
        }
      }
      for (const q of t.part2 ?? []) {
        const text = (q.text ?? "").trim();
        assert.ok(text.length > 0, `${file} ${t.key}/part2: empty cue card`);
      }
    }
  });

  test(`bank ${file}: no duplicate question inside a topic/part`, () => {
    for (const t of bank.topics) {
      for (const part of ["part1", "part2", "part3"] as const) {
        const texts = (t[part] ?? []).map((q) => (q.text ?? "").trim().toLowerCase()).filter(Boolean);
        assert.equal(new Set(texts).size, texts.length, `${file} ${t.key}/${part}: duplicate question text`);
      }
    }
  });

  test(`bank ${file}: Chinese hints are not polluted with vocab notes`, () => {
    for (const t of bank.topics) {
      for (const part of ["part1", "part2", "part3"] as const) {
        for (const q of t[part] ?? []) {
          const zh = (q.textZh ?? "").trim();
          // A note that swallowed a neighbouring cell contains bullet markers or a
          // second English question inside the Chinese hint.
          assert.equal(zh.includes("•"), false, `${file} ${t.key}/${part}: textZh contains a concatenated note`);
          assert.equal(/[A-Za-z]{4,}.*\?/.test(zh), false, `${file} ${t.key}/${part}: textZh contains another question`);
        }
      }
    }
  });

  test(`bank ${file}: gate questions are topic openers and audiences are valid`, () => {
    for (const t of bank.topics) {
      const p1 = t.part1 ?? [];
      const gates = p1.filter((q) => q.gate === true);
      assert.ok(gates.length <= 1, `${file} ${t.key}: more than one gate question`);
      if (gates.length) {
        assert.equal(p1[0]?.gate, true, `${file} ${t.key}: gate question must be the first entry of part1`);
      }
      for (let i = 0; i < p1.length; i++) {
        const q = p1[i];
        if (q.audience !== undefined) {
          assert.ok(q.audience === "student" || q.audience === "work", `${file} ${t.key}/part1[${i}]: invalid audience ${JSON.stringify(q.audience)}`);
          assert.ok(gates.length > 0, `${file} ${t.key}: audience-tagged question without a gate question`);
        }
        if (q.gate === true) {
          assert.equal(q.audience, undefined, `${file} ${t.key}: the gate question itself must not carry an audience`);
        }
      }
      for (const part of ["part2", "part3"] as const) {
        for (const q of t[part] ?? []) {
          assert.equal(q.gate, undefined, `${file} ${t.key}/${part}: gate only applies to part1`);
          assert.equal(q.audience, undefined, `${file} ${t.key}/${part}: audience only applies to part1`);
        }
      }
    }
  });
}
