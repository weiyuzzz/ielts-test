/**
 * Pure exam state machine. No I/O — the service layer loads state from the DB,
 * asks the machine what is allowed / what happens next, then persists the result.
 * The LLM never decides transitions; it can only supply wording when the machine
 * returns a `follow_up` decision.
 */
import type { SpeakingExamConfig } from "./config";

export type SessionStatus = "in_progress" | "completed" | "abandoned";
export type StepKind = "question" | "cue_card" | "follow_up";

export interface MachineStep {
  id: string;
  stepIndex: number;
  part: number;
  kind: StepKind;
  status: "pending" | "answered" | "skipped";
  parentId?: string | null;
  repeatCount: number;
}

export interface MachineState {
  status: SessionStatus;
  currentStep: number;
  steps: MachineStep[];
  config: SpeakingExamConfig;
}

export type MachineError =
  | "session_not_active"
  | "not_current_step"
  | "already_answered"
  | "rerecord_not_allowed"
  | "repeat_limit"
  | "step_not_answered"
  | "unknown_step";

export type Result<T> = { ok: true; value: T } | { ok: false; error: MachineError };

export function currentStep(s: MachineState): MachineStep | undefined {
  return s.steps.find((x) => x.stepIndex === s.currentStep);
}

export function canSubmitAnswer(s: MachineState, stepId: string): Result<{ isRerecord: boolean }> {
  if (s.status !== "in_progress") return { ok: false, error: "session_not_active" };
  const step = s.steps.find((x) => x.id === stepId);
  if (!step) return { ok: false, error: "unknown_step" };
  if (step.stepIndex !== s.currentStep) return { ok: false, error: "not_current_step" };
  if (step.status === "answered") {
    if (!s.config.allowRerecord) return { ok: false, error: "already_answered" };
    return { ok: true, value: { isRerecord: true } };
  }
  return { ok: true, value: { isRerecord: false } };
}

export function canRepeat(s: MachineState, stepId: string): Result<{ remaining: number }> {
  if (s.status !== "in_progress") return { ok: false, error: "session_not_active" };
  const step = s.steps.find((x) => x.id === stepId);
  if (!step) return { ok: false, error: "unknown_step" };
  if (step.stepIndex !== s.currentStep) return { ok: false, error: "not_current_step" };
  if (step.repeatCount >= s.config.maxRepeatsPerQuestion) return { ok: false, error: "repeat_limit" };
  return { ok: true, value: { remaining: s.config.maxRepeatsPerQuestion - step.repeatCount - 1 } };
}

export interface AnswerSummary {
  wordCount: number;
  noResponse: boolean;
}

export type AdvanceDecision =
  | { type: "follow_up"; parentId: string; reason: "short_answer" | "probe" }
  | { type: "next"; nextStep: number; partChanged: boolean }
  | { type: "finish" };

/**
 * Decide what happens after the current step. `fromStep` guards against duplicate
 * advance requests (double clicks / retries): it must equal the current step.
 */
export function decideAdvance(
  s: MachineState,
  fromStep: number,
  answer: AnswerSummary | null,
  opts: { llmAvailable: boolean; allowFollowUps?: boolean },
): Result<AdvanceDecision> {
  if (s.status !== "in_progress") return { ok: false, error: "session_not_active" };
  if (fromStep !== s.currentStep) return { ok: false, error: "not_current_step" };
  const step = currentStep(s);
  if (!step) return { ok: false, error: "unknown_step" };
  if (step.status === "pending") return { ok: false, error: "step_not_answered" };

  // A full mock test follows the fixed bank script; only practice modes may probe.
  if (step.part === 3 && step.kind === "question" && answer && !answer.noResponse && opts.allowFollowUps !== false) {
    const used = s.steps.filter((x) => x.kind === "follow_up").length;
    const p3 = s.config.part3;
    if (used < p3.maxFollowUps) {
      if (answer.wordCount < p3.shortAnswerWords) {
        return { ok: true, value: { type: "follow_up", parentId: step.id, reason: "short_answer" } };
      }
      if (opts.llmAvailable && p3.llmFollowUpsOnSubstantive && used === 0) {
        return { ok: true, value: { type: "follow_up", parentId: step.id, reason: "probe" } };
      }
    }
  }

  const next = s.steps
    .filter((x) => x.stepIndex > s.currentStep)
    .sort((a, b) => a.stepIndex - b.stepIndex)[0];
  if (!next) return { ok: true, value: { type: "finish" } };
  return { ok: true, value: { type: "next", nextStep: next.stepIndex, partChanged: next.part !== step.part } };
}

export function canFinish(s: MachineState): Result<true> {
  if (s.status !== "in_progress") return { ok: false, error: "session_not_active" };
  const last = Math.max(...s.steps.map((x) => x.stepIndex));
  const step = currentStep(s);
  if (s.currentStep !== last || !step || step.status === "pending") return { ok: false, error: "step_not_answered" };
  return { ok: true, value: true };
}
