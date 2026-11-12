import { db } from "@/db";
import { questionSets, questions } from "@/db/schema";
import { SEED_SET, SEED_TOPICS } from "@/lib/speaking/question-bank";
import { sql } from "drizzle-orm";

let seeded: Promise<void> | null = null;

/** Idempotently seed the question bank (safe across concurrent requests via advisory lock). */
export function ensureSeed(): Promise<void> {
  if (!seeded) {
    seeded = (async () => {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(424242)`);
        const existing = await tx.select({ id: questionSets.id }).from(questionSets).limit(1);
        if (existing.length) return;
        const [set] = await tx.insert(questionSets).values({ ...SEED_SET, module: "speaking" }).returning();
        const rows: (typeof questions.$inferInsert)[] = [];
        for (const t of SEED_TOPICS) {
          t.part1?.forEach((q, i) => rows.push({ setId: set.id, part: 1, topic: t.topic, topicKey: t.key, text: q, orderIndex: i }));
          if (t.part2) rows.push({ setId: set.id, part: 2, topic: t.topic, topicKey: t.key, text: t.part2.text, cuePoints: t.part2.cues, orderIndex: 0 });
          t.part3?.forEach((q, i) => rows.push({ setId: set.id, part: 3, topic: t.topic, topicKey: t.key, text: q, orderIndex: i }));
        }
        await tx.insert(questions).values(rows);
      });
    })().catch((e) => {
      seeded = null;
      throw e;
    });
  }
  return seeded;
}
