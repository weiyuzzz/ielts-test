/**
 * Seasonal question-bank service: import, browse and activate a bank.
 *
 * An exam never mixes banks. `activeBank()` is the single source of truth for
 * `createSession()`, and only one bank per module may be active at a time.
 *
 * Phase 3 adds two optional things per question:
 *   - a pre-recorded examiner clip, which must declare the voice that taped it
 *     (an unlabelled clip could be a different person, so it is refused rather
 *     than guessed);
 *   - study material (`learning`), validated here but stored in the sidecar
 *     content store — never in the exam tables.
 *
 * Both are optional: a bank JSON written before Phase 3 imports unchanged.
 * Validation itself lives in `lib/content/bank-import.ts` (pure, DB-free); this
 * module owns the transaction and the HTTP mapping.
 */
import { db } from "@/db";
import { questionSets, questions } from "@/db/schema";
import { and, asc, count, desc, eq, ne } from "drizzle-orm";
import { HttpError } from "./user";
import { contentKey, summarizeLearning } from "@/lib/content/validate";
import { hasLearning } from "@/lib/content/types";
import { audioCoverage, decideExaminerAudio, decideFollowAudio, type AudioCoverage } from "@/lib/content/audio-policy";
import { computeCoverage, loadSeasonIndex, upsertSeasonEntries } from "@/lib/content/store";
import {
  BankImportError,
  deriveImportPlan,
  parseBank as parseBankCore,
  type BankJson,
  type ImportPlan,
  type ParsedBank,
} from "@/lib/content/bank-import";
import { envDefaultProfile } from "@/lib/speaking/voice-profile";

export type { BankEntry, BankTopic, BankJson, ImportPlan, ParsedBank } from "@/lib/content/bank-import";
export { deriveImportPlan };

/** Same validation, with the HTTP status/code the API returns. */
export function parseBank(raw: unknown): ParsedBank {
  try {
    return parseBankCore(raw);
  } catch (e) {
    if (e instanceof BankImportError) throw new HttpError(e.status, e.message, e.code);
    throw e;
  }
}

/** Replace the bank for a season (idempotent) and optionally make it active. */
export async function importBank(raw: unknown, activate = false) {
  const bank = parseBank(raw);
  const warnings = [...bank.warnings];
  const result = await db.transaction(async (tx) => {
    const old = await tx.select({ id: questionSets.id }).from(questionSets).where(eq(questionSets.season, bank.season));
    for (const o of old) await tx.delete(questionSets).where(eq(questionSets.id, o.id));
    const [set] = await tx.insert(questionSets).values({
      module: "speaking", name: bank.label || bank.season, season: bank.season, region: bank.region || "大陆地区",
      label: bank.label ?? null, source: bank.source ?? null,
      description: `${bank.topics.length} topics · ${bank.region || "大陆地区"}`,
      isActive: false,
    }).returning();

    const plan: ImportPlan = deriveImportPlan(bank as BankJson, set.id);
    for (let i = 0; i < plan.rows.length; i += 100) await tx.insert(questions).values(plan.rows.slice(i, i + 100));

    if (activate) {
      await tx.update(questionSets).set({ isActive: false }).where(ne(questionSets.id, set.id));
      await tx.update(questionSets).set({ isActive: true }).where(eq(questionSets.id, set.id));
    }
    return { set, plan };
  });

  // Study content lives outside the transaction (file store). A failure here
  // must not undo a successful exam-bank import.
  let contentEntries = 0;
  if (result.plan.learning.length) {
    try {
      contentEntries = await upsertSeasonEntries(bank.season, bank.region, result.plan.learning);
    } catch (e) {
      warnings.push(`learning content not saved: ${(e as Error).message}`);
    }
  }

  return {
    id: result.set.id, season: bank.season, activated: activate,
    topics: bank.topics.length,
    counts: result.plan.counts,
    learning: { entries: contentEntries, withSampleAnswer: result.plan.learning.filter((e) => e.learning.sampleAnswer).length },
    warnings,
  };
}

export async function listBanks() {
  const sets = await db.select().from(questionSets).orderBy(desc(questionSets.importedAt));
  const grouped = await db.select({ setId: questions.setId, part: questions.part, n: count() }).from(questions).groupBy(questions.setId, questions.part);
  const audio = await db
    .select({ setId: questions.setId, total: count(), withAudio: count(questions.questionAudioUrl) })
    .from(questions)
    .groupBy(questions.setId);
  return sets.map((s) => ({
    id: s.id, season: s.season, name: s.name, label: s.label, region: s.region, source: s.source,
    isActive: s.isActive, importedAt: s.importedAt,
    counts: { part1: grouped.find((g) => g.setId === s.id && g.part === 1)?.n ?? 0, part2: grouped.find((g) => g.setId === s.id && g.part === 2)?.n ?? 0, part3: grouped.find((g) => g.setId === s.id && g.part === 3)?.n ?? 0 },
    audio: {
      withAudio: Number(audio.find((a) => a.setId === s.id)?.withAudio ?? 0),
      total: Number(audio.find((a) => a.setId === s.id)?.total ?? 0),
    },
  }));
}

export interface DetailQuestion {
  id: number;
  text: string;
  cues: string[];
  audioUrl: string | null;
  voiceProfile: string | null;
  audio: ReturnType<typeof decideExaminerAudio>;
  followAudio: ReturnType<typeof decideFollowAudio>;
  learning: ReturnType<typeof summarizeLearning>;
}

export interface BankDetail {
  set: typeof questionSets.$inferSelect;
  topics: Array<{
    key: string; name: string; nameZh: string | null; type: string;
    part1: DetailQuestion[]; part2: DetailQuestion[]; part3: DetailQuestion[];
  }>;
  audio: AudioCoverage;
  examinerProfile: { id: string; name: string };
  learning: {
    entries: number;
    sampleAnswerCoverage: ReturnType<typeof computeCoverage>;
    warnings: string[];
  };
}

export async function getBankDetail(id: number): Promise<BankDetail> {
  const [set] = await db.select().from(questionSets).where(eq(questionSets.id, id)).limit(1);
  if (!set) throw new HttpError(404, "Question bank not found", "bank_not_found");
  const rows = await db.select().from(questions).where(eq(questions.setId, id)).orderBy(asc(questions.part), asc(questions.topicKey), asc(questions.orderIndex));
  const examiner = envDefaultProfile();
  const { index, warnings } = await loadSeasonIndex(set.season);

  const topics = new Map<string, BankDetail["topics"][number]>();
  const assets: Array<{ url: string | null; voiceProfile: string | null }> = [];
  for (const q of rows) {
    let t = topics.get(q.topicKey);
    if (!t) {
      t = { key: q.topicKey, name: q.topic, nameZh: q.topicZh, type: q.questionType, part1: [], part2: [], part3: [] };
      topics.set(q.topicKey, t);
    }
    const learning = index.get(contentKey(q.part, q.topicKey, q.text)) ?? null;
    const item: DetailQuestion = {
      id: q.id, text: q.text, cues: q.cuePoints ?? [],
      audioUrl: q.questionAudioUrl, voiceProfile: q.questionVoiceProfile,
      audio: decideExaminerAudio({ url: q.questionAudioUrl, voiceProfile: q.questionVoiceProfile }, examiner.id),
      followAudio: decideFollowAudio(learning?.followAudio),
      learning: summarizeLearning(learning),
    };
    assets.push({ url: q.questionAudioUrl, voiceProfile: q.questionVoiceProfile });
    if (q.part === 1) t.part1.push(item);
    else if (q.part === 2) t.part2.push(item);
    else t.part3.push(item);
  }

  return {
    set,
    topics: [...topics.values()],
    audio: audioCoverage(assets, examiner.id),
    examinerProfile: { id: examiner.id, name: examiner.name },
    learning: {
      entries: [...index.values()].filter((c) => hasLearning(c)).length,
      sampleAnswerCoverage: computeCoverage(rows, index),
      warnings,
    },
  };
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
