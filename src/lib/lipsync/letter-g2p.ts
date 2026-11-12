/**
 * Letter-driven fallback G2P (client + server safe, no data files).
 *
 * Used when the misaki phonemizer is unreachable. It is deliberately compact
 * and honest: consonant visemes come from letters, vowels from an alternating
 * syllable cycle. This is an APPROXIMATION — a track built from it is always
 * tier "normalized" and the UI may label it as such. It exists so the mouth
 * still follows the rhythm and closure pattern of the sentence instead of
 * pretending phoneme-grade accuracy (spec: no fake precision).
 */
import type { Viseme } from "./types";

/** Rules tried at the current position, longest first. "" = skip (silent). */
const DIGRAPH_RULES: ReadonlyArray<readonly [RegExp, Viseme | ""]> = [
  [/^t?ch/i, "CH"], [/^sh/i, "CH"], [/^(?:ci|ti|si)(?=on|ous)/i, "CH"], [/^sion/i, "CH"],
  [/^th/i, "TH"], [/^ph/i, "FF"], [/^gh(?=t|[aeiou])/i, ""], [/^wh/i, "ou"],
  [/^qu/i, "kk"], [/^ck/i, "kk"], [/^kn/i, "nn"], [/^ng/i, "nn"], [/^nk/i, "kk"],
  [/^wr/i, "RR"], [/^ps/i, "SS"], [/^x/i, "kk"],
];

const SINGLE_LETTERS: Readonly<Record<string, Viseme | "">> = {
  p: "PP", b: "PP", m: "PP",
  f: "FF", v: "FF",
  t: "DD", d: "DD", n: "nn", l: "DD",
  s: "SS", z: "SS", c: "kk", k: "kk", g: "kk", j: "CH", x: "kk", q: "kk",
  y: "ih", w: "ou", h: "aa", r: "RR",
};

const VOWEL_CYCLE: Viseme[] = ["aa", "E", "ih", "oh"];

/**
 * Produce "#viseme" symbols for a word. Vowel groups (ea, oo, …) count as one
 * beat each, so syllable rhythm roughly survives.
 */
export function tokenizeFromLetters(word: string): string[] {
  const out: string[] = [];
  let w = word.toLowerCase();
  let vowelSlot = 0;
  while (w.length) {
    let matched = false;
    for (const [re, vis] of DIGRAPH_RULES) {
      const m = w.match(re);
      if (m) {
        if (vis) out.push(`#${vis}`);
        w = w.slice(m[0].length);
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const ch = w[0];
    if ("aeiou".includes(ch)) {
      let i = 1;
      while (i < w.length && "aeiou".includes(w[i])) i++;
      out.push(`#${VOWEL_CYCLE[vowelSlot++ % VOWEL_CYCLE.length]}`);
      w = w.slice(i);
      continue;
    }
    if (/[a-z]/.test(ch)) {
      const v = SINGLE_LETTERS[ch];
      if (v) out.push(`#${v}`);
    }
    w = w.slice(1);
  }
  return out.length ? out : ["#aa"];
}

/** Rough syllable estimate for pacing checks / tests. */
export function estimateSyllables(word: string): number {
  const groups = word.toLowerCase().match(/[aeiouy]+/g);
  let n = groups ? groups.length : 1;
  if (/e$/i.test(word) && n > 1) n--;
  return Math.max(1, n);
}
