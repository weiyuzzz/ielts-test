/**
 * Seasonal question-bank service: import, browse and activate a bank.
 *
 * An exam never mixes banks. `activeBank()` is the single source of truth for
 * `createSession()`, and only one bank per module may be active at a time.
 */
import { db } from "@/db";
import { questionSets, questions } from "@/db/schema";
import { and, asc, count, desc, eq, ne } from "drizzle-orm";
import { HttpError } from "./user";

export type BankQuestionType = "evergreen" | "new" | "retained";
export type BankCategory = "part1" | "part23" | "part3";

export interface BankEntry {
  text: string;
  textZh?: string;
  cuePoints?: string[];
  /** Pre-recorded audio for this prompt, and the profile that recorded it. */
  questionAudioUrl?: string;
  questionVoiceProfile?: string;
}
export interface BankTopic {
  key: string;
  name: string;
  nameZh?: string;
  type: BankQuestionType | string;
  category?: BankCategory | string;
  examinees?: number | null;
  part1?: BankEntry[];
  part2?: BankEntry[];
  part3?: BankEntry[];
}
export interface BankJson {
  season: string;
  region?: string;
  label?: string;
  source?: string;
  topics: BankTopic[];
}

const TYPES = new Set(["evergreen", "new", "retained"]);

/** Validate an uploaded bank without trusting any client-supplied shape. */
export function parseBank(raw: unknown): BankJson {
  if (!raw || typeof raw !== "object") throw new HttpError(400, "Bank must be a JSON object", "invalid_bank");
  const b = raw as Record<string, unknown>;
  if (typeof b.season !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}[\w-]*$/.test(b.season)) {
    throw new HttpError(400, "season must look like 2026-09-12", "invalid_bank");
  }
  if (!Array.isArray(b.topics) || !b.topics.length) throw new HttpError(400, "topics must be a non-empty array", "invalid_bank");
  const topics: BankTopic[] = [];
  for (const t of b.topics) {
    if (!t || typeof t !== "object") continue;
    const x = t as Record<string, unknown>;
    if (typeof x.key !== "string" || !x.key || typeof x.name !== "string" || !x.name) continue;
    const entries = (v: unknown): BankEntry[] =>
      Array.isArray(v) ? v.filter((e): e is BankEntry => !!e && typeof (e as BankEntry).text === "string" && !!(e as BankEntry).text.trim()).slice(0, 40) : [];
    topics.push({
      key: x.key.slice(0, 80), name: x.name.slice(0, 120), nameZh: typeof x.nameZh === "string" ? x.nameZh.slice(0, 120) : undefined,
      type: typeof x.type === "string" && TYPES.has(x.type) ? x.type : "retained",
      category: typeof x.category === "string" ? x.category.slice(0, 20) : "part1",
      examinees: typeof x.examinees === "number" ? Math.max(0, Math.round(x.examinees)) : null,
      part1: entries(x.part1), part2: entries(x.part2), part3: entries(x.part3),
    });
  }
  if (!topics.length) throw new HttpError(400, "No usable topics found", "invalid_bank");
  return {
    season: b.season,
    region: typeof b.region === "string" ? b.region.slice(0, 40) : "大陆地区",
    label: typeof b.label === "string" ? b.label.slice(0, 160) : undefined,
    source: typeof b.source === "string" ? b.source.slice(0, 300) : undefined,
    topics,
  };
}

/** Replace the bank for a season (idempotent) and optionally make it active. */
export async function importBank(raw: unknown, activate = false) {
  const bank = parseBank(raw);
  return db.transaction(async (tx) => {
    const old = await tx.select({ id: questionSets.id }).from(questionSets).where(eq(questionSets.season, bank.season));
    for (const o of old) await tx.delete(questionSets).where(eq(questionSets.id, o.id));
    const [set] = await tx.insert(questionSets).values({
      module: "speaking", name: bank.label || bank.season, season: bank.season, region: bank.region || "大陆地区",
      label: bank.label ?? null, source: bank.source ?? null,
      description: `${bank.topics.length} topics · ${bank.region || "大陆地区"}`,
      isActive: false,
    }).returning();

    const rows: (typeof questions.$inferInsert)[] = [];
    for (const t of bank.topics) {
      const base = {
        setId: set.id, module: "speaking", topic: t.name, topicKey: t.key, topicZh: t.nameZh ?? null,
        questionType: String(t.type), category: String(t.category ?? "part1"), examinees: t.examinees ?? null,
      };
      t.part1?.forEach((q, i) => rows.push({ ...base, part: 1, text: q.text.trim(), textZh: q.textZh?.trim() || null, orderIndex: i, questionAudioUrl: q.questionAudioUrl ?? null, questionVoiceProfile: q.questionVoiceProfile ?? null }));
      t.part2?.forEach((q, i) => rows.push({ ...base, part: 2, text: q.text.trim(), cuePoints: q.cuePoints ?? [], orderIndex: i, questionAudioUrl: q.questionAudioUrl ?? null, questionVoiceProfile: q.questionVoiceProfile ?? null }));
      t.part3?.forEach((q, i) => rows.push({ ...base, part: 3, text: q.text.trim(), textZh: q.textZh?.trim() || null, orderIndex: i, questionAudioUrl: q.questionAudioUrl ?? null, questionVoiceProfile: q.questionVoiceProfile ?? null }));
    }
    for (let i = 0; i < rows.length; i += 100) await tx.insert(questions).values(rows.slice(i, i + 100));

    if (activate) {
      await tx.update(questionSets).set({ isActive: false }).where(ne(questionSets.id, set.id));
      await tx.update(questionSets).set({ isActive: true }).where(eq(questionSets.id, set.id));
    }
    return {
      id: set.id, season: bank.season, activated: activate,
      topics: bank.topics.length,
      counts: { part1: rows.filter((r) => r.part === 1).length, part2: rows.filter((r) => r.part === 2).length, part3: rows.filter((r) => r.part === 3).length },
    };
  });
}

export async function listBanks() {
  const sets = await db.select().from(questionSets).orderBy(desc(questionSets.importedAt));
  const grouped = await db.select({ setId: questions.setId, part: questions.part, n: count() }).from(questions).groupBy(questions.setId, questions.part);
  return sets.map((s) => ({
    id: s.id, season: s.season, name: s.name, label: s.label, region: s.region, source: s.source,
    isActive: s.isActive, importedAt: s.importedAt,
    counts: { part1: grouped.find((g) => g.setId === s.id && g.part === 1)?.n ?? 0, part2: grouped.find((g) => g.setId === s.id && g.part === 2)?.n ?? 0, part3: grouped.find((g) => g.setId === s.id && g.part === 3)?.n ?? 0 },
  }));
}

export async function getBankDetail(id: number) {
  const [set] = await db.select().from(questionSets).where(eq(questionSets.id, id)).limit(1);
  if (!set) throw new HttpError(404, "Question bank not found", "bank_not_found");
  const rows = await db.select().from(questions).where(eq(questions.setId, id)).orderBy(asc(questions.part), asc(questions.topicKey), asc(questions.orderIndex));
  const topics = new Map<string, { key: string; name: string; nameZh: string | null; type: string; part1: string[]; part2: { text: string; cues: string[] }[]; part3: string[] }>();
  for (const q of rows) {
    let t = topics.get(q.topicKey);
    if (!t) {
      t = { key: q.topicKey, name: q.topic, nameZh: q.topicZh, type: q.questionType, part1: [], part2: [], part3: [] };
      topics.set(q.topicKey, t);
    }
    if (q.part === 1) t.part1.push(q.text);
    else if (q.part === 2) t.part2.push({ text: q.text, cues: q.cuePoints ?? [] });
    else t.part3.push(q.text);
  }
  return { set, topics: [...topics.values()] };
}

export async function activateBank(id: number) {
  const [target] = await db.select({ id: questionSets.id }).from(questionSets).where(eq(questionSets.id, id)).limit(1);
  if (!target) throw new HttpError(404, "Question bank not found", "bank_not_found");
  await db.transaction(async (tx) => {
    await tx.update(questionSets).set({ isActive: false }).where(eq(questionSets.module, "speaking"));
    await tx.update(questionSets).set({ isActive: true }).where(eq(questionSets.id, id));
  });
  return { id, active: true };
}

export async function activeBank() {
  const [active] = await db.select().from(questionSets).where(and(eq(questionSets.module, "speaking"), eq(questionSets.isActive, true))).limit(1);
  if (active) return active;
  const [latest] = await db.select().from(questionSets).where(eq(questionSets.module, "speaking")).orderBy(desc(questionSets.importedAt)).limit(1);
  return latest ?? null;
}
