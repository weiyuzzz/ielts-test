/**
 * All exam timing / counts live here — never hard-code them in components.
 * A snapshot of the resolved config is stored on each exam session so that
 * later config changes never alter an in-flight or historical exam.
 */
export type SpeakingMode = "full" | "part1" | "part2" | "part3";

export interface SpeakingExamConfig {
  mode: SpeakingMode;
  part1: { enabled: boolean; topics: number; questionsPerTopic: number; answerSeconds: number };
  part2: { enabled: boolean; prepSeconds: number; answerSeconds: number };
  part3: {
    enabled: boolean;
    questions: number;
    answerSeconds: number;
    /** Max follow-ups for the whole Part 3 */
    maxFollowUps: number;
    /** Answers with fewer words than this get a probing follow-up */
    shortAnswerWords: number;
    /** Allow the LLM to ask follow-ups on substantive answers too */
    llmFollowUpsOnSubstantive: boolean;
  };
  /** Candidate may finish an answer early after this many seconds */
  minFinishSeconds: number;
  /** Answers shorter than this (ms) are treated as "no response" */
  noResponseMs: number;
  maxRepeatsPerQuestion: number;
  allowRerecord: boolean;
  showTranscriptLive: boolean;
  maxUploadBytes: number;
}

const BASE: Omit<SpeakingExamConfig, "mode"> = {
  part1: { enabled: true, topics: 2, questionsPerTopic: 3, answerSeconds: 30 },
  part2: { enabled: true, prepSeconds: 60, answerSeconds: 120 },
  part3: {
    enabled: true,
    questions: 4,
    answerSeconds: 60,
    maxFollowUps: 2,
    shortAnswerWords: 25,
    llmFollowUpsOnSubstantive: true,
  },
  minFinishSeconds: 5,
  noResponseMs: 1500,
  maxRepeatsPerQuestion: 1,
  allowRerecord: false,
  showTranscriptLive: false,
  maxUploadBytes: 24 * 1024 * 1024,
};

export function resolveConfig(mode: SpeakingMode): SpeakingExamConfig {
  const c: SpeakingExamConfig = structuredClone({ ...BASE, mode });
  if (mode !== "full") {
    c.part1.enabled = mode === "part1";
    c.part2.enabled = mode === "part2";
    c.part3.enabled = mode === "part3";
    c.allowRerecord = true;
    c.maxRepeatsPerQuestion = 3;
    if (mode === "part1") {
      c.part1.topics = 1;
      c.part1.questionsPerTopic = 4;
    }
  }
  return c;
}

export const SPEAKING_MODES: { mode: SpeakingMode; title: string; description: string; minutes: string }[] = [
  { mode: "full", title: "Full mock test", description: "Part 1 → Part 2 → Part 3 under exam timing, one attempt per question.", minutes: "11–14 min" },
  { mode: "part1", title: "Part 1 practice", description: "Short questions on a familiar topic. Re-record allowed.", minutes: "3–4 min" },
  { mode: "part2", title: "Part 2 practice", description: "Cue card, 1 minute preparation, up to 2 minutes speaking.", minutes: "3–4 min" },
  { mode: "part3", title: "Part 3 practice", description: "Abstract discussion questions with examiner follow-ups.", minutes: "4–5 min" },
];

export const EXAMINER_NAMES = ["Daniel", "Sarah", "James", "Emma"];
