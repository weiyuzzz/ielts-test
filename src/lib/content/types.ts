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
  text: string;
  textZh?: string;
}

export interface KeyPhrase {
  phrase: string;
  zh: string;
  /** A full English sentence showing the phrase in use. */
  example: string;
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

export interface QuestionLearningContent {
  sampleAnswer?: SampleAnswer | null;
  ideaNotes?: IdeaNote[];
  keyPhrases?: KeyPhrase[];
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
  learning: QuestionLearningContent;
}

export const EMPTY_LEARNING: QuestionLearningContent = {
  sampleAnswer: null,
  ideaNotes: [],
  keyPhrases: [],
  followAudio: null,
};

/** True when the object carries at least one usable study field. */
export function hasLearning(c: QuestionLearningContent | null | undefined): boolean {
  if (!c) return false;
  return !!(
    c.sampleAnswer?.paragraphs?.length ||
    c.ideaNotes?.length ||
    c.keyPhrases?.length ||
    c.followAudio?.url
  );
}
