/**
 * Pure policy deciding whether an answer needs a SYNCHRONOUS server
 * transcription before the exam can advance.
 *
 * Background
 * ----------
 * `submitAnswer()` used to `await transcribeAnswer()` for EVERY Part 3 question.
 * But `advance()` only allows follow-ups when `mode !== "full"` (see
 * `allowFollowUps` in exam-service.ts), and `runScoring()` re-transcribes any
 * answer that has no transcript when scoring starts. So for a full mock the
 * synchronous ASR is pure dead weight: it cannot change the transition and its
 * result is not needed until scoring. Practice Part 3 is different —
 * `decideAdvance()` reads the transcript word count to decide short-answer /
 * probe follow-ups, so the transcript must exist before advancing.
 *
 * This function is pure so the branch is unit-testable without a database.
 */
import type { SpeakingMode, SpeakingExamConfig } from "./config";

export type AsrTiming = "sync" | "deferred" | "none";

export interface AsrTimingInput {
  mode: SpeakingMode;
  part: number;
  kind: string;
  /** "server" | "browser" | null — from getASR().location */
  asrLocation: "server" | "browser" | null;
  noResponse: boolean;
  followUpsUsed: number;
  maxFollowUps: number;
}

export function asrTimingForStep(i: AsrTimingInput): AsrTiming {
  // Browser ASR supplies the transcript in the upload form; a no-response
  // answer has nothing worth transcribing.
  if (i.asrLocation !== "server" || i.noResponse) return "none";

  // A full mock follows the fixed bank script (no follow-ups). Scoring will
  // transcribe in the background, so never block the candidate here.
  if (i.mode === "full") return "deferred";

  // Practice: only Part 3 bank questions can produce a follow-up, and only
  // while the follow-up cap has not been reached.
  if (i.part === 3 && i.kind === "question" && i.followUpsUsed < i.maxFollowUps) return "sync";

  return "deferred";
}

/** Convenience wrapper matching the config snapshot shape. */
export function asrTimingFromConfig(
  mode: SpeakingMode,
  step: { part: number; kind: string },
  asrLocation: "server" | "browser" | null,
  noResponse: boolean,
  followUpsUsed: number,
  config: SpeakingExamConfig,
): AsrTiming {
  return asrTimingForStep({
    mode, part: step.part, kind: step.kind, asrLocation, noResponse,
    followUpsUsed, maxFollowUps: config.part3.maxFollowUps,
  });
}
