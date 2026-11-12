import { db } from "@/db";
import { examSessions, assessments, assessmentDimensions, questions, users } from "@/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";

type User = typeof users.$inferSelect;

export async function listSessions(user: User, limit = 50) {
  const rows = await db.select().from(examSessions).where(and(eq(examSessions.userId, user.id), eq(examSessions.module, "speaking"))).orderBy(desc(examSessions.startedAt)).limit(limit);
  if (!rows.length) return [];
  const as = await db.select().from(assessments).where(inArray(assessments.sessionId, rows.map((r) => r.id))).orderBy(desc(assessments.startedAt));
  const latest = new Map<string, (typeof as)[number]>();
  for (const a of as) if (!latest.has(a.sessionId)) latest.set(a.sessionId, a);
  const dims = latest.size ? await db.select().from(assessmentDimensions).where(inArray(assessmentDimensions.assessmentId, [...latest.values()].map((a) => a.id))) : [];
  return rows.map((r) => {
    const a = latest.get(r.id);
    const d = a ? dims.filter((x) => x.assessmentId === a.id) : [];
    return {
      ...r,
      assessment: a ? { id: a.id, status: a.status, overallBand: a.overallBand, isComplete: a.isComplete, scorer: a.scorer } : null,
      dims: Object.fromEntries(d.map((x) => [x.dimension, x.band])) as Record<string, number | null>,
    };
  });
}

export async function speakingProgress(user: User) {
  const sessions = await listSessions(user, 100);
  const scored = sessions.filter((s) => s.assessment?.overallBand != null);
  const recent = scored.slice(0, 5);
  const avg = (k: string) => {
    const v = recent.map((s) => s.dims[k]).filter((x): x is number => typeof x === "number");
    return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 2) / 2 : null;
  };
  return {
    sessions,
    completed: sessions.filter((s) => s.status === "completed").length,
    fullMocks: sessions.filter((s) => s.mode === "full" && s.status === "completed").length,
    latest: scored[0] ?? null,
    best: scored.reduce<number | null>((m, s) => (m === null || (s.assessment!.overallBand as number) > m ? (s.assessment!.overallBand as number) : m), null),
    averages: { FC: avg("FC"), LR: avg("LR"), GRA: avg("GRA"), P: avg("P") },
    trend: scored.slice(0, 10).reverse().map((s) => ({ id: s.id, band: s.assessment!.overallBand as number, mode: s.mode })),
  };
}

export async function questionBank() {
  return db.select().from(questions).where(eq(questions.module, "speaking")).orderBy(questions.part, questions.topicKey, questions.orderIndex);
}
