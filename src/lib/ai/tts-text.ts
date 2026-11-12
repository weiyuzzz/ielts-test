/**
 * Text front-end for the examiner voice (pure functions, unit-tested).
 *
 * A TTS engine reading one long flat string produces a flat, "robotic" delivery:
 * every clause gets the same rhythm and there is no breath between sentences.
 * We split the line into sentences and insert short, human-length pauses. Engines
 * that understand SSML (Kokoro-compatible, Azure) get real <break> tags; engines
 * that do not get lightly normalised plain text.
 */

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
 * medium = 500 ms. A question gets a slightly longer pause, as in a real test.
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
