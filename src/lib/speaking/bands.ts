export const DIMENSIONS = ["FC", "LR", "GRA", "P"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<Dimension, string> = {
  FC: "Fluency & Coherence",
  LR: "Lexical Resource",
  GRA: "Grammatical Range & Accuracy",
  P: "Pronunciation",
};

export function clampBand(b: number): number {
  return Math.min(9, Math.max(0, b));
}

/** Round a criterion score to whole or half band. */
export function toHalfBand(b: number): number {
  return Math.round(clampBand(b) * 2) / 2;
}

/**
 * IELTS overall rounding: mean of criteria; .25 rounds up to .5, .75 rounds up to the next whole band.
 * Returns null if no criteria are available.
 */
export function overallBand(bands: (number | null | undefined)[]): number | null {
  const v = bands.filter((b): b is number => typeof b === "number" && Number.isFinite(b));
  if (!v.length) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const whole = Math.floor(mean);
  const frac = mean - whole;
  const eps = 1e-9;
  if (frac + eps >= 0.75) return whole + 1;
  if (frac + eps >= 0.25) return whole + 0.5;
  return whole;
}

/** Map a 0–100 speech-assessment score to an approximate IELTS band (documented approximation). */
export function score100ToBand(s: number): number {
  const table: [number, number][] = [
    [95, 9], [90, 8.5], [85, 8], [80, 7.5], [74, 7], [68, 6.5], [62, 6], [55, 5.5], [48, 5], [40, 4.5], [32, 4], [0, 3],
  ];
  for (const [min, band] of table) if (s >= min) return band;
  return 3;
}
