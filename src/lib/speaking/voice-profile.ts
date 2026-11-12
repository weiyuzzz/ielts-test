/**
 * VoiceProfile — the single description of "which examiner voice is speaking".
 *
 * A profile is provider-neutral: the same shape describes Azure, OpenAI,
 * Kokoro and the browser fallback. Provider-specific request building lives in
 * `providers.ts`; nothing else in the app needs to know vendor parameters.
 *
 * Three levels of configuration are kept separate on purpose:
 *   1. built-in presets + environment  → the default when nothing is chosen
 *   2. the user's saved preference      → `users.examiner_voice`
 *   3. the per-session snapshot         → frozen when the exam is created
 * A change to (2) must never alter an exam that is already running, which is
 * why the snapshot is written into the session's config.
 */

export type VoiceProviderId = "azure" | "openai" | "kokoro" | "browser";

export interface VoiceProsody {
  /** Pause between two statements (ms). */
  sentencePauseMs: number;
  /** Pause after a question, slightly longer so it reads as an invitation. */
  questionPauseMs: number;
  /** Pause at a comma / clause boundary (ms). */
  clausePauseMs: number;
  /** Subtle emphasis on the informative words of a line. */
  emphasisEnabled: boolean;
}

export interface VoiceProfile {
  id: string;
  name: string;
  provider: VoiceProviderId;
  voice: string;
  language: "en-GB";
  /** Base speaking rate, 1 = engine default. */
  speed: number;
  /** Optional pitch shift in semitones (−2…+2); ignored by engines without support. */
  pitch?: number;
  /** Azure expressive style name, when the voice supports it (never invented). */
  style?: string;
  /** Free-form steering text for engines that accept natural-language direction. */
  instructions?: string;
  prosody: VoiceProsody;
}

export const DEFAULT_PROSODY: VoiceProsody = {
  sentencePauseMs: 260,
  questionPauseMs: 480,
  clausePauseMs: 140,
  emphasisEnabled: true,
};

/** Clamp helpers keep malformed settings from reaching a provider. */
export const clampSpeed = (v: number) => Math.min(1.4, Math.max(0.6, Number.isFinite(v) ? v : 1));
export const clampPitch = (v: number) => Math.min(2, Math.max(-2, Number.isFinite(v) ? v : 0));

/**
 * Built-in presets. `id` is what the UI and the session snapshot store; the
 * voice names are the real engine identifiers, so a preset never guesses.
 */
export const VOICE_PRESETS: VoiceProfile[] = [
  {
    id: "azure-sonia",
    name: "Azure · Sonia (en-GB, female)",
    provider: "azure",
    voice: "en-GB-SoniaNeural",
    language: "en-GB",
    speed: 0.96,
    pitch: 0,
    prosody: { ...DEFAULT_PROSODY },
  },
  {
    id: "azure-ryan",
    name: "Azure · Ryan (en-GB, male)",
    provider: "azure",
    voice: "en-GB-RyanNeural",
    language: "en-GB",
    speed: 0.96,
    pitch: 0,
    prosody: { ...DEFAULT_PROSODY },
  },
  {
    id: "openai-marin",
    name: "OpenAI · Marin (expressive, en-GB leaning)",
    provider: "openai",
    voice: "marin",
    language: "en-GB",
    speed: 0.97,
    pitch: 0,
    prosody: { ...DEFAULT_PROSODY },
    instructions: "",
  },
  {
    id: "kokoro-af-heart",
    name: "Kokoro · af_heart (A-grade, local)",
    provider: "kokoro",
    voice: "af_heart",
    language: "en-GB",
    speed: 0.95,
    prosody: { ...DEFAULT_PROSODY },
  },
  {
    id: "browser-en-gb",
    name: "Browser voice (fallback only)",
    provider: "browser",
    voice: "auto",
    language: "en-GB",
    speed: 0.94,
    pitch: 1,
    prosody: { ...DEFAULT_PROSODY, emphasisEnabled: false },
  },
];

export const DEFAULT_PROFILE_ID = "azure-sonia";

export function presetById(id: string): VoiceProfile | undefined {
  return VOICE_PRESETS.find((p) => p.id === id);
}

/** Copy so a caller can never mutate a shared preset. */
function clone(p: VoiceProfile): VoiceProfile {
  return { ...p, prosody: { ...p.prosody } };
}

const AZURE_VOICE_RE = /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/;
const isAzureVoiceName = (s: string) => AZURE_VOICE_RE.test(s);

/**
 * Interpret a stored preference. Accepts, in order:
 *   "azure-sonia"                → preset id (current format)
 *   "azure:en-GB-SoniaNeural"    → explicit provider:voice
 *   "en-GB-SoniaNeural"          → bare Azure neural name (legacy)
 *   "af_heart" / "bf_emma"       → legacy Kokoro voice (pre-Phase-2 `examinerVoice`)
 *   "auto" / "" / unknown        → environment default, then Azure preset
 */
export function resolveVoiceProfile(pref?: string | null): VoiceProfile {
  const raw = (pref ?? "").trim();
  if (raw && raw !== "auto") {
    const preset = presetById(raw);
    if (preset) return clone(preset);

    if (raw.includes(":")) {
      const [head, ...rest] = raw.split(":");
      const voice = rest.join(":").trim();
      if (voice) {
        const provider = head.trim() as VoiceProviderId;
        if (provider === "azure" || provider === "openai" || provider === "kokoro" || provider === "browser") {
          const base = provider === "browser" ? presetById("browser-en-gb")! : provider === "azure" ? presetById("azure-sonia")! : provider === "kokoro" ? presetById("kokoro-af-heart")! : presetById("openai-marin")!;
          return { ...clone(base), id: `${provider}:${voice}`, voice, name: `${provider} · ${voice}` };
        }
      }
    }

    if (isAzureVoiceName(raw)) {
      const base = presetById("azure-sonia")!;
      return { ...clone(base), id: `azure:${raw}`, voice: raw, name: `Azure · ${raw}` };
    }

    // Legacy Kokoro voice names (af_heart, bf_emma, am_michael …) were the value
    // of `examinerVoice` before profiles existed — keep them working verbatim.
    if (/^[a-z]{2}_[a-z]+$/i.test(raw)) {
      const base = presetById("kokoro-af-heart")!;
      return { ...clone(base), id: `kokoro:${raw}`, voice: raw, name: `Kokoro · ${raw}` };
    }

    // Unknown but explicit voice → assume the configured server engine, keeping
    // the name so a custom engine can still be addressed.
    return { ...clone(envDefaultProfile()), id: `custom:${raw}`, voice: raw, name: `Custom · ${raw}` };
  }
  return envDefaultProfile();
}

/** Environment-selected default (TTS_PROVIDER / TTS_VOICE / TTS_SPEED), else the recommended preset. */
export function envDefaultProfile(): VoiceProfile {
  const provider = (process.env.TTS_PROVIDER || "").toLowerCase();
  const voice = process.env.TTS_VOICE || "";
  const withEnv = (p: VoiceProfile): VoiceProfile => {
    const speed = Number(process.env.TTS_SPEED);
    const pitch = Number(process.env.TTS_PITCH);
    return {
      ...p,
      speed: clampSpeed(Number.isFinite(speed) && speed > 0 ? speed : p.speed),
      pitch: clampPitch(Number.isFinite(pitch) ? pitch : p.pitch ?? 0),
    };
  };
  if (provider === "browser") return withEnv(clone(presetById("browser-en-gb")!));
  if (provider === "azure" || isAzureVoiceName(voice)) {
    const base = clone(presetById("azure-sonia")!);
    const v = voice || process.env.AZURE_TTS_VOICE || base.voice;
    const preset = VOICE_PRESETS.find((p) => p.provider === "azure" && p.voice === v);
    return withEnv(preset ? clone(preset) : { ...base, id: `azure:${v}`, voice: v, name: `Azure · ${v}` });
  }
  if (voice) {
    const preset = VOICE_PRESETS.find((p) => p.voice === voice);
    if (preset) return withEnv(clone(preset));
    const base = clone(presetById("kokoro-af-heart")!);
    return withEnv({ ...base, id: `kokoro:${voice}`, voice, name: `Kokoro · ${voice}` });
  }
  return withEnv(clone(presetById(DEFAULT_PROFILE_ID)!));
}

/**
 * Stable fingerprint of everything that changes the resulting waveform.
 * The TTS cache keys on this, so switching voice/speed/pitch/act can never
 * return a clip generated for a different configuration.
 */
export function profileFingerprint(p: VoiceProfile, speechAct: string, format: string): string {
  return [
    p.provider,
    p.voice,
    p.language,
    p.speed.toFixed(3),
    (p.pitch ?? 0).toFixed(2),
    p.style ?? "",
    p.instructions ?? "",
    `${p.prosody.sentencePauseMs}/${p.prosody.questionPauseMs}/${p.prosody.clausePauseMs}/${p.prosody.emphasisEnabled ? 1 : 0}`,
    speechAct,
    format,
  ].join("|");
}

/** Validate a profile arriving from a client (Voice Lab, session snapshot). */
export function sanitizeProfile(raw: unknown): VoiceProfile {
  const base = envDefaultProfile();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const provider = r.provider;
  const okProvider: VoiceProviderId = provider === "azure" || provider === "openai" || provider === "kokoro" || provider === "browser" ? provider : base.provider;
  const prosodyRaw = (r.prosody ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    id: typeof r.id === "string" && r.id ? r.id.slice(0, 80) : base.id,
    name: typeof r.name === "string" && r.name ? r.name.slice(0, 120) : base.name,
    provider: okProvider,
    voice: typeof r.voice === "string" && r.voice ? r.voice.slice(0, 80) : base.voice,
    language: "en-GB",
    speed: clampSpeed(num(r.speed, base.speed, 0.6, 1.4)),
    pitch: clampPitch(num(r.pitch, base.pitch ?? 0, -2, 2)),
    style: typeof r.style === "string" && r.style ? r.style.slice(0, 40) : undefined,
    instructions: typeof r.instructions === "string" ? r.instructions.slice(0, 600) : base.instructions,
    prosody: {
      sentencePauseMs: Math.round(num(prosodyRaw.sentencePauseMs, base.prosody.sentencePauseMs, 60, 900)),
      questionPauseMs: Math.round(num(prosodyRaw.questionPauseMs, base.prosody.questionPauseMs, 60, 1200)),
      clausePauseMs: Math.round(num(prosodyRaw.clausePauseMs, base.prosody.clausePauseMs, 0, 600)),
      emphasisEnabled: typeof prosodyRaw.emphasisEnabled === "boolean" ? prosodyRaw.emphasisEnabled : base.prosody.emphasisEnabled,
    },
  };
}
