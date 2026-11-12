import { db } from "@/db";
import { examSessions, assessments, assessmentDimensions, questions, users } from "@/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { activeBank } from "./bank-service";
import { attachLearning, computeCoverage, loadSeasonIndex } from "@/lib/content/store";

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

/**
 * Study library for the active bank: every question plus its (possibly empty)
 * learning content.
 *
 * This is the ONLY place that joins questions to study material, and it is only
 * ever called by study pages. The exam path (`exam-service`) does not import it,
 * which is what keeps a mock test free of sample answers by construction.
 */
export async function activeLearningLibrary() {
  const bank = await activeBank();
  if (!bank) {
    return { season: null as string | null, region: null as string | null, questions: [], coverage: computeCoverage([], new Map()), warnings: [] as string[] };
  }
  const rows = await db
    .select({
      id: questions.id, part: questions.part, topic: questions.topic, topicKey: questions.topicKey,
      topicZh: questions.topicZh, text: questions.text, textZh: questions.textZh, cuePoints: questions.cuePoints,
      examinees: questions.examinees,
    })
    .from(questions)
    .where(and(eq(questions.module, "speaking"), eq(questions.setId, bank.id)))
    .orderBy(questions.part, questions.topicKey, questions.orderIndex);
  const { index, examinees, warnings } = await loadSeasonIndex(bank.season);
  return {
    season: bank.season as string | null,
    region: bank.region as string | null,
    questions: attachLearning(rows, index, examinees),
    coverage: computeCoverage(rows, index),
    warnings,
  };
}

export interface TopicOption {
  topicKey: string;
  topic: string;
  topicZh: string | null;
  parts: number[];
  counts: { part1: number; part2: number; part3: number };
  withSampleAnswer: number;
}

/** Compact selector data for /speaking/practice — no question text, no content. */
export async function practiceTopics(): Promise<{ season: string | null; topics: TopicOption[] }> {
  const library = await activeLearningLibrary();
  const byKey = new Map<string, TopicOption>();
  for (const q of library.questions) {
    let t = byKey.get(q.topicKey);
    if (!t) {
      t = { topicKey: q.topicKey, topic: q.topic, topicZh: q.topicZh, parts: [], counts: { part1: 0, part2: 0, part3: 0 }, withSampleAnswer: 0 };
      byKey.set(q.topicKey, t);
    }
    const bucket = (`part${q.part}`) as "part1" | "part2" | "part3";
    t.counts[bucket] += 1;
    if (!t.parts.includes(q.part)) t.parts.push(q.part);
    if (q.learning.sampleAnswer?.paragraphs.length) t.withSampleAnswer += 1;
  }
  return {
    season: library.season,
    topics: [...byKey.values()].sort((a, b) => a.topic.localeCompare(b.topic)),
  };
}
