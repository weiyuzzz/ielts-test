/**
 * Gate-question branching for Part 1 evergreen topics.
 *
 * Some topics ("Work or studies") mix questions written for students with
 * questions written for working candidates. The examiner must first ask the
 * gate question ("Do you work, or are you a student?") and then draw the
 * follow-ups from the matching sub-bank — never ask a student "What work do
 * you do?".
 *
 * The classification is deliberately keyword-based and pure, not an LLM call:
 * the gate decides the exam script, so it must never depend on an AI call
 * succeeding or a provider being configured. When the transcript is missing,
 * unreadable or genuinely ambiguous (both sides hit equally), returning null
 * keeps the neutral questions that were pre-planned at session creation.
 */

export type GateAudience = "student" | "work";

/** Words that only a student's answer plausibly contains. */
const STUDENT_RE =
  /\b(student|study|studies|studying|school|university|college|campus|major|semester|degree|classmate|lecture|exam|homework|thesis|dorm|professor|tuition)\b/gi;

/** Words that only a working candidate's answer plausibly contains. */
const WORK_RE =
  /\b(work|works|working|worked|job|jobs|company|companies|colleague|colleagues|boss|office|career|salary|employed|employer|employee|profession|shift|manager|coworker|freelance|full-time|part-time)\b/gi;

/**
 * Classify the gate answer's transcript. Returns the audience, or null when
 * the evidence is absent or tied (e.g. "I'm a student and I don't work yet" —
 * the neutral follow-ups planned at session creation are valid for either).
 */
export function classifyWorkOrStudy(transcript: string | null | undefined): GateAudience | null {
  const t = (transcript ?? "").toLowerCase();
  if (!t.trim()) return null;
  const student = (t.match(STUDENT_RE) ?? []).length;
  const work = (t.match(WORK_RE) ?? []).length;
  if (student === work) return null;
  return student > work ? "student" : "work";
}
