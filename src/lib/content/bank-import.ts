/**
 * Pure bank-import logic — validation, normalisation and the question-row plan.
 *
 * Deliberately free of database / HTTP imports so the import contract can be
 * tested without a server, and so a validation bug cannot be masked by a
 * transaction rollback. `bank-service.ts` adds the database write and maps
 * `BankImportError` onto an HTTP response.
 */
import type { questions } from "@/db/schema";
import type { QuestionLearningContent } from "./types";
import { hasLearning } from "./types";
import { canonicalVoiceId, checkAudioUrl, sanitizeLearning } from "./validate";

export type BankQuestionType = "evergreen" | "new" | "retained";
export type BankCategory = "part1" | "part23" | "part3";

export interface BankEntry {
  text: string;
  textZh?: string;
  cuePoints?: string[];
  /** Pre-recorded audio for this prompt, and the profile that recorded it. */
  questionAudioUrl?: string;
  questionVoiceProfile?: string;
  /** Study material: model answer, idea notes, key phrases, shadowing audio. */
  learning?: QuestionLearningContent;
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

export interface ParsedBank extends BankJson {
  /** Non-fatal issues: dropped study content, ignored fields. Surfaced in /admin. */
  warnings: string[];
}

/** Validation failure that the HTTP layer turns into a 400 with a stable code. */
export class BankImportError extends Error {
  constructor(public message: string, public code: string, public status = 400) {
    super(message);
    this.name = "BankImportError";
  }
}

export interface ImportPlan {
  rows: (typeof questions.$inferInsert)[];
  /** Study content keyed to the question it belongs to (sidecar payload). */
  learning: Array<{ topicKey: string; part: number; text: string; learning: QuestionLearningContent }>;
  counts: { part1: number; part2: number; part3: number };
}

const TYPES = new Set(["evergreen", "new", "retained"]);

/**
 * Exam audio is stricter than study audio: a bank that points at an insecure
 * URL, or at a clip whose voice cannot be named, is rejected outright. Guessing
 * would put a stranger's voice into a paid mock exam.
 */
function readExaminerAudio(
  x: Record<string, unknown>,
  where: string,
): Pick<BankEntry, "questionAudioUrl" | "questionVoiceProfile"> {
  const rawUrl = typeof x.questionAudioUrl === "string" ? x.questionAudioUrl.trim() : "";
  const rawVoice = typeof x.questionVoiceProfile === "string" ? x.questionVoiceProfile.trim() : "";
  if (!rawUrl && !rawVoice) return {};
  if (!rawUrl) throw new BankImportError(`${where}: questionVoiceProfile without questionAudioUrl`, "invalid_audio");
  const url = checkAudioUrl(rawUrl);
  if (!url.ok) throw new BankImportError(`${where}: questionAudioUrl ${url.reason}`, "invalid_audio_url");
  if (!rawVoice) throw new BankImportError(`${where}: questionAudioUrl requires questionVoiceProfile`, "unlabelled_audio");
  if (!canonicalVoiceId(rawVoice)) throw new BankImportError(`${where}: unknown voice profile "${rawVoice}"`, "invalid_voice_profile");
  return { questionAudioUrl: url.url, questionVoiceProfile: rawVoice };
}

/** Study content: never fatal. Malformed pieces are dropped with a warning. */
function readLearning(x: Record<string, unknown>, where: string, warnings: string[]): QuestionLearningContent | undefined {
  const raw = x.learning ?? (x.followAudio ? { followAudio: x.followAudio } : undefined);
  if (raw === undefined) return undefined;
  const { learning, warnings: w } = sanitizeLearning(raw, where);
  warnings.push(...w);
  return hasLearning(learning) ? learning : undefined;
}

function parseEntry(e: unknown, where: string, warnings: string[]): BankEntry | null {
  if (!e || typeof e !== "object") return null;
  const x = e as Record<string, unknown>;
  const text = typeof x.text === "string" ? x.text.trim() : "";
  if (!text) return null;
  const learning = readLearning(x, where, warnings);
  return {
    text,
    textZh: typeof x.textZh === "string" ? x.textZh.trim() : undefined,
    cuePoints: Array.isArray(x.cuePoints) ? x.cuePoints.filter((c): c is string => typeof c === "string") : undefined,
    ...readExaminerAudio(x, where),
    ...(learning ? { learning } : {}),
  };
}

/** Validate an uploaded bank without trusting any client-supplied shape. */
export function parseBank(raw: unknown): ParsedBank {
  if (!raw || typeof raw !== "object") throw new BankImportError("Bank must be a JSON object", "invalid_bank");
  const b = raw as Record<string, unknown>;
  if (typeof b.season !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}[\w-]*$/.test(b.season)) {
    throw new BankImportError("season must look like 2026-09-12", "invalid_bank");
  }
  if (!Array.isArray(b.topics) || !b.topics.length) throw new BankImportError("topics must be a non-empty array", "invalid_bank");
  const warnings: string[] = [];
  const topics: BankTopic[] = [];
  for (const t of b.topics) {
    if (!t || typeof t !== "object") continue;
    const x = t as Record<string, unknown>;
    if (typeof x.key !== "string" || !x.key || typeof x.name !== "string" || !x.name) continue;
    const topicKey = x.key.slice(0, 80);
    const entries = (part: string, v: unknown): BankEntry[] =>
      Array.isArray(v)
        ? v
            .map((e, i) => parseEntry(e, `${topicKey}/${part}[${i}]`, warnings))
            .filter((e): e is BankEntry => !!e)
            .slice(0, 40)
        : [];
    topics.push({
      key: topicKey, name: x.name.slice(0, 120), nameZh: typeof x.nameZh === "string" ? x.nameZh.slice(0, 120) : undefined,
      type: typeof x.type === "string" && TYPES.has(x.type) ? x.type : "retained",
      category: typeof x.category === "string" ? x.category.slice(0, 20) : "part1",
      examinees: typeof x.examinees === "number" ? Math.max(0, Math.round(x.examinees)) : null,
      part1: entries("part1", x.part1), part2: entries("part2", x.part2), part3: entries("part3", x.part3),
    });
  }
  if (!topics.length) throw new BankImportError("No usable topics found", "invalid_bank");
  return {
    season: b.season,
    region: typeof b.region === "string" ? b.region.slice(0, 40) : "Mainland China",
    label: typeof b.label === "string" ? b.label.slice(0, 160) : undefined,
    source: typeof b.source === "string" ? b.source.slice(0, 300) : undefined,
    topics,
    warnings,
  };
}

/**
 * Pure transformation bank → database rows + content entries.
 * The question text is copied verbatim: study material never edits an exam prompt.
 */
export function deriveImportPlan(bank: BankJson, setId: number): ImportPlan {
  const rows: (typeof questions.$inferInsert)[] = [];
  const learning: ImportPlan["learning"] = [];
  const push = (t: BankTopic, part: 1 | 2 | 3, list: BankEntry[] | undefined) => {
    const base = {
      setId, module: "speaking", topic: t.name, topicKey: t.key, topicZh: t.nameZh ?? null,
      questionType: String(t.type), category: String(t.category ?? "part1"), examinees: t.examinees ?? null,
    };
    (list ?? []).forEach((q, i) => {
      rows.push({
        ...base, part, text: q.text.trim(), textZh: q.textZh?.trim() || null, orderIndex: i,
        ...(part === 2 ? { cuePoints: q.cuePoints ?? [] } : {}),
        questionAudioUrl: q.questionAudioUrl ?? null,
        questionVoiceProfile: q.questionVoiceProfile ?? null,
      });
      if (q.learning && hasLearning(q.learning)) {
        learning.push({ topicKey: t.key, part, text: q.text.trim(), learning: q.learning });
      }
    });
  };
  for (const t of bank.topics) {
    push(t, 1, t.part1);
    push(t, 2, t.part2);
    push(t, 3, t.part3);
  }
  return {
    rows,
    learning,
    counts: {
      part1: rows.filter((r) => r.part === 1).length,
      part2: rows.filter((r) => r.part === 2).length,
      part3: rows.filter((r) => r.part === 3).length,
    },
  };
}
