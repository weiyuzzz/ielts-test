/**
 * Lip-sync core types — shared by the server (timeline generation) and the
 * client (sampling / rendering).
 *
 * A VisemeTrack is produced from TEXT (phonemes + duration tables) on the
 * server, travels to the client as relative time, and is warped onto the real
 * audio clock before sampling (see timeline.ts). Nothing in here knows about
 * Three.js or any TTS vendor: a track is just data.
 */

/**
 * Canonical viseme set. Chosen to match the Oculus LipSync (viseme_*) morph
 * targets that Ready Player Me / AvatarSDK / Avaturn models ship, so the
 * default mapping is an identity map; other models get a conversion table.
 * The spec's names map onto these: M_B_P→PP, F_V→FF, W_Q→ou, A→aa, E→E,
 * I→ih, O→oh, U→ou, L→DD, S_Z→SS, closed→PP, open→aa, silence→sil.
 */
export type Viseme =
  | "sil"
  | "PP"
  | "FF"
  | "TH"
  | "DD"
  | "kk"
  | "CH"
  | "SS"
  | "nn"
  | "RR"
  | "aa"
  | "E"
  | "ih"
  | "oh"
  | "ou";

/** Channel order used by the Float32Array sampling API (index-safe, no Map in the RAF loop). */
export const VISEME_CHANNELS: readonly Viseme[] = [
  "sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS", "nn", "RR", "aa", "E", "ih", "oh", "ou",
];

const VISEME_INDEX: Record<Viseme, number> = VISEME_CHANNELS.reduce(
  (acc, v, i) => { acc[v] = i; return acc; },
  {} as Record<Viseme, number>,
);

export function visemeIndex(v: Viseme): number {
  return VISEME_INDEX[v];
}

/** One viseme on a timeline. All times are seconds on the track's own clock. */
export interface VisemeFrame {
  /** Start time (seconds). */
  t: number;
  /** Duration (seconds). */
  d: number;
  viseme: Viseme;
  /** 0..1 expression strength (stress / emphasis), drives blendshape weight. */
  intensity: number;
  /** Index into VisemeTrack.words (-1 when not word-segmented). */
  wordIndex: number;
}

/** A word's extent on the track's clock (used for word-anchored warping). */
export interface WordSpan {
  word: string;
  start: number;
  end: number;
  index: number;
}

/**
 * Data quality of a track — honest labelling required by the spec:
 *  - "anchored": at least word-level times measured by the actual engine
 *    (Kokoro word timestamps / browser boundary events) or real viseme events.
 *  - "normalized": text-derived phonemes scaled to the real audio duration.
 *  - "rms": no content data at all; energy-only fallback.
 */
export type TrackTier = "anchored" | "normalized" | "rms";

/** A full utterance track in relative time (before warping to the audio clock). */
export interface VisemeTrack {
  frames: VisemeFrame[];
  words: WordSpan[];
  /** Sum of frame durations incl. pauses (seconds). */
  duration: number;
  tier: TrackTier;
  /** Language used for phonemization ("en-GB" style). */
  lang: string;
  /** The exact text this track was built from (cache identity + debug). */
  text: string;
  /** How the phonemes were obtained (debug/metrics). */
  source: "misaki" | "letters" | "engine";
}

/** A track that has been warped onto a real audio element's clock. */
export interface WarpedTrack extends VisemeTrack {
  /** Real playback duration the frames were warped to (seconds). */
  realDuration: number;
  /** Word spans in REAL audio time (null when only the global scale applied). */
  realWords: WordSpan[] | null;
}

export const isViseme = (v: string): v is Viseme => VISEME_CHANNELS.includes(v as Viseme);
