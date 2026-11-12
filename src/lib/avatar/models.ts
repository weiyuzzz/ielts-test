/**
 * Examiner avatar model registry.
 *
 * The examiner's visual identity is a separate dimension from the voice: every
 * model is a semi-realistic GLB humanoid carrying the Oculus 15-viseme morph
 * targets (viseme_aa … viseme_sil) plus ARKit-style blink and brow shapes.
 * Five examiners per gender (distinct hair colour for the women, distinct suit
 * colour for the men) are served from this origin (/public/avatar) so no
 * third-party CDN is touched during an exam.
 *
 * Swapping a model (better likeness, compression, a future VRM) is a data
 * change: keep the file, or point `modelUrl` at another GLB with the same
 * morph-target family. The renderer degrades gracefully to the 2D SVG avatar
 * when a model cannot be loaded or WebGL is unavailable.
 */

export type ExaminerGender = "male" | "female";

export interface ExaminerModel {
  /** Stable id stored in user settings and frozen into the exam session. */
  id: string;
  gender: ExaminerGender;
  /** Relative URL served from this origin. */
  modelUrl: string;
  /** The examiner's name — bound to the model so look, name and voice stay one person. */
  displayName: string;
  /** Morph-target family the model was verified to ship. */
  morphFamily: "oculus15";
}

export const EXAMINER_MODELS: ExaminerModel[] = [
  // ---- female (Avaturn base, fair skin, distinct hair colours)
  { id: "f1", gender: "female", modelUrl: "/avatar/f1.glb", displayName: "Sarah", morphFamily: "oculus15" },
  { id: "f2", gender: "female", modelUrl: "/avatar/f2.glb", displayName: "Emma", morphFamily: "oculus15" },
  { id: "f3", gender: "female", modelUrl: "/avatar/f3.glb", displayName: "Charlotte", morphFamily: "oculus15" },
  { id: "f4", gender: "female", modelUrl: "/avatar/f4.glb", displayName: "Olivia", morphFamily: "oculus15" },
  { id: "f5", gender: "female", modelUrl: "/avatar/f5.glb", displayName: "Sophie", morphFamily: "oculus15" },
  // ---- male (AvatarSDK base, distinct suit colours)
  { id: "m1", gender: "male", modelUrl: "/avatar/m1.glb", displayName: "James", morphFamily: "oculus15" },
  { id: "m2", gender: "male", modelUrl: "/avatar/m2.glb", displayName: "Daniel", morphFamily: "oculus15" },
  { id: "m3", gender: "male", modelUrl: "/avatar/m3.glb", displayName: "Oliver", morphFamily: "oculus15" },
  { id: "m4", gender: "male", modelUrl: "/avatar/m4.glb", displayName: "Henry", morphFamily: "oculus15" },
  { id: "m5", gender: "male", modelUrl: "/avatar/m5.glb", displayName: "Thomas", morphFamily: "oculus15" },
];

export const DEFAULT_EXAMINER_GENDER: ExaminerGender = "female";
export const DEFAULT_MODEL_BY_GENDER: Record<ExaminerGender, string> = { female: "f1", male: "m1" };

export function normalizeGender(v: unknown): ExaminerGender {
  return v === "male" ? "male" : v === "female" ? "female" : DEFAULT_EXAMINER_GENDER;
}

/** Keep only ids that exist AND belong to the given gender; fall back to the gender default. */
export function normalizeModelId(v: unknown, gender: ExaminerGender): string {
  const id = typeof v === "string" ? v : "";
  const found = EXAMINER_MODELS.find((m) => m.id === id && m.gender === gender);
  return found ? found.id : DEFAULT_MODEL_BY_GENDER[gender];
}

export function examinerModelById(id: string): ExaminerModel | undefined {
  return EXAMINER_MODELS.find((m) => m.id === id);
}

export function examinerModelsForGender(gender: ExaminerGender): ExaminerModel[] {
  return EXAMINER_MODELS.filter((m) => m.gender === gender);
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
export function preloadExaminerModel(id: string): void {
  if (typeof window === "undefined") return;
  const model = examinerModelById(id);
  if (!model) return;
  try { void fetch(model.modelUrl, { cache: "force-cache" }).catch(() => {}); } catch { /* ignore */ }
}
