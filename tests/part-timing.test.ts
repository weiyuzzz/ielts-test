import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig } from "../src/lib/speaking/config";
import { budgetForPart, formatClock, OFFICIAL_RANGE, partProgress, partRemaining } from "../src/lib/speaking/part-timing";

test("Part 1 answers are capped at 30s and may end after 5s", () => {
  const cfg = resolveConfig("full");
  assert.equal(cfg.part1.answerSeconds, 30);
  assert.equal(cfg.minFinishSeconds, 5);
});

test("part budgets use the upper bound of the official ranges", () => {
  const cfg = resolveConfig("full");
  assert.equal(budgetForPart(cfg, 1), 300); // 4–5 min
  assert.equal(budgetForPart(cfg, 2), 240); // 3–4 min
  assert.equal(budgetForPart(cfg, 3), 300); // 4–5 min
  assert.deepEqual([OFFICIAL_RANGE[1], OFFICIAL_RANGE[2], OFFICIAL_RANGE[3]], ["4–5 min", "3–4 min", "4–5 min"]);
});

test("a session created before part2.budgetSeconds existed still resolves a budget", () => {
  const cfg = resolveConfig("full");
  // Shape of an old snapshot: no budgetSeconds on part 2.
  const legacy = { ...cfg, part2: { enabled: true, prepSeconds: 60, answerSeconds: 120 } } as unknown as typeof cfg;
  assert.equal(budgetForPart(legacy, 2), 240); // 60 + 120 + 60 transition
  assert.equal(budgetForPart({ ...legacy, part2: { ...legacy.part2, prepSeconds: 30, answerSeconds: 90 } } as unknown as typeof cfg, 2), 180);
});

test("partRemaining never goes negative and partProgress saturates", () => {
  assert.equal(partRemaining(300, 0), 300);
  assert.equal(partRemaining(300, 120_000), 180);
  assert.equal(partRemaining(300, 400_000), 0);
  assert.equal(partProgress(300, 300), 0);
  assert.equal(partProgress(300, 150), 0.5);
  assert.equal(partProgress(300, 0), 1);
  assert.equal(partProgress(0, 0), 0);
});

test("formatClock prints m:ss and clamps negatives", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(9), "0:09");
  assert.equal(formatClock(65), "1:05");
  assert.equal(formatClock(300), "5:00");
  assert.equal(formatClock(-4), "0:00");
  assert.equal(formatClock(59.6), "1:00"); // rounds, never shows 0:60
});
