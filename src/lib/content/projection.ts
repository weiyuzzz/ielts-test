/**
 * The exam-side projection of a question.
 *
 * A mock test may only ever see exam data. Learning material (sample answers,
 * idea notes, key phrases, follow audio) is a separate store, but "separate
 * store" is only a promise until something enumerates what a step may contain.
 * This module is that enumeration: the exam step is assembled field by field, so
 * an extra key on the input row — today's or a future one — cannot leak into the
 * exam payload.
 *
 * `tests/bank-learning.test.ts` asserts that a row carrying learning data
 * projects to an object with none of it.
 */

export interface ExamStepRow {
  id: string;
  stepIndex: number;
  part: number;
  kind: string;
  topic: string;
  examinerLead: string;
  promptText: string;
  cuePoints: string[] | null;
  generator: string;
  prepSeconds: number;
  answerSeconds: number;
  status: string;
  repeatCount: number;
  questionId: number | null;
}

export interface ExamStepAudio {
  url: string | null;
  profile: string | null;
}

export interface ExamStepTranscript {
  status: string;
  text: string;
  provider: string;
}

export interface ExamStepAnswer {
  id: string;
  attempt: number;
  status: string;
  durationMs: number;
  audioAssetId: string | null;
  transcript: ExamStepTranscript | null;
}

export interface ExamStepView {
  id: string;
  stepIndex: number;
  part: number;
  kind: string;
  topic: string;
  examinerLead: string;
  promptText: string;
  cuePoints: string[];
  generator: string;
  prepSeconds: number;
  answerSeconds: number;
  status: string;
  repeatCount: number;
  questionAudioUrl: string | null;
  questionVoiceProfile: string | null;
  answer: ExamStepAnswer | null;
}

/** Every key an exam step may carry. Anything else is a bug. */
export const EXAM_STEP_KEYS: ReadonlyArray<keyof ExamStepView> = [
  "id", "stepIndex", "part", "kind", "topic", "examinerLead", "promptText",
  "cuePoints", "generator", "prepSeconds", "answerSeconds", "status",
  "repeatCount", "questionAudioUrl", "questionVoiceProfile", "answer",
] as const;

/** Keys that belong to study material and must never appear in an exam step. */
export const LEARNING_ONLY_KEYS = [
  "learning", "learningContent", "sampleAnswer", "ideaNotes", "keyPhrases", "followAudio",
] as const;

export function projectExamStep(step: ExamStepRow, audio: ExamStepAudio, answer: ExamStepAnswer | null): ExamStepView {
  return {
    id: step.id,
    stepIndex: step.stepIndex,
    part: step.part,
    kind: step.kind,
    topic: step.topic,
    examinerLead: step.examinerLead,
    promptText: step.promptText,
    cuePoints: step.cuePoints ?? [],
    generator: step.generator,
    prepSeconds: step.prepSeconds,
    answerSeconds: step.answerSeconds,
    status: step.status,
    repeatCount: step.repeatCount,
    questionAudioUrl: audio.url,
    questionVoiceProfile: audio.profile,
    answer,
  };
}

/** Diagnostic used by the tests and the admin page. */
export function learningKeysPresent(view: object): string[] {
  return LEARNING_ONLY_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(view, k));
}
