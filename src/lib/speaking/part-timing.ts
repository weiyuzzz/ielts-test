/**
 * Per-part time budget for the Speaking test.
 *
 * The real test is strictly timed: Part 1 = 4–5 min, Part 2 = 3–4 min
 * (1 min preparation + 2 min speaking), Part 3 = 4–5 min. We use the UPPER bound
 * of each range as a hard cap: when a part runs out of time the examiner closes
 * it and moves on, exactly like the real examiner does.
 *
 * `budgetSeconds` is stored on the config snapshot, so a session that started
 * before this field existed still resolves a sensible value here.
 */
import type { SpeakingExamConfig } from "./config";

/** Official range as printed in the exam requirements. */
export const OFFICIAL_RANGE: Record<number, string> = {
  // Part 1 shows the extended practice budget (official upper bound +1 min).
  1: "5–6 min",
  2: "3–4 min",
  3: "4–5 min",
};

export const PART_TITLE: Record<number, string> = {
  1: "Introduction & interview",
  2: "Long turn",
  3: "Discussion",
};

/** Hard cap for a part, in seconds. Part 1 deliberately extends the official
 *  4–5 min window by one minute (practice comfort; the examiner still closes
 *  the part when the clock runs out). */
export function budgetForPart(cfg: SpeakingExamConfig, part: number): number {
  if (part === 1) return cfg.part1?.budgetSeconds || 360;
  if (part === 2) {
    // Older snapshots have no budget fields; derive it from prep + talk plus a
    // small transition allowance so it never lands below the official 3 min.
    const derived = (cfg.part2?.prepSeconds ?? 60) + (cfg.part2?.answerSeconds ?? 120) + 60;
    return cfg.part2?.budgetSeconds || derived;
  }
  if (part === 3) return cfg.part3?.budgetSeconds || 300;
  return 300;
}

/** `95` → `1:35`. Negative values clamp to `0:00`. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * How much of a part is left. `null` when the part has not started yet.
 * `elapsedMs` is measured on the client; the server has no part clock because a
 * part can be entered twice (follow-up insertion) and a reload must not reset it.
 */
export function partRemaining(budgetSeconds: number, elapsedMs: number): number {
  return Math.max(0, budgetSeconds - elapsedMs / 1000);
}

/** 0..1 — used for the bar under each part row. */
export function partProgress(budgetSeconds: number, remainingSeconds: number): number {
  if (budgetSeconds <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - remainingSeconds / budgetSeconds));
}
