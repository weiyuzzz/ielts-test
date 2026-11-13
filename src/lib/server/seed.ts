/**
 * Bootstrap the built-in seasonal question bank (mainland China only).
 * The bank is stored in the database so the admin UI can switch seasons and
 * browse its contents; exams always draw from the active bank.
 *
 * The bundled JSON is the source of truth: if it grows OR is corrected (for
 * example when a card gains its Part 3 discussion set, or its cue points are
 * repaired), the stored copy is re-imported on the next boot instead of
 * silently staying stale. Comparing only the row count was not enough — a
 * content-only edit left the database serving the old cues forever.
 */
import { createHash } from "node:crypto";
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

/** Short content hash of the bundled bank — changes with ANY text/cue edit. */
function bundledFingerprint(): string {
  return createHash("sha256").update(JSON.stringify(BANK)).digest("hex").slice(0, 16);
}

function seededDescription(fingerprint: string): string {
  return `${BANK.topics.length} topics · ${BANK.region ?? "Mainland China"} · content:${fingerprint}`;
}

export function ensureSeed(): Promise<void> {
  if (!seeded) {
    seeded = (async () => {
      const fingerprint = bundledFingerprint();
      const [existing] = await db
        .select({ id: questionSets.id, isActive: questionSets.isActive, description: questionSets.description })
        .from(questionSets)
        .where(eq(questionSets.season, BANK.season))
        .limit(1);
      // First run: import the mainland seasonal bank and make it the active one.
      if (!existing) {
        const result = await importBank(BANK, true);
        await db.update(questionSets)
          .set({ description: seededDescription(fingerprint) })
          .where(eq(questionSets.id, result.id));
        return;
      }
      const [{ n }] = await db.select({ n: count() }).from(questions).where(eq(questions.setId, existing.id));
      // Row count alone misses content-only corrections, so also compare the
      // fingerprint stamped on the set when it was last imported.
      const staleContent = !existing.description?.includes(`content:${fingerprint}`);
      if (Number(n) !== bundledCount() || staleContent) {
        const result = await importBank(BANK, existing.isActive);
        await db.update(questionSets)
          .set({ description: seededDescription(fingerprint) })
          .where(eq(questionSets.id, result.id));
      }
    })().catch((e) => {
      seeded = null;
      throw e;
    });
  }
  return seeded;
}
