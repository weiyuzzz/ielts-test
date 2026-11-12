/**
 * Examiner avatar model registry.
 *
 * The examiner's visual identity is a separate dimension from the voice: both
 * examiners are semi-realistic GLB humanoids whose meshes carry the Oculus
 * 15-viseme morph targets (viseme_aa … viseme_sil) plus ARKit-style blink and
 * brow shapes — verified per model at build time. Models are served from this
 * origin (/public/avatar) so no third-party CDN is touched during an exam.
 *
 * Swapping a model (better likeness, compression, a future VRM) is a data
 * change: keep the file, or point `modelUrl` at another GLB with the same
 * morph-target family. The renderer degrades gracefully to the 2D SVG avatar
 * when a model cannot be loaded or WebGL is unavailable.
 */

export type ExaminerGender = "male" | "female";

export interface ExaminerModel {
  gender: ExaminerGender;
  /** Relative URL served from this origin. */
  modelUrl: string;
  /** Human name shown under the avatar in practice modes. */
  displayName: string;
  /** Morph-target family the model was verified to ship. */
  morphFamily: "oculus15";
}

export const EXAMINER_MODELS: Record<ExaminerGender, ExaminerModel> = {
  female: { gender: "female", modelUrl: "/avatar/female.glb", displayName: "Sarah", morphFamily: "oculus15" },
  male: { gender: "male", modelUrl: "/avatar/male.glb", displayName: "James", morphFamily: "oculus15" },
};

export const DEFAULT_EXAMINER_GENDER: ExaminerGender = "female";

export function normalizeGender(v: unknown): ExaminerGender {
  return v === "male" ? "male" : v === "female" ? "female" : DEFAULT_EXAMINER_GENDER;
}

/**
 * Oculus viseme → canonical Viseme. Our canonical set IS the Oculus set, so
 * this is an identity map kept explicit for clarity and future model families.
 */
export const OCULUS_TO_VISEME: Readonly<Record<string, string>> = {
  viseme_sil: "sil",
  viseme_PP: "PP",
  viseme_FF: "FF",
  viseme_TH: "TH",
  viseme_DD: "DD",
  viseme_kk: "kk",
  viseme_CH: "CH",
  viseme_SS: "SS",
  viseme_nn: "nn",
  viseme_RR: "RR",
  viseme_aa: "aa",
  viseme_E: "E",
  viseme_I: "ih",
  viseme_O: "oh",
  viseme_U: "ou",
};

/** Warm the HTTP cache so the exam never waits on a model download. */
export function preloadExaminerModel(gender: ExaminerGender): void {
  if (typeof window === "undefined") return;
  const url = EXAMINER_MODELS[gender].modelUrl;
  try { void fetch(url, { cache: "force-cache" }).catch(() => {}); } catch { /* ignore */ }
}
