/**
 * Server-side grapheme-to-phoneme for lip-sync timelines.
 *
 * Primary: Kokoro's misaki phonemizer (`/dev/phonemize` on the same container
 * that already synthesizes this platform's local TTS). It returns an
 * English (en-GB capable) phoneme string, space-separated per word, with
 * stress marks — exactly what buildRelativeTrack() consumes.
 *
 * Fallback: the letter-driven approximator (letter-g2p.ts), so a timeline is
 * ALWAYS produced and its tier reflects reality. The phonemizer call is
 * bounded and cached; if the container is down, TTS itself is likely down too
 * and playback falls back to the browser voice anyway.
 */
import type { PhonemeWord } from "./timeline";
import { buildRelativeTrack, type BuildTrackOptions } from "./timeline";
import type { VisemeTrack } from "./types";

export const G2P_TIMEOUT_MS = 4_000;

function g2pBaseUrl(): string {
  // Same container as the OpenAI-compatible Kokoro engine (TTS_BASE_URL), or a
  // dedicated override for the phonemizer. The /dev endpoints live at the
  // container ROOT, so a /v1-style base must be stripped first.
  const base = process.env.KOKORO_G2P_URL || process.env.TTS_BASE_URL || "http://localhost:8880";
  return base.replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

const phonemeCache = new Map<string, string | null>();
const PHONEME_CACHE_MAX = 500;

/** Internal JSON parse guard: only accept well-formed strings. */
function extractPhonemes(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = (payload as { phonemes?: unknown }).phonemes;
  return typeof p === "string" && p.length ? p : null;
}

/**
 * Phonemize one text via misaki. Returns null when unavailable (never throws).
 * `lang`: misaki language code ("a" = en-US, "b" = en-GB).
 */
export async function phonemizeText(text: string, lang: "a" | "b" = "b"): Promise<string | null> {
  const key = `${lang}\u0000${text}`;
  if (phonemeCache.has(key)) return phonemeCache.get(key) ?? null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), G2P_TIMEOUT_MS);
    const res = await fetch(`${g2pBaseUrl()}/dev/phonemize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, language: lang }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) throw new Error(`phonemize ${res.status}`);
    const out = extractPhonemes(await res.json());
    if (phonemeCache.size >= PHONEME_CACHE_MAX) {
      const oldest = phonemeCache.keys().next().value;
      if (oldest !== undefined) phonemeCache.delete(oldest);
    }
    phonemeCache.set(key, out);
    return out;
  } catch {
    phonemeCache.set(key, null);
    return null;
  }
}

/** Split a misaki phoneme string into per-word tokens (spaces separate words). */
export function splitPhonemeWords(phonemes: string): string[] {
  return phonemes.split(/\s+/).filter((s) => s.length > 0);
}

/**
 * Word-aligned phonemes for a text. Falls back to letter-driven entries
 * (phonemes: "") when the engine is unavailable or its tokenization does not
 * line up with the source words 1:1 — word segmentation matters more for
 * warping than phoneme fidelity, so alignment is the hard requirement.
 */
export async function phonemizeWords(text: string, lang: "a" | "b" = "b"): Promise<PhonemeWord[]> {
  const words = text.split(/\s+/).filter(Boolean).map((w) => w.trim());
  if (!words.length) return [];
  const phonemes = await phonemizeText(text, lang);
  if (!phonemes) return words.map((w) => ({ word: w, phonemes: "" }));
  const tokens = splitPhonemeWords(phonemes);
  if (tokens.length !== words.length) return words.map((w) => ({ word: w, phonemes: "" }));
  return words.map((w, i) => ({ word: w, phonemes: tokens[i] }));
}

/** Build a complete relative-time track for a text (G2P included). */
export async function buildTrackForText(
  text: string,
  opts: BuildTrackOptions & { lang?: "a" | "b" } = {},
): Promise<VisemeTrack> {
  const langCode = opts.lang ?? "b";
  const words = await phonemizeWords(text, langCode);
  const anyMisaki = words.some((w) => w.phonemes);
  return buildRelativeTrack(words, {
    ...opts,
    tier: anyMisaki ? opts.tier ?? "normalized" : "normalized",
    source: anyMisaki ? "misaki" : "letters",
  });
}

/** Test hook: clear the module cache. */
export function clearG2pCache(): void {
  phonemeCache.clear();
}
