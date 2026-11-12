/**
 * Audio identity policy — two asset classes that must never be confused.
 *
 *   A. EXAMINER QUESTION AUDIO  (`questions.questionAudioUrl` + `questionVoiceProfile`)
 *      The examiner reading the prompt. Used by a live mock test. May only be
 *      played when its voice identity equals the voice the session was created
 *      with; otherwise the exam falls back to TTS so the examiner never swaps
 *      voice mid-test.
 *
 *   B. LEARNING FOLLOW AUDIO    (`learning.followAudio`)
 *      A model answer read aloud for shadowing. Used on study pages only, via a
 *      plain <audio> element. Never enters the exam player, never goes through
 *      the Examiner Audio Manager, and is never a substitute for (A).
 *
 * This module is the single place that decides "may this clip play, and as
 * which role". The runtime check in `exam-runner.tsx` is intentionally plain
 * string equality (`questionVoiceProfile !== profileId`); the policy below
 * mirrors it exactly rather than being stricter, so the admin preview can never
 * promise playback that the exam would refuse.
 */
import { canonicalVoiceId, checkAudioUrl } from "./validate";
import type { FollowAudioRef } from "./types";

export const AUDIO_ROLE = {
  examiner: "examiner-question",
  follow: "learning-follow",
} as const;

export type AudioRole = (typeof AUDIO_ROLE)[keyof typeof AUDIO_ROLE];

export type ExaminerAudioStatus = "missing" | "invalid-url" | "unlabelled" | "voice-mismatch" | "ready";

export interface AudioAssetLike {
  url: string | null | undefined;
  voiceProfile: string | null | undefined;
}

export interface PlaybackDecision {
  /** `preset` = play the stored recording, `tts` = synthesise instead, `blocked` = not playable at all. */
  source: "preset" | "tts" | "blocked";
  status: ExaminerAudioStatus;
  url?: string;
  /** Why the recording was refused — shown in the admin table, never invented. */
  reason?: string;
  /** True when the label is a different spelling of the session voice, i.e. fixable by relabelling. */
  equivalentVoice?: boolean;
}

/**
 * Decide whether a stored examiner clip may replace the synthesised question.
 * `sessionProfileId` is the profile id frozen into the exam session.
 */
export function decideExaminerAudio(
  asset: AudioAssetLike,
  sessionProfileId: string | null | undefined,
): PlaybackDecision {
  if (!asset.url) return { source: "tts", status: "missing", reason: "no recording for this question" };
  const url = checkAudioUrl(asset.url);
  if (!url.ok) return { source: "tts", status: "invalid-url", reason: url.reason };
  if (!asset.voiceProfile) {
    return { source: "tts", status: "unlabelled", reason: "recording does not declare a voice" };
  }
  if (!sessionProfileId) {
    return { source: "tts", status: "voice-mismatch", reason: "session voice unknown" };
  }
  if (asset.voiceProfile !== sessionProfileId) {
    const sameVoice = canonicalVoiceId(asset.voiceProfile) === canonicalVoiceId(sessionProfileId);
    return {
      source: "tts",
      status: "voice-mismatch",
      reason: sameVoice
        ? `same voice, different label (${asset.voiceProfile} ≠ ${sessionProfileId})`
        : `recorded with ${asset.voiceProfile}, exam uses ${sessionProfileId}`,
      equivalentVoice: sameVoice,
    };
  }
  return { source: "preset", status: "ready", url: url.url };
}

export interface FollowAudioDecision {
  playable: boolean;
  url?: string;
  reason?: string;
  /** Follow audio is study-only; this is always false and exists so callers cannot "reuse" it. */
  usableInExam: false;
}

/** A follow clip needs only a valid URL and a named voice — it never has to match the exam voice. */
export function decideFollowAudio(ref: FollowAudioRef | null | undefined): FollowAudioDecision {
  if (!ref?.url) return { playable: false, reason: "no follow audio", usableInExam: false };
  const url = checkAudioUrl(ref.url);
  if (!url.ok) return { playable: false, reason: url.reason, usableInExam: false };
  if (!canonicalVoiceId(ref.voiceProfile)) {
    return { playable: false, reason: "follow audio has no identifiable voice", usableInExam: false };
  }
  return { playable: true, url: url.url, usableInExam: false };
}

export interface AudioCoverage {
  total: number;
  ready: number;
  voiceMismatch: number;
  unlabelled: number;
  invalidUrl: number;
  missing: number;
  /** 0–100, one decimal — "how many questions actually have a usable examiner clip". */
  coveragePercent: number;
  /** How many of the blocked clips could be fixed by relabelling alone. */
  relabelable: number;
}

export function audioCoverage(
  assets: Array<AudioAssetLike & { part?: number }>,
  sessionProfileId: string | null | undefined,
): AudioCoverage {
  const out: AudioCoverage = {
    total: assets.length, ready: 0, voiceMismatch: 0, unlabelled: 0, invalidUrl: 0, missing: 0,
    coveragePercent: 0, relabelable: 0,
  };
  for (const a of assets) {
    const d = decideExaminerAudio(a, sessionProfileId);
    if (d.status === "ready") out.ready += 1;
    else if (d.status === "voice-mismatch") out.voiceMismatch += 1;
    else if (d.status === "unlabelled") out.unlabelled += 1;
    else if (d.status === "invalid-url") out.invalidUrl += 1;
    else out.missing += 1;
    if (d.equivalentVoice) out.relabelable += 1;
  }
  out.coveragePercent = out.total ? Math.round((out.ready / out.total) * 1000) / 10 : 0;
  return out;
}

/**
 * The two audio references of one question, kept in separate fields.
 *
 * There is deliberately no function that returns "the audio for this question":
 * a caller has to name the role it wants, which is what stops a study clip from
 * being picked up by the exam by accident.
 */
export function audioFields(question: {
  questionAudioUrl?: string | null;
  learning?: { followAudio?: FollowAudioRef | null } | null;
}) {
  return {
    examiner: question.questionAudioUrl ?? null,
    follow: question.learning?.followAudio?.url ?? null,
  };
}
