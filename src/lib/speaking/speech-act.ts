/**
 * Examiner speech acts — the missing dimension in "text → voice".
 *
 * A real examiner does not read every line with the same delivery: a greeting
 * is lighter, an instruction is steady, a question rises, an acknowledgement is
 * short and flat, a closing slows slightly. Feeding all of them through one
 * rate/pause setting is what makes the voice sound like a navigation system.
 *
 * Each act only tweaks *delivery*: no act changes the wording of a question or
 * the rules of the test.
 */

export type ExaminerSpeechAct =
  | "greeting"
  | "introduction"
  | "instruction"
  | "question"
  | "acknowledgement"
  | "time_warning"
  | "closing";

export interface SpeechActStyle {
  id: ExaminerSpeechAct;
  label: string;
  /** Multiplier on the profile's base speed. Small on purpose (±6%). */
  speedFactor: number;
  /** Pause between statements (ms); 0 → use the profile value. */
  sentencePauseMs: number;
  /** Pause after a question (ms); 0 → use the profile value. */
  questionPauseMs: number;
  /** Whether subtle word emphasis is appropriate for this act. */
  emphasis: boolean;
  /** Browser fallback: final `rate` multiplier and `pitch` multiplier. */
  browserRateFactor: number;
  browserPitchFactor: number;
  /** Natural-language direction for engines that accept it (gpt-4o-*-tts). */
  instructions: string;
}

const BASE_INSTRUCTIONS =
  "You are an experienced IELTS Speaking examiner conducting a real face-to-face examination. " +
  "Speak in natural, conversational British English. Your voice should sound calm, professional and human.";

export const SPEECH_ACTS: Record<ExaminerSpeechAct, SpeechActStyle> = {
  greeting: {
    id: "greeting",
    label: "Greeting",
    speedFactor: 0.99,
    sentencePauseMs: 240,
    questionPauseMs: 420,
    emphasis: false,
    browserRateFactor: 0.99,
    browserPitchFactor: 1,
    instructions:
      `${BASE_INSTRUCTIONS} This line greets the candidate at the start of the test. ` +
      "Keep it light, friendly and unhurried — a real person saying hello, not an announcer reading a script. " +
      "Do not sound delighted or theatrical.",
  },
  introduction: {
    id: "introduction",
    label: "Introduction",
    speedFactor: 1,
    sentencePauseMs: 260,
    questionPauseMs: 460,
    emphasis: true,
    browserRateFactor: 1,
    browserPitchFactor: 1,
    instructions:
      `${BASE_INSTRUCTIONS} This line introduces a part of the test. Speak clearly and professionally at a normal conversational pace, ` +
      "letting important words land naturally without over-stressing them. Sound informative, not performative.",
  },
  instruction: {
    id: "instruction",
    label: "Instruction",
    speedFactor: 0.96,
    sentencePauseMs: 300,
    questionPauseMs: 460,
    emphasis: true,
    browserRateFactor: 0.96,
    browserPitchFactor: 1,
    instructions:
      `${BASE_INSTRUCTIONS} This line gives a rule or a time limit. Keep the delivery steady and unambiguous, ` +
      "with a slight beat after the time reference so the candidate registers it. Do not emphasise every word, and do not sound stern.",
  },
  question: {
    id: "question",
    label: "Question",
    speedFactor: 1,
    sentencePauseMs: 240,
    questionPauseMs: 440,
    emphasis: true,
    browserRateFactor: 1,
    browserPitchFactor: 1.01,
    instructions:
      `${BASE_INSTRUCTIONS} This line is an exam question. Use genuinely natural question intonation: a light rise where English requires it, ` +
      "and a falling pattern for wh-questions. Vary the melody between sentences instead of ending every sentence the same way. " +
      "Curious and engaged, never sing-song.",
  },
  acknowledgement: {
    id: "acknowledgement",
    label: "Acknowledgement",
    speedFactor: 1.02,
    sentencePauseMs: 180,
    questionPauseMs: 340,
    emphasis: false,
    browserRateFactor: 1.02,
    browserPitchFactor: 0.99,
    instructions:
      `${BASE_INSTRUCTIONS} This is a short neutral acknowledgement between answers — for example "Thank you" or "Right". ` +
      "Say it briefly and evenly, like a person moving the conversation along. Never sound impressed, praising or evaluative.",
  },
  time_warning: {
    id: "time_warning",
    label: "Time warning",
    speedFactor: 1,
    sentencePauseMs: 300,
    questionPauseMs: 460,
    emphasis: true,
    browserRateFactor: 1,
    browserPitchFactor: 1,
    instructions:
      `${BASE_INSTRUCTIONS} This line signals that time is up. Keep it calm, clear and matter-of-fact, ` +
      "with a short pause after the closing sentence. No urgency, no apology, no drama.",
  },
  closing: {
    id: "closing",
    label: "Closing",
    speedFactor: 0.95,
    sentencePauseMs: 320,
    questionPauseMs: 500,
    emphasis: false,
    browserRateFactor: 0.95,
    browserPitchFactor: 0.99,
    instructions:
      `${BASE_INSTRUCTIONS} This line ends the test. Slow down very slightly and finish politely and naturally, ` +
      "as a professional examiner would close an interview. Warm but not emotional, and never rushed.",
  },
};

export const SPEECH_ACT_LIST: SpeechActStyle[] = [
  SPEECH_ACTS.greeting,
  SPEECH_ACTS.introduction,
  SPEECH_ACTS.instruction,
  SPEECH_ACTS.question,
  SPEECH_ACTS.acknowledgement,
  SPEECH_ACTS.time_warning,
  SPEECH_ACTS.closing,
];

export function isSpeechAct(v: unknown): v is ExaminerSpeechAct {
  return typeof v === "string" && v in SPEECH_ACTS;
}

export function speechActStyle(act: ExaminerSpeechAct | undefined): SpeechActStyle {
  return SPEECH_ACTS[act ?? "question"] ?? SPEECH_ACTS.question;
}
