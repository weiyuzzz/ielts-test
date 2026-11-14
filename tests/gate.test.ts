/**
 * Part 1 gate-question branching.
 *
 * Run with: npx tsx --test tests/gate.test.ts
 *
 * Covers the two pure pieces of the gate flow: the transcript classifier that
 * decides which sub-bank the examiner draws from, and the bank-import mapping
 * that lands gate/audience tags on the right question rows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyWorkOrStudy } from "../src/lib/speaking/gate";
import { parseBank, deriveImportPlan } from "../src/lib/content/bank-import";

test("classifyWorkOrStudy: student answers", () => {
  assert.equal(classifyWorkOrStudy("I'm currently a student at university, studying computer science."), "student");
  assert.equal(classifyWorkOrStudy("I am a senior high school student preparing for my exams."), "student");
  assert.equal(classifyWorkOrStudy("I study chemistry; my major is really interesting."), "student");
});

test("classifyWorkOrStudy: work answers", () => {
  assert.equal(classifyWorkOrStudy("I work as a nurse in a local hospital."), "work");
  assert.equal(classifyWorkOrStudy("I have a full-time job at an IT company, my colleagues are great."), "work");
  assert.equal(classifyWorkOrStudy("I'm an office manager, I have been in this career for five years."), "work");
});

test("classifyWorkOrStudy: absent or ambiguous evidence stays neutral", () => {
  assert.equal(classifyWorkOrStudy(""), null);
  assert.equal(classifyWorkOrStudy("   "), null);
  assert.equal(classifyWorkOrStudy(null), null);
  assert.equal(classifyWorkOrStudy(undefined), null);
  assert.equal(classifyWorkOrStudy("It is fine, thank you."), null);
  // Both sides hit equally → no majority → keep the neutral follow-ups.
  assert.equal(classifyWorkOrStudy("I'm a student and I also work."), null);
  assert.equal(classifyWorkOrStudy("I used to work, now I'm back at school."), null);
});

test("bank import: gate/audience tags land on Part 1 rows only", () => {
  const bank = parseBank({
    season: "2026-09-12",
    topics: [
      {
        key: "work-or-studies", name: "Work or studies", type: "evergreen", category: "part1",
        part1: [
          { text: "Do you work, or are you a student?", gate: true },
          { text: "What subjects are you studying?", audience: "student" },
          { text: "What work do you do?", audience: "work" },
          { text: "What are the benefits of being your age?" },
        ],
        part2: [{ text: "Describe a job you would like to have in the future." }],
        part3: [{ text: "Why do you think people choose their careers?" }],
      },
    ],
  });
  assert.deepEqual(bank.warnings, []);
  const plan = deriveImportPlan(bank, 1);
  const byText = new Map(plan.rows.map((r) => [r.text, r]));
  assert.equal(byText.get("Do you work, or are you a student?")?.questionRole, "gate");
  assert.equal(byText.get("Do you work, or are you a student?")?.audience, null);
  assert.equal(byText.get("What subjects are you studying?")?.audience, "student");
  assert.equal(byText.get("What work do you do?")?.audience, "work");
  assert.equal(byText.get("What are the benefits of being your age?")?.questionRole, null);
  assert.equal(byText.get("What are the benefits of being your age?")?.audience, null);
  // Part 2/3 rows never carry the tags.
  assert.equal(byText.get("Describe a job you would like to have in the future.")?.questionRole ?? null, null);
  assert.equal(byText.get("Describe a job you would like to have in the future.")?.audience ?? null, null);
  assert.equal(byText.get("Why do you think people choose their careers?")?.audience ?? null, null);
});

test("bank import: unknown audience values are dropped, not fatal", () => {
  const bank = parseBank({
    season: "2026-09-12",
    topics: [
      { key: "t", name: "T", type: "evergreen", category: "part1", part1: [{ text: "Is this phrased as a question, then?", audience: "retired", gate: "yes" }] },
    ],
  });
  const plan = deriveImportPlan(bank, 1);
  assert.equal(plan.rows[0].audience, null);
  // gate: "yes" is not `true` → not a gate.
  assert.equal(plan.rows[0].questionRole, null);
});
