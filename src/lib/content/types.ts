/**
 * Question learning content (Phase 3).
 *
 * SCOPE — what this module is NOT
 * -------------------------------
 * Learning material is a *study* artefact, never exam data. Nothing here is
 * read by `exam-service` when a mock test is assembled, and nothing here may
 * change the wording of an exam question. The exam prompt and the sample answer
 * are two different things with two different purposes:
 *
 *   questions.text                 → what the examiner asks  (exam)
 *   learning.sampleAnswer          → what a candidate could say (study)
 *
 * STORAGE
 * -------
 * `src/db/schema.ts` is frozen for this phase (the shared interface owner owns
 * it), and the current schema has no `questions.learningContent` column. The
 * content is therefore persisted as a versioned sidecar file per season under
 * `src/data/learning/<season>.json`, keyed by a natural key that survives the
 * delete+reinsert cycle of `importBank()`:
 *
 *   season + topicKey + part + normalised question text
 *
 * The sidecar is deliberately *outside* the exam tables, which is also what
 * makes "full mock never returns learning material" true by construction
 * rather than by a filter that somebody can forget.
 */

/** Where a piece of content came from. Displayed verbatim — never beautified. */
export type LearningSourceKind =
  | "team"        // written in-house by the content team
  | "ai-draft"    // machine-drafted, not yet human-reviewed
  | "third-party" // licensed / permission-granted external material
  | "imported";   // came in with a bank JSON, provenance unknown

export interface LearningSource {
  kind: LearningSourceKind;
  /** Human-readable provenance line shown in the UI. */
  label: string;
  /** Optional citation (URL or document reference). */
  url?: string;
}

/**
 * Manual review state. An AI draft can never become "reviewed" by itself —
 * `reviewStatus` has to be set by a human in the source file, and the UI shows
 * the raw value so a draft cannot pass for vetted material.
 */
export type ReviewStatus = "draft" | "reviewed" | "rejected";

export interface SampleAnswer {
  /**
   * The answer split into speakable units (1–3 sentences each). Splitting the
   * text is what makes sentence-level playback possible without re-synthesis
   * of the whole paragraph.
   */
  paragraphs: string[];
  /**
   * Chinese translation, aligned with `paragraphs` when the counts match.
   * Imported documents often translate a whole answer in one block, so this can
   * legitimately be a single element — the UI shows it as one block then.
   */
  paragraphsZh?: string[];
  /** e.g. "串题故事：附近景区" or "合并回答（同组共用）" — never an official label. */
  variantLabel?: string;
  source: LearningSource;
  reviewStatus: ReviewStatus;
  /**
   * A self-declared target, NOT an official band and never rendered as one.
   * Leave null when unknown.
   */
  targetBandHint?: number | null;
}

/** The four-part idea skeleton (main idea → reason → example → result). */
export type IdeaStage = "main-idea" | "reason" | "example" | "result" | "contrast";

export interface IdeaNote {
  stage: IdeaStage;
  /** Original heading from the source ("直接表态 + 受欢迎程度", "观点"). */
  label?: string;
  text: string;
  textZh?: string;
  /** The English phrases the step is built from, already split. */
  phrases?: string[];
  /** The source's explanation of why those phrases work. */
  note?: string;
}

export interface KeyPhrase {
  phrase: string;
  zh: string;
  /** A full English sentence showing the phrase in use. */
  example?: string;
  /** When to reach for it (function, register, typical context). */
  usage?: string;
}

/**
 * Audio for SHADOWING (reading a model answer aloud).
 *
 * This is a different asset class from `questions.questionAudioUrl`
 * (the examiner reading the question). They have different fields, different
 * identities and different playback paths on purpose — see `audio-policy.ts`.
 */
export interface FollowAudioRef {
  url: string;
  /** VoiceProfile id that recorded the clip. Empty/unknown is not playable. */
  voiceProfile: string;
  source: LearningSource;
  durationMs?: number;
}

/** One vocabulary item: English form + Chinese gloss. */
export interface VocabItem {
  en: string;
  zh: string;
}

/** A themed group of expressions ("质量好", "佩戴场景", …). */
export interface VocabGroup {
  title: string;
  items: VocabItem[];
  /** Free text kept when the source could not be split into items. */
  note?: string;
}

export interface QuestionLearningContent {
  sampleAnswer?: SampleAnswer | null;
  ideaNotes?: IdeaNote[];
  keyPhrases?: KeyPhrase[];
  /** 语料扩展 — themed vocabulary lists from the source document. */
  vocabGroups?: VocabGroup[];
  followAudio?: FollowAudioRef | null;
}

/** A question plus its (possibly empty) study material. */
export interface LearningQuestion {
  id: number;
  part: number;
  topic: string;
  topicKey: string;
  topicZh: string | null;
  text: string;
  textZh: string | null;
  cuePoints: string[] | null;
  /** 考试人数 from the source document (null when the document has no figure). */
  examinees?: number | null;
  learning: QuestionLearningContent;
}

export const EMPTY_LEARNING: QuestionLearningContent = {
  sampleAnswer: null,
  ideaNotes: [],
  keyPhrases: [],
  vocabGroups: [],
  followAudio: null,
};

/** True when the object carries at least one usable study field. */
export function hasLearning(c: QuestionLearningContent | null | undefined): boolean {
  if (!c) return false;
  return !!(
    c.sampleAnswer?.paragraphs?.length ||
    c.ideaNotes?.length ||
    c.keyPhrases?.length ||
    c.vocabGroups?.length ||
    c.followAudio?.url
  );
}
