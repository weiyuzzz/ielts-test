/**
 * Unified diagnostics contract (shared by the server probes and the Settings UI).
 *
 * Every probe — server-side (DB / storage / TTS / LLM / pronunciation / ASR) and
 * browser-side (microphone / WebGL / GLB) — returns the SAME `DiagnosticItem`
 * shape, so the UI renders one list with one status vocabulary:
 *
 *   ready          the check ran and everything works
 *   degraded       usable, but with a real limitation (slow, fallback voice, low FPS)
 *   failed         the check ran and it is broken
 *   not_configured the feature is legitimately off (no key / no provider) — NOT a failure
 *   not_tested     the check has not run yet in this session
 *   disabled       the user switched the feature off (e.g. the 3D digital human)
 *
 * Pure helpers (classifyLLMFailure / computeReadiness) live here so they are
 * unit-testable without a server or a browser (see tests/diagnostics.test.ts).
 */

export type DiagnosticStatus =
  | "ready"
  | "degraded"
  | "failed"
  | "not_configured"
  | "not_tested"
  | "disabled";

export type DiagnosticGroup =
  | "application"
  | "speech"
  | "ai"
  | "pronunciation"
  | "digital-human";

export type DiagnosticScope = "browser" | "server" | "provider";

export interface DiagnosticRepairAction {
  id: string;
  label: string;
  description: string;
  /** false → show the description as guidance only (e.g. "restart Kokoro via NSSM"). */
  available: boolean;
  /** Optional in-app target (e.g. "/admin" for the AI config panel). */
  href?: string;
}

export interface DiagnosticItem {
  id: string;
  group: DiagnosticGroup;
  name: string;
  scope: DiagnosticScope;
  status: DiagnosticStatus;
  /** false → informational; the exam can proceed without it. */
  required: boolean;
  message: string;
  detail?: string;
  latencyMs?: number;
  testedAt?: string;
  /** Actual provider / model involved (never a secret). */
  provider?: string | null;
  model?: string | null;
  repairActions?: DiagnosticRepairAction[];
}

/** One externally-managed engine (Kokoro) the OS supervisor owns, not this app. */
export interface ManagedServiceStatus {
  id: string;
  label: string;
  /** "nssm" | "launchd" | null — null when no supervisor is configured. */
  manager: string | null;
  /** True only when a real, whitelisted restart command exists for this host. */
  restartable: boolean;
  healthUrl: string | null;
  /** The fixed restart command (display/audit only; never built from user input). */
  command?: string | null;
  /** null = not probed yet. */
  healthy: boolean | null;
  detail: string;
  latencyMs?: number;
}

export interface DiagnosticsCapabilitySnapshot {
  tts: { id: string; model: string | null; location: string; format: string; streaming: boolean };
  asr: { id: string; model: string | null; location: string } | null;
  llm: { id: string; model: string | null } | null;
  pronunciation: { id: string } | null;
  examinerVoice: string;
}

export interface ServerDiagnosticsResponse {
  items: DiagnosticItem[];
  services: ManagedServiceStatus[];
  config: DiagnosticsCapabilitySnapshot;
}

/** Payload of POST /api/diagnostics — which server probes to (re)run. */
export interface DiagnosticsRunRequest {
  checks?: string[];
}

export interface AsrDiagnosticResponse {
  status: DiagnosticStatus;
  provider: string | null;
  model: string | null;
  message: string;
  detail?: string;
  text?: string;
  latencyMs?: number;
  /** Where the test audio went — the UI must disclose third-party upload. */
  uploadedTo: string | null;
}

export interface PronunciationDiagnosticResponse {
  status: DiagnosticStatus;
  provider: string | null;
  message: string;
  detail?: string;
  latencyMs?: number;
  metrics?: {
    accuracy: number;
    fluency: number;
    prosody?: number;
    completeness?: number;
    overall: number;
  };
  words?: { word: string; accuracy: number; errorType?: string }[];
  formatOk?: boolean;
  formatDetail?: string;
  /** Which third-party service received the audio (disclosure for the UI). */
  uploadedProvider?: string | null;
}

export interface ServiceRestartResponse {
  ok: boolean;
  /** "restarted" = command ran AND the engine answers again. Never faked. */
  phase: "restarted" | "warming-up" | "unavailable";
  detail: string;
}

// ------------------------------------------------------------------ readiness

export interface ReadinessSummary {
  /** Recording can proceed: DB + bank + mic + an examiner voice that actually plays. */
  examReady: boolean;
  /** Official band scoring possible: LLM + ASR + readable audio storage. */
  scoringReady: boolean;
  /** FC/LR/GRA + P all scoreable. */
  completeBandReady: boolean;
  /** 3D digital human enabled AND (WebGL + model + render) healthy. */
  digitalHumanReady: boolean;
  /** "fix-first" | "3d" | "2d" */
  recommendedMode: "fix-first" | "3d" | "2d";
  notes: string[];
}

/** Stable item ids the readiness computation and the UI both rely on. */
export const DIAGNOSTIC_IDS = {
  appApi: "app.api",
  appDb: "app.db",
  appSession: "app.session",
  appBank: "app.bank",
  appStorage: "app.storage",
  ttsConfig: "tts.config",
  ttsSynth: "tts.synth",
  ttsAudition: "tts.audition",
  llmProbe: "llm.probe",
  asrConfig: "asr.config",
  asrTranscribe: "asr.transcribe",
  pronConfig: "pron.config",
  pronAssess: "pron.assess",
  browserEnvironment: "browser.environment",
  browserMicrophone: "browser.microphone",
  browserRecorder: "browser.recorder",
  browserAudioContext: "browser.audio-context",
  browserRecordPlayback: "browser.record-playback",
  browserWebSpeech: "browser.webspeech",
  gpuWebgl: "gpu.webgl",
  gpuThree: "gpu.three",
  gpuModelDownload: "gpu.model-download",
  gpuModelRender: "gpu.model-render",
} as const;

const ok = (s: DiagnosticStatus) => s === "ready" || s === "degraded";
const find = (items: DiagnosticItem[], id: string) => items.find((i) => i.id === id);

/**
 * Derive the four capability flags from a full item list (server + browser items
 * merged). Pure so the UI and the tests agree on the semantics.
 *
 * `deploymentTtsLocation` is the ACTIVE examiner-voice source the exam will use
 * ("server" | "browser") — the exam never switches voice mid-test, so readiness
 * follows the deployment, not whichever provider happens to exist.
 */
export function computeReadiness(
  items: DiagnosticItem[],
  opts: { digitalHuman3d: boolean; deploymentTtsLocation: "server" | "browser" },
): ReadinessSummary {
  const notes: string[] = [];
  const st = (id: string) => find(items, id)?.status ?? "not_tested";

  const dbOk = ok(st(DIAGNOSTIC_IDS.appDb));
  const bankOk = ok(st(DIAGNOSTIC_IDS.appBank));
  const sessionOk = ok(st(DIAGNOSTIC_IDS.appSession));
  // The exam runs a MANDATORY mic check (MicCheck) before the first question,
  // so recording capability is verified there regardless of this page. Here the
  // browser environment check is sufficient — a never-run recording test must
  // not keep the readiness pill permanently amber.
  const micOk = ok(st(DIAGNOSTIC_IDS.browserEnvironment))
    || ok(st(DIAGNOSTIC_IDS.browserRecordPlayback))
    || (ok(st(DIAGNOSTIC_IDS.browserMicrophone)) && ok(st(DIAGNOSTIC_IDS.browserRecorder)));
  const serverVoiceOk = ok(st(DIAGNOSTIC_IDS.ttsSynth));
  const browserVoiceOk = ok(st(DIAGNOSTIC_IDS.ttsAudition));
  const voiceOk = opts.deploymentTtsLocation === "server" ? serverVoiceOk : browserVoiceOk || serverVoiceOk;

  const examReady = dbOk && bankOk && sessionOk && micOk && voiceOk;
  if (!voiceOk) {
    notes.push(opts.deploymentTtsLocation === "server"
      ? "The examiner voice engine is not answering — questions can be read on screen, but spoken audio is unavailable."
      : "This browser cannot play the built-in examiner voice — check audio output.");
  }
  if (!micOk) {
    notes.push("This browser cannot run the exam recording environment (secure context / microphone API) — see the Application & Database checks.");
  }

  const llmSt = st(DIAGNOSTIC_IDS.llmProbe);
  const webSpeechSt = st(DIAGNOSTIC_IDS.browserWebSpeech);
  const storageOk = ok(st(DIAGNOSTIC_IDS.appStorage));
  // Config-level readiness: a configured provider counts even when the live
  // audio upload probe has not run (it needs a user recording, which lives in
  // the exam's own mic check). A running transcription probe still wins.
  const asrOk = ok(st(DIAGNOSTIC_IDS.asrConfig)) || ok(st(DIAGNOSTIC_IDS.asrTranscribe)) || ok(webSpeechSt);
  const llmOk = ok(llmSt);

  const scoringReady = llmOk && asrOk && storageOk;
  if (llmSt === "not_configured") {
    notes.push("No scoring LLM is configured: the exam completes and recordings are kept, but it will be marked unscored (no band is fabricated).");
  } else if (!llmOk) {
    notes.push("The scoring LLM is unavailable — you can still record the exam, but this run may not receive an official band.");
  }
  if (!asrOk && ok(webSpeechSt)) notes.push("Server ASR is unavailable; browser speech recognition will transcribe instead.");

  // Configured provider counts (see asrOk); a live assessment probe wins when present.
  const pronOk = ok(st(DIAGNOSTIC_IDS.pronConfig)) || ok(st(DIAGNOSTIC_IDS.pronAssess));
  const completeBandReady = scoringReady && pronOk;
  if (!pronOk) {
    notes.push(st(DIAGNOSTIC_IDS.pronConfig) === "not_configured"
      ? "Pronunciation (P) is not configured — FC/LR/GRA still score, but P is not assessed and the Overall band is omitted."
      : "The pronunciation provider is failing — P will not be assessed this run.");
  }

  const digitalHumanReady = opts.digitalHuman3d
    && ok(st(DIAGNOSTIC_IDS.gpuWebgl))
    && st(DIAGNOSTIC_IDS.gpuModelRender) === "ready";

  let recommendedMode: ReadinessSummary["recommendedMode"] = "3d";
  if (!examReady) recommendedMode = "fix-first";
  else if (!digitalHumanReady) recommendedMode = "2d";
  if (recommendedMode === "2d" && opts.digitalHuman3d) {
    notes.push("The 3D examiner did not pass every check — the lightweight 2D examiner is recommended (you can switch it off in the Examiner section).");
  }
  if (st(DIAGNOSTIC_IDS.gpuModelRender) === "degraded") {
    notes.push("The 3D examiner renders, but performance is low — the 2D examiner will feel smoother during the exam.");
  }

  return { examReady, scoringReady, completeBandReady, digitalHumanReady, recommendedMode, notes };
}

// ------------------------------------------------------------------ error classification

export type ProviderFailureKind =
  | "not_configured"
  | "key_invalid"
  | "model_unavailable"
  | "rate_limited"
  | "timeout"
  | "invalid_format"
  | "failed";

/**
 * Map any provider error to a diagnostic status + a stable kind, WITHOUT
 * leaking credentials. Message text is truncated and keys are never included.
 */
export function classifyProviderFailure(provider: string, e: unknown): { status: DiagnosticStatus; kind: ProviderFailureKind; message: string } {
  if (e instanceof Error) {
    const msg = e.message.replace(/\b(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, "$1…").slice(0, 300);
    const code = (e as { code?: string }).code;
    if (code === "config" || /not configured|missing (api )?key/i.test(msg)) return { status: "not_configured", kind: "not_configured", message: msg };
    if (code === "timeout") return { status: "failed", kind: "timeout", message: msg };
    if (code === "invalid_response") return { status: "failed", kind: "invalid_format", message: msg };
    if (code === "http") {
      const m = /(\d{3})/.exec(msg);
      const status = m ? Number(m[1]) : 0;
      if (status === 401 || status === 403) return { status: "failed", kind: "key_invalid", message: msg };
      if (status === 429) return { status: "failed", kind: "rate_limited", message: msg };
      if (status === 404 || status === 400) return { status: "failed", kind: "model_unavailable", message: msg };
      if (status >= 500) return { status: "degraded", kind: "failed", message: msg };
      return { status: "failed", kind: "failed", message: msg };
    }
    return { status: "failed", kind: "failed", message: msg };
  }
  return { status: "failed", kind: "failed", message: `${provider} probe failed` };
}

/** Minimal WAV header probe — verifies 16 kHz mono 16-bit PCM without decoding. */
export function inspectWavHeader(buf: Uint8Array): { ok: boolean; sampleRate?: number; channels?: number; bitsPerSample?: number; detail: string } {
  if (buf.length < 44) return { ok: false, detail: "file too small to be a WAV" };
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const riff = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3));
  const wave = String.fromCharCode(v.getUint8(8), v.getUint8(9), v.getUint8(10), v.getUint8(11));
  if (riff !== "RIFF" || wave !== "WAVE") return { ok: false, detail: "missing RIFF/WAVE header" };
  const format = v.getUint16(20, true);
  const channels = v.getUint16(22, true);
  const sampleRate = v.getUint32(24, true);
  const bits = v.getUint16(34, true);
  const okFmt = format === 1 && channels === 1 && sampleRate === 16000 && bits === 16;
  return {
    ok: okFmt,
    sampleRate,
    channels,
    bitsPerSample: bits,
    detail: okFmt ? "16 kHz mono 16-bit PCM" : `expected 16 kHz mono 16-bit PCM, got ${sampleRate} Hz / ${channels} ch / ${bits} bit (format ${format})`,
  };
}
