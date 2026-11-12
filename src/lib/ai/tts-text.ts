/**
 * Text front-end for the examiner voice (pure functions, unit-tested).
 *
 * A TTS engine reading one long flat string produces a flat, "robotic" delivery:
 * every clause gets the same rhythm and there is no breath between sentences.
 * This module adds two layers on top of plain text:
 *   1. sentence segmentation + human-length pauses (all engines),
 *   2. a per-utterance speech act (greeting / question / instruction …) that
 *      changes rate, pauses and emphasis — the difference between a navigation
 *      prompt and a person conducting an interview.
 *
 * Everything here is pure: no network, no env, no provider specifics.
 */
import { SPEECH_ACTS, speechActStyle, type ExaminerSpeechAct } from "@/lib/speaking/speech-act";
import { clampPitch, clampSpeed, type VoiceProfile } from "@/lib/speaking/voice-profile";

/** Collapse whitespace and strip characters that make engines spell out symbols. */
export function normalizeExaminerText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/_{2,}|-{3,}/g, ",")
    .trim();
}

/** Split on sentence-ending punctuation followed by a space, keeping the punctuation. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?]+(?:[.!?]+|$)/g;
  for (const m of text.matchAll(re)) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  return out.length ? out : text.trim() ? [text.trim()] : [];
}

function xml(s: string): string {
  // Only & < > need escaping in an SSML text node. Quotes are left alone so
  // contractions such as "I'd" are never turned into spoken entity names.
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * SSML wrapper for examiner lines. `strength` (not `time`) is used because it is
 * the one break form every SSML-capable engine implements: weak = 250 ms,
 * medium = 500 ms. Kept for callers that have no speech act available.
 */
export function toProsodySsml(text: string): string {
  const sentences = splitSentences(normalizeExaminerText(text));
  if (!sentences.length) return "<speak></speak>";
  const body = sentences
    .map((s, i) => {
      const pause = i < sentences.length - 1
        ? `<break strength="${/[?]\s*$/.test(s) ? "medium" : "weak"}"/>`
        : "";
      return `${xml(s)}${pause}`;
    })
    .join(" ");
  return `<speak>${body}</speak>`;
}

/** SSML for Azure Neural voices (needs its own namespace / xml:lang / voice element). */
export function toAzureSsml(text: string, voice: string, lang = "en-GB", rate = "-4%"): string {
  const body = splitSentences(normalizeExaminerText(text))
    .map((s, i, all) => {
      const pause = i < all.length - 1
        ? `<break strength="${/[?]\s*$/.test(s) ? "medium" : "weak"}"/>`
        : "";
      return `${xml(s)}${pause}`;
    })
    .join(" ");
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/Synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}"><voice name="${voice}"><prosody rate="${rate}">${body}</prosody></voice></speak>`;
}

/** Steering prompt for gpt-4o-mini-tts (ignored by engines that do not support it). */
export const EXAMINER_TTS_INSTRUCTIONS =
  "Speak as a calm, professional IELTS Speaking examiner. Neutral, warm and unhurried; natural sentence rhythm with a short pause between sentences, clear articulation, no dramatic emphasis, no emotion, no acting.";

// ------------------------------------------------------------------ speech acts

export interface ExaminerSpeechRequest {
  text: string;
  speechAct: ExaminerSpeechAct;
  profile: VoiceProfile;
}

export interface PreparedSpeech {
  /** Plain text for engines that reject SSML entirely. */
  plain: string;
  /** Portable SSML: <speak> + strength-based breaks (Azure, Kokoro-compatible). */
  ssml: string;
  /** Direction text for engines that accept natural-language steering. */
  instructions: string;
  /** Final rate after the act's adjustment (1 = engine default). */
  speed: number;
  /** Pitch in semitones, already clamped. */
  pitchSemitones: number;
  speechAct: ExaminerSpeechAct;
  /** Words that may carry a subtle emphasis, at most one per sentence. */
  emphasisWords: string[];
}

/** Words that carry no information and must never be emphasised. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "at", "for", "with", "from", "by",
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "have", "has", "had",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them", "my", "your", "our",
  "this", "that", "these", "those", "there", "here", "some", "any", "more", "most", "very", "just",
  "would", "could", "should", "will", "shall", "can", "may", "might", "about", "into", "over", "than",
  "then", "so", "as", "not", "no", "yes", "please", "ok", "okay", "well", "now", "also", "thank",
]);

/**
 * Pick at most one informative word per sentence. Deliberately conservative:
 * over-emphasis is the fastest way to sound like a machine reading a script.
 */
export function pickEmphasisWord(sentence: string): string | null {
  const words = sentence.replace(/[^\p{L}\p{N}'\- ]/gu, " ").split(/\s+/).filter(Boolean);
  let best: string | null = null;
  for (const w of words) {
    const clean = w.replace(/^['-]+|['-]+$/g, "");
    if (clean.length < 6) continue;
    if (STOPWORDS.has(clean.toLowerCase())) continue;
    if (best === null || clean.length > best.length) best = clean;
  }
  return best;
}

/** SSML break strength that best matches a pause length. */
function strengthFor(ms: number): "weak" | "medium" | "strong" {
  if (ms >= 420) return "strong";
  if (ms >= 220) return "medium";
  return "weak";
}

/** Wrap one word in <emphasis>, escaping the surrounding text. */
function emphasiseWord(sentence: string, word: string): string {
  const idx = sentence.indexOf(word);
  if (idx < 0) return xml(sentence);
  return `${xml(sentence.slice(0, idx))}<emphasis level="moderate">${xml(word)}</emphasis>${xml(sentence.slice(idx + word.length))}`;
}

/**
 * Turn one examiner line into an engine-ready payload for a given speech act.
 */
export function prepareExaminerSpeech(req: ExaminerSpeechRequest): PreparedSpeech {
  const style = speechActStyle(req.speechAct);
  const profile = req.profile;
  const plain = normalizeExaminerText(req.text);
  const sentences = splitSentences(plain);
  const speed = clampSpeed(profile.speed * style.speedFactor);
  const pitchSemitones = clampPitch(profile.pitch ?? 0);

  const sentenceMs = style.sentencePauseMs || profile.prosody.sentencePauseMs;
  const questionMs = style.questionPauseMs || profile.prosody.questionPauseMs;
  const emphasisOn = style.emphasis && profile.prosody.emphasisEnabled;
  const emphasisWords: string[] = [];

  const body = sentences
    .map((s, i) => {
      const isQuestion = /\?\s*$/.test(s);
      const emphasis = emphasisOn ? pickEmphasisWord(s) : null;
      if (emphasis) emphasisWords.push(emphasis);
      const inner = emphasis ? emphasiseWord(s, emphasis) : xml(s);
      if (i === sentences.length - 1) return inner;
      const pause = isQuestion ? questionMs : sentenceMs;
      return `${inner}<break strength="${strengthFor(pause)}"/>`;
    })
    .join(" ");

  return {
    plain,
    ssml: `<speak>${body}</speak>`,
    instructions: profile.instructions?.trim() || style.instructions,
    speed,
    pitchSemitones,
    speechAct: req.speechAct,
    emphasisWords,
  };
}

/**
 * Azure SSML for one prepared line: exact pause times, prosody rate/pitch and
 * optional emphasis. Only elements Azure Neural voices document are emitted —
 * an unsupported element fails the whole request, so nothing is guessed.
 */
export function toAzureSsmlForAct(prepared: PreparedSpeech, voice: string, lang = "en-GB", style?: string): string {
  const def = speechActStyle(prepared.speechAct);
  const sentences = splitSentences(prepared.plain);
  const body = sentences
    .map((s, i) => {
      const emphasis = prepared.emphasisWords.find((w) => s.includes(w));
      const inner = emphasis ? emphasiseWord(s, emphasis) : xml(s);
      if (i === sentences.length - 1) return inner;
      const isQuestion = /\?\s*$/.test(s);
      const ms = isQuestion || prepared.speechAct === "question" ? def.questionPauseMs : def.sentencePauseMs;
      return `${inner}<break time="${Math.round(ms)}ms"/>`;
    })
    .join(" ");

  const ratePct = Math.round((prepared.speed - 1) * 100);
  const rate = `${ratePct >= 0 ? "+" : ""}${ratePct}%`;
  // Azure takes pitch as a percentage; one semitone ≈ 5.9 %.
  const pitchPct = Math.round(prepared.pitchSemitones * 5.9);
  const pitch = `${pitchPct >= 0 ? "+" : ""}${pitchPct}%`;
  const open = style
    ? `<mstts:express-as style="${style}"><prosody rate="${rate}" pitch="${pitch}">`
    : `<prosody rate="${rate}" pitch="${pitch}">`;
  const close = style ? `</prosody></mstts:express-as>` : `</prosody>`;
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/Synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}">` +
    `<voice name="${voice}">${open}${body}${close}</voice></speak>`
  );
}

/** All act styles, re-exported for the Voice Lab and tests. */
export const ACT_STYLES = SPEECH_ACTS;
