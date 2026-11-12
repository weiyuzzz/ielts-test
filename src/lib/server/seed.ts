/**
 * Bootstrap the built-in seasonal question bank (mainland China only).
 * The bank is stored in the database so the admin UI can switch seasons and
 * browse its contents; exams always draw from the active bank.
 */
import { db } from "@/db";
import { questionSets } from "@/db/schema";
import { eq } from "drizzle-orm";
import BANK from "@/data/question-banks/2026-09-12-mainland.json";
import { importBank } from "./bank-service";

let seeded: Promise<void> | null = null;

export function ensureSeed(): Promise<void> {
  if (!seeded) {
    seeded = (async () => {
      const [existing] = await db.select({ id: questionSets.id }).from(questionSets).where(eq(questionSets.season, BANK.season)).limit(1);
      // First run: import the mainland seasonal bank and make it the active one.
      if (!existing) await importBank(BANK, true);
    })().catch((e) => {
      seeded = null;
      throw e;
    });
  }
  return seeded;
}
