/**
 * Examiner language. Templates give a stable examiner identity; the LLM is used only
 * for Part 3 follow-up wording (and only when the state machine asks for one).
 */
import type { LLMProvider } from "@/lib/ai/types";
import { withTimeout } from "@/lib/ai/types";

export const EXAMINER_PROMPT_VERSION = "examiner-followup-v1";

export const LINES = {
  opening: (name: string) => `Hello. My name is ${name}, and I'll be your examiner today. This is the IELTS Speaking test.`,
  part1Intro: "In this first part, I'd like to ask you some questions about yourself.",
  part1Topic: (t: string) => `Let's talk about ${t.toLowerCase()}.`,
  part1NextTopic: (t: string) => `Now let's move on to ${t.toLowerCase()}.`,
  part2Intro: "Now I'm going to give you a topic, and I'd like you to talk about it for one to two minutes. Before you talk, you'll have one minute to think about what you're going to say. You can make some notes if you wish.",
  part2Start: "All right? Remember, you have one to two minutes for this. I'll tell you when the time is up. Can you start speaking now, please?",
  part3Intro: (t: string) => `We've been talking about ${t.toLowerCase()}, and I'd like to discuss with you one or two more general questions related to this.`,
  part3Practice: (t: string) => `Let's discuss some general questions related to ${t.toLowerCase()}.`,
  ack: ["Thank you.", "OK.", "Right.", "I see."],
  noResponse: "That's all right. Let's move on.",
  closing: "Thank you. That is the end of the speaking test.",
  repeatPrefix: "Of course.",
};

const SHORT_FOLLOWUPS = [
  "Why do you think that is?",
  "Could you give me an example?",
  "Can you explain that a little more?",
  "What makes you say that?",
];

export function templateFollowUp(seed: number) {
  return SHORT_FOLLOWUPS[Math.abs(seed) % SHORT_FOLLOWUPS.length];
}

/** Sanitize LLM follow-up: single short question, no answers/feedback, English only. */
export function sanitizeFollowUp(raw: string): string | null {
  let s = raw.trim().replace(/^["'“]|["'”]$/g, "").split("\n")[0].trim();
  if (s.length < 8 || s.length > 180) return null;
  if (!s.endsWith("?")) return null;
  if (/\b(good answer|great answer|band|score|you should say|correct answer|as an ai)\b/i.test(s)) return null;
  if (/[\u4e00-\u9fff]/.test(s)) return null;
  s = s.replace(/\s+/g, " ");
  return s;
}

export async function generateFollowUp(
  llm: LLMProvider,
  ctx: { question: string; answer: string; topic: string },
  timeoutMs: number,
): Promise<string | null> {
  const out = await withTimeout(llm.id, timeoutMs, (signal) =>
    llm.complete(
      [
        {
          role: "system",
          content:
            "You are a calm, neutral IELTS Speaking Part 3 examiner. Ask exactly ONE short follow-up question (max 20 words) that probes the candidate's reasoning about what they just said, staying on the topic. Never praise, correct, evaluate, give answers or examples of answers, or change the test procedure. Output only the question.",
        },
        { role: "user", content: `Topic: ${ctx.topic}\nQuestion: ${ctx.question}\nCandidate answer (ASR transcript): ${ctx.answer.slice(0, 1500)}` },
      ],
      { temperature: 0.5, maxTokens: 60, signal },
    ),
  );
  return sanitizeFollowUp(out);
}
