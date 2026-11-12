/**
 * Validation + sanitising for learning content and for audio references.
 *
 * Everything that enters from a bank JSON is untrusted: it may be hand-edited,
 * copied from a third-party source, or malformed. The rules enforced here are
 * the ones the product actually depends on:
 *
 *   1. An audio URL must be HTTPS unless it is loopback (local development).
 *      A `javascript:` / `data:` / `file:` URL must never reach an <audio> tag.
 *   2. An audio clip must declare WHO recorded it. A clip with no identity, or
 *      with an identity we cannot resolve, must not be presented as the
 *      examiner — otherwise the examiner's voice changes mid-test.
 *   3. Examiner audio and follow (shadowing) audio are separate fields with
 *      separate roles; one can never be substituted for the other.
 *   4. Content is optional. A bank without any learning material imports
 *      exactly as before.
 */
import { VOICE_PRESETS } from "@/lib/speaking/voice-profile";
import {
  EMPTY_LEARNING,
  type FollowAudioRef,
  type IdeaNote,
  type IdeaStage,
  type KeyPhrase,
  type LearningSource,
  type LearningSourceKind,
  type QuestionLearningContent,
  type ReviewStatus,
  type SampleAnswer,
  type VocabGroup,
} from "./types";

export const LIMITS = {
  url: 2048,
  paragraph: 1200,
  phrase: 120,
  example: 400,
  usage: 200,
  textZh: 400,
  idea: 400,
  paragraphs: 12,
  ideaNotes: 10,
  keyPhrases: 18,
  label: 40,
  phraseList: 12,
  vocabGroups: 12,
  vocabItems: 60,
} as const;

const SOURCE_KINDS: LearningSourceKind[] = ["team", "ai-draft", "third-party", "imported"];
const REVIEW_STATES: ReviewStatus[] = ["draft", "reviewed", "rejected"];
const STAGES: IdeaStage[] = ["main-idea", "reason", "example", "result", "contrast"];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface UrlCheck {
  ok: boolean;
  url?: string;
  /** Loopback URLs are accepted for local development only. */
  local?: boolean;
  reason?: string;
}

/**
 * Audio URL gate. HTTPS only, except loopback for local development.
 * Rejects credentials, non-http schemes and absurd lengths.
 */
export function checkAudioUrl(raw: unknown): UrlCheck {
  if (typeof raw !== "string") return { ok: false, reason: "url is not a string" };
  const value = raw.trim();
  if (!value) return { ok: false, reason: "url is empty" };
  if (value.length > LIMITS.url) return { ok: false, reason: "url is too long" };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: "url is not absolute" };
  }
  if (parsed.username || parsed.password) return { ok: false, reason: "url must not contain credentials" };
  const host = parsed.hostname.toLowerCase();
  const local = LOOPBACK_HOSTS.has(host);
  if (parsed.protocol === "https:") return { ok: true, url: parsed.toString(), local };
  if (parsed.protocol === "http:" && local) return { ok: true, url: parsed.toString(), local: true };
  return { ok: false, reason: `insecure scheme ${parsed.protocol} (HTTPS required for external audio)` };
}

/**
 * Canonical voice identity: `provider:voice`.
 *
 * The same voice can be written three ways (`azure-sonia`, `azure:en-GB-SoniaNeural`,
 * `en-GB-SoniaNeural`); they must collapse to one identity before anything is
 * compared, otherwise an asset recorded with the right voice would be rejected
 * (or worse, the wrong one accepted) purely because of spelling.
 */
export function canonicalVoiceId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  const preset = VOICE_PRESETS.find((p) => p.id === value);
  if (preset) return `${preset.provider}:${preset.voice}`;
  if (value.includes(":")) {
    const [head, ...rest] = value.split(":");
    const provider = head.trim().toLowerCase();
    const voice = rest.join(":").trim();
    if (!voice) return null;
    if (provider === "azure" || provider === "openai" || provider === "kokoro" || provider === "browser") {
      return `${provider}:${voice}`;
    }
    return null;
  }
  if (/^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/.test(value)) return `azure:${value}`;
  if (/^[a-z]{2}_[a-z]+$/i.test(value)) return `kokoro:${value}`;
  return null;
}

/** A voice we can name exactly. Unknown names are not allowed to impersonate the examiner. */
export function isKnownVoiceId(raw: unknown): boolean {
  return canonicalVoiceId(raw) !== null;
}

/** Normalised question text — the join key between a bank entry and its content. */
export function normalizeQuestionText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[.?!\u2026]+$/g, "");
}

/** Stable content key. Survives re-import (ids do not). */
export function contentKey(part: number, topicKey: string, text: string): string {
  return `${part}|${topicKey.trim().toLowerCase()}|${normalizeQuestionText(text)}`;
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

function source(raw: unknown, fallbackLabel: string): LearningSource {
  const r = (raw ?? {}) as Record<string, unknown>;
  const kind = SOURCE_KINDS.includes(r.kind as LearningSourceKind) ? (r.kind as LearningSourceKind) : "imported";
  const label = str(r.label, 160) || fallbackLabel;
  const urlCheck = typeof r.url === "string" ? checkAudioUrl(r.url) : null;
  return { kind, label, ...(urlCheck?.ok ? { url: urlCheck.url } : {}) };
}

function sampleAnswer(raw: unknown): SampleAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const paragraphs = Array.isArray(r.paragraphs)
    ? r.paragraphs.map((p) => str(p, LIMITS.paragraph)).filter(Boolean).slice(0, LIMITS.paragraphs)
    : typeof r.text === "string" // tolerate a single blob
      ? splitParagraphs(str(r.text, LIMITS.paragraph * LIMITS.paragraphs))
      : [];
  if (!paragraphs.length) return null;
  const review = REVIEW_STATES.includes(r.reviewStatus as ReviewStatus) ? (r.reviewStatus as ReviewStatus) : "draft";
  const hint = typeof r.targetBandHint === "number" && Number.isFinite(r.targetBandHint) ? Math.min(9, Math.max(0, r.targetBandHint)) : null;
  const paragraphsZh = Array.isArray(r.paragraphsZh)
    ? r.paragraphsZh.map((p) => str(p, LIMITS.paragraph)).filter(Boolean).slice(0, LIMITS.paragraphs)
    : [];
  const variantLabel = str(r.variantLabel, LIMITS.label);
  return {
    paragraphs,
    ...(paragraphsZh.length ? { paragraphsZh } : {}),
    ...(variantLabel ? { variantLabel } : {}),
    source: source(r.source, "Unlabelled source"),
    // An AI draft is never auto-promoted, whatever the file claims.
    reviewStatus: (r.source as LearningSource | undefined)?.kind === "ai-draft" ? "draft" : review,
    targetBandHint: hint,
  };
}

/** Split a blob into 1–3 sentence units for sentence-level playback. */
export function splitParagraphs(text: string): string[] {
  const sentences = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.?!])\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < sentences.length; i += 2) {
    out.push(sentences.slice(i, i + 2).join(" "));
  }
  return out;
}

function ideaNotes(raw: unknown): IdeaNote[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((n) => {
      const r = (n ?? {}) as Record<string, unknown>;
      const text = str(r.text, LIMITS.idea);
      if (!text) return null;
      const stage: IdeaStage = STAGES.includes(r.stage as IdeaStage) ? (r.stage as IdeaStage) : "main-idea";
      const zh = str(r.textZh, LIMITS.textZh);
      const label = str(r.label, LIMITS.label);
      const note = str(r.note, LIMITS.idea);
      const phrases = Array.isArray(r.phrases)
        ? r.phrases.map((p) => str(p, LIMITS.phrase)).filter(Boolean).slice(0, LIMITS.phraseList)
        : [];
      return {
        stage,
        text,
        ...(zh ? { textZh: zh } : {}),
        ...(label ? { label } : {}),
        ...(note ? { note } : {}),
        ...(phrases.length ? { phrases } : {}),
      } satisfies IdeaNote;
    })
    .filter((x): x is IdeaNote => !!x)
    .slice(0, LIMITS.ideaNotes);
}

function keyPhrases(raw: unknown): KeyPhrase[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((n) => {
      const r = (n ?? {}) as Record<string, unknown>;
      const phrase = str(r.phrase, LIMITS.phrase);
      if (!phrase) return null;
      const usage = str(r.usage, LIMITS.usage);
      const example = str(r.example, LIMITS.example);
      return {
        phrase,
        zh: str(r.zh, LIMITS.textZh),
        ...(example ? { example } : {}),
        ...(usage ? { usage } : {}),
      } satisfies KeyPhrase;
    })
    .filter((x): x is KeyPhrase => !!x)
    .slice(0, LIMITS.keyPhrases);
}

function vocabGroups(raw: unknown): VocabGroup[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((g) => {
      const r = (g ?? {}) as Record<string, unknown>;
      const title = str(r.title, LIMITS.label) || "Vocabulary expansion";
      const items = Array.isArray(r.items)
        ? r.items
            .map((it) => {
              const x = (it ?? {}) as Record<string, unknown>;
              const en = str(x.en, LIMITS.phrase);
              return en ? { en, zh: str(x.zh, LIMITS.textZh) } : null;
            })
            .filter((x): x is { en: string; zh: string } => !!x)
            .slice(0, LIMITS.vocabItems)
        : [];
      const note = str(r.note, LIMITS.paragraph);
      if (!items.length && !note) return null;
      return { title, items, ...(note ? { note } : {}) } satisfies VocabGroup;
    })
    .filter((x): x is VocabGroup => !!x)
    .slice(0, LIMITS.vocabGroups);
}

export interface SanitizeResult {
  learning: QuestionLearningContent;
  warnings: string[];
}

/**
 * Turn untrusted content into a safe object. Never throws: bad optional content
 * is dropped with a warning so one malformed phrase cannot block a bank import.
 */
export function sanitizeLearning(raw: unknown, where = "learning"): SanitizeResult {
  const warnings: string[] = [];
  if (raw == null) return { learning: { ...EMPTY_LEARNING, ideaNotes: [], keyPhrases: [] }, warnings };
  if (typeof raw !== "object") return { learning: { ...EMPTY_LEARNING }, warnings: [`${where}: content is not an object`] };
  const r = raw as Record<string, unknown>;

  const answer = sampleAnswer(r.sampleAnswer);
  if (r.sampleAnswer && !answer) warnings.push(`${where}: sampleAnswer dropped (no usable paragraphs)`);

  let follow: FollowAudioRef | null = null;
  if (r.followAudio != null) {
    const f = r.followAudio as Record<string, unknown>;
    const url = checkAudioUrl(f.url);
    const voice = canonicalVoiceId(f.voiceProfile);
    if (!url.ok) warnings.push(`${where}: followAudio dropped (${url.reason})`);
    else if (!voice) warnings.push(`${where}: followAudio dropped (unknown voice profile ${String(f.voiceProfile ?? "")})`);
    else {
      follow = {
        url: url.url!,
        voiceProfile: typeof f.voiceProfile === "string" ? f.voiceProfile.trim() : voice,
        source: source(f.source, "Unlabelled source"),
        ...(typeof f.durationMs === "number" && Number.isFinite(f.durationMs) ? { durationMs: Math.max(0, Math.round(f.durationMs)) } : {}),
      };
    }
  }

  return {
    learning: {
      sampleAnswer: answer,
      ideaNotes: ideaNotes(r.ideaNotes),
      keyPhrases: keyPhrases(r.keyPhrases),
      vocabGroups: vocabGroups(r.vocabGroups),
      followAudio: follow,
    },
    warnings,
  };
}

/** Content summary used in the admin table. */
export function summarizeLearning(c: QuestionLearningContent | null | undefined) {
  return {
    hasSampleAnswer: !!c?.sampleAnswer?.paragraphs?.length,
    ideaNotes: c?.ideaNotes?.length ?? 0,
    keyPhrases: c?.keyPhrases?.length ?? 0,
    hasFollowAudio: !!c?.followAudio?.url,
    reviewStatus: c?.sampleAnswer?.reviewStatus ?? null,
    sourceKind: c?.sampleAnswer?.source?.kind ?? null,
    sourceLabel: c?.sampleAnswer?.source?.label ?? null,
  };
}
