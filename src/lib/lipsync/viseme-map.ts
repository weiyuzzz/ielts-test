/**
 * Phoneme → viseme mapping.
 *
 * `misakiToViseme` handles the phoneme alphabet that Kokoro's misaki G2P
 * produces for English (empirically verified against the local engine:
 * IPA vowels with ː, plus the special uppercase diphthong letters
 * A=eɪ, I=aɪ, Y=ɔɪ, W=aʊ, Q=oʊ). Diphthongs expand into TWO frames so the
 * mouth glides the way the vowel actually sounds.
 */
import type { Viseme } from "./types";

export interface VisemeStep {
  viseme: Viseme;
  /** Relative expression weight 0..1 (defaults to 1). */
  weight?: number;
  /** Share of the phoneme's duration (must sum to 1 across steps). */
  share: number;
}

const V = (viseme: Viseme, share = 1, weight = 1): VisemeStep => ({ viseme, share, weight });

/**
 * Longest-first phoneme table. Values are one or more viseme steps.
 * Relative base durations live in BASE_DURATION_MS.
 */
export const MISAKI_PHONEMES: Readonly<Record<string, VisemeStep[]>> = {
  // ---- vowels: monophthongs
  "iː": [V("ih")],
  "i": [V("ih", 1, 0.9)],
  "ɪ": [V("ih", 1, 0.8)],
  "ɛ": [V("E")],
  "a": [V("aa")],
  "æ": [V("aa")],
  "ʌ": [V("aa", 1, 0.85)],
  "ɑː": [V("aa")],
  "ɒ": [V("aa", 1, 0.9)],
  "ʊ": [V("ou", 1, 0.7)],
  "uː": [V("ou")],
  "u": [V("ou", 1, 0.9)],
  "Q": [V("oh")], // GOAT
  "ɔː": [V("oh")], // THOUGHT
  "ɜː": [V("E", 1, 0.75)], // NURSE
  "ə": [V("E", 1, 0.45)], // schwa — barely open
  "ɪə": [V("ih", 0.6), V("E", 0.4, 0.6)], // NEAR
  "ɛː": [V("E")], // SQUARE
  "ʊə": [V("ou", 0.6, 0.7), V("E", 0.4, 0.5)], // CURE
  // ---- diphthongs (glide = two frames)
  "A": [V("E", 0.55), V("ih", 0.45, 0.8)], // FACE eɪ
  "I": [V("aa", 0.5, 0.9), V("ih", 0.5)], // PRICE aɪ
  "Y": [V("oh", 0.5, 0.9), V("ih", 0.5)], // CHOICE ɔɪ
  "W": [V("aa", 0.5, 0.9), V("ou", 0.5)], // MOUTH aʊ
  // ---- consonants
  "p": [V("PP", 0.7), V("aa", 0.3, 0.35)], // closure + burst
  "b": [V("PP", 0.7), V("aa", 0.3, 0.35)],
  "m": [V("PP")],
  "f": [V("FF")],
  "v": [V("FF")],
  "θ": [V("TH")],
  "ð": [V("TH")],
  "t": [V("DD", 0.65), V("E", 0.35, 0.35)],
  "d": [V("DD", 0.65), V("E", 0.35, 0.35)],
  "n": [V("nn")],
  "ŋ": [V("nn")],
  "l": [V("DD")],
  "s": [V("SS")],
  "z": [V("SS")],
  "ʃ": [V("CH")],
  "ʒ": [V("CH")],
  "ʧ": [V("CH", 0.65), V("E", 0.35, 0.4)],
  "ʤ": [V("CH", 0.65), V("E", 0.35, 0.4)],
  "k": [V("kk", 0.6), V("E", 0.4, 0.4)],
  "ɡ": [V("kk", 0.6), V("E", 0.4, 0.4)],
  "g": [V("kk", 0.6), V("E", 0.4, 0.4)],
  "kh": [V("kk")],
  "h": [V("aa", 1, 0.4)], // breathy open
  "ɹ": [V("RR")],
  "r": [V("RR")],
  "j": [V("ih", 1, 0.7)],
  "w": [V("ou", 1, 0.7)],
};

/** Relative base durations (ms) per viseme, before stress/prosody scaling. */
export const BASE_DURATION_MS: Readonly<Record<Viseme, number>> = {
  sil: 90,
  PP: 95,
  FF: 95,
  TH: 80,
  DD: 75,
  kk: 80,
  CH: 105,
  SS: 100,
  nn: 80,
  RR: 70,
  aa: 130,
  E: 110,
  ih: 100,
  oh: 125,
  ou: 115,
};

/** Vowel visemes — used for jaw-openness blending and syllable pacing. */
export const VOWEL_VISUMES: ReadonlySet<Viseme> = new Set<Viseme>(["aa", "E", "ih", "oh", "ou"]);

/** Extra pause (ms) attached to punctuation that ends a word token. */
export function punctuationPauseMs(token: string): number {
  if (/[.!?…]["”')\]]*$/u.test(token)) return 300;
  if (/[,;:—–]["”')\]]*$/u.test(token)) return 180;
  return 0;
}

/** Split a misaki phoneme token (one word) into phoneme symbols, longest-first. */
export function tokenizeMisaki(token: string): string[] {
  const keys = Object.keys(MISAKI_PHONEMES).sort((a, b) => b.length - a.length);
  const stressMarks = new Set(["ˈ", "ˌ", "ᵊ", "̋"]);
  const out: string[] = [];
  let s = token.normalize("NFC");
  for (let i = 0; i < s.length; ) {
    const ch = s[i];
    if (stressMarks.has(ch) || /\s/.test(ch)) { i++; continue; }
    let matched = "";
    for (const k of keys) {
      if (s.startsWith(k, i)) { matched = k; break; }
    }
    if (matched) { out.push(matched); i += matched.length; continue; }
    // Unknown symbol: treat as a brief neutral schwa so timing stays sane.
    out.push("?");
    i += ch.length === 2 && s.charCodeAt(i) > 0xff ? 2 : 1;
  }
  return out;
}
