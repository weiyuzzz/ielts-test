/**
 * Shadowing state machine — recording, local playback, optional transcription.
 *
 * Two invariants the tests pin down:
 *
 *   1. No ASR does NOT disable the feature. Recording and playback are local
 *      browser capabilities; transcription is a bonus. If the provider is
 *      missing, the take stays playable and the UI says "无法转写".
 *   2. A shadowing take is NOT an exam answer. It is never uploaded, never
 *      written to `answer_records`, and lives only in page memory. That is why
 *      there is no database call anywhere in this module — see
 *      `tests/bank-learning.test.ts` ("no persistence imports").
 */

export type TakeStatus = "none" | "recording" | "recorded";
export type TranscriptStatus = "idle" | "pending" | "ok" | "unavailable" | "failed";

export interface ShadowingTake {
  /** Page-scoped id (`crypto.randomUUID`), never a database id. */
  id: string;
  durationMs: number;
  mimeType: string;
  /** Object URL of the local recording, for replay. Revoked when replaced. */
  objectUrl: string;
  /** Whether a 16 kHz WAV exists for transcription. */
  hasWav: boolean;
}

export interface ShadowingTranscript {
  status: TranscriptStatus;
  text?: string;
  provider?: string;
  /** Why transcription is unavailable — surfaced verbatim, never hidden. */
  reason?: string;
}

export interface ShadowingState {
  takeStatus: TakeStatus;
  take: ShadowingTake | null;
  transcript: ShadowingTranscript;
  completed: boolean;
}

export const INITIAL_SHADOWING: ShadowingState = {
  takeStatus: "none",
  take: null,
  transcript: { status: "idle" },
  completed: false,
};

export type ShadowingEvent =
  | { type: "start-recording" }
  | { type: "take-ready"; take: ShadowingTake }
  | { type: "transcribe" }
  | { type: "transcribed"; text: string; provider?: string }
  | { type: "asr-unavailable"; reason: string }
  | { type: "asr-failed"; error: string }
  | { type: "discard-take" }
  | { type: "complete" };

export function reduceShadowing(state: ShadowingState, event: ShadowingEvent): ShadowingState {
  switch (event.type) {
    case "start-recording":
      // A new recording invalidates the previous take *and* its transcript.
      return { ...state, takeStatus: "recording", transcript: { status: "idle" } };
    case "take-ready":
      return { ...state, takeStatus: "recorded", take: event.take, transcript: { status: "idle" }, completed: false };
    case "transcribe":
      if (!state.take) return state; // nothing to transcribe — stay silent, do not error
      return { ...state, transcript: { status: "pending" } };
    case "transcribed":
      return { ...state, transcript: { status: "ok", text: event.text, provider: event.provider } };
    case "asr-unavailable":
      // Degrade, do not fail: the take remains playable.
      return { ...state, transcript: { status: "unavailable", reason: event.reason } };
    case "asr-failed":
      return { ...state, transcript: { status: "failed", reason: event.error } };
    case "discard-take":
      return { ...state, takeStatus: "none", take: null, transcript: { status: "idle" }, completed: false };
    case "complete":
      if (!state.take) return state;
      return { ...state, completed: true };
    default:
      return state;
  }
}

/** Can the learner still replay what they recorded? Independent of ASR state. */
export function canReplay(state: ShadowingState): boolean {
  return !!state.take?.objectUrl;
}

/** Can transcription be attempted at all? */
export function canTranscribe(state: ShadowingState, asrAvailable: boolean): boolean {
  return !!state.take?.hasWav && asrAvailable && state.transcript.status !== "pending";
}

export interface TakeStore {
  readonly persistence: "session-memory";
  put(questionKey: string, take: ShadowingTake): void;
  list(questionKey: string): ShadowingTake[];
  clear(): void;
}

/**
 * In-memory store for the current page visit. There is deliberately no `save()`
 * and no disk/DB backend: shadowing takes are practice material, not exam
 * evidence, and must not survive as assessment data.
 */
export function createTakeStore(): TakeStore {
  const byQuestion = new Map<string, ShadowingTake[]>();
  return {
    persistence: "session-memory",
    put(key, take) {
      const list = byQuestion.get(key) ?? [];
      list.push(take);
      byQuestion.set(key, list.slice(-10));
    },
    list(key) {
      return [...(byQuestion.get(key) ?? [])];
    },
    clear() {
      byQuestion.clear();
    },
  };
}
