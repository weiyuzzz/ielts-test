/**
 * Bootstrap the built-in seasonal question bank (mainland China only).
 * The bank is stored in the database so the admin UI can switch seasons and
 * browse its contents; exams always draw from the active bank.
 *
 * The bundled JSON is the source of truth: if it grows or is corrected (for
 * example when a card gains its Part 3 discussion set), the stored copy is
 * re-imported on the next boot instead of silently staying stale.
 */
import { db } from "@/db";
import { questionSets, questions } from "@/db/schema";
import { count, eq } from "drizzle-orm";
import BANK from "@/data/question-banks/2026-09-12-mainland.json";
import { importBank } from "./bank-service";

let seeded: Promise<void> | null = null;

function bundledCount(): number {
  return BANK.topics.reduce(
    (n, t) => n + (t.part1?.length ?? 0) + (t.part2?.length ?? 0) + (t.part3?.length ?? 0),
    0,
  );
}

export function ensureSeed(): Promise<void> {
  if (!seeded) {
    seeded = (async () => {
      const [existing] = await db
        .select({ id: questionSets.id, isActive: questionSets.isActive })
        .from(questionSets)
        .where(eq(questionSets.season, BANK.season))
        .limit(1);
      // First run: import the mainland seasonal bank and make it the active one.
      if (!existing) {
        await importBank(BANK, true);
        return;
      }
      const [{ n }] = await db.select({ n: count() }).from(questions).where(eq(questions.setId, existing.id));
      // The stored copy drifted from the bundled file — rebuild it, keeping
      // whichever bank the operator had activated.
      if (Number(n) !== bundledCount()) await importBank(BANK, existing.isActive);
    })().catch((e) => {
      seeded = null;
      throw e;
    });
  }
  return seeded;
}
