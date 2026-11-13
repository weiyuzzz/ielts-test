import { db } from "@/db";
import { questions } from "@/db/schema";
import { count, eq, and, sql } from "drizzle-orm";
import { getCurrentUser, errorResponse } from "@/lib/server/user";
import { activeBank } from "@/lib/server/bank-service";
import { probeAudioStorage } from "@/lib/server/storage";
import { managedServices, probeServiceHealth } from "@/lib/server/managed-services";
import { getTTS, getLLM, getPronunciation, getASR, TIMEOUTS } from "@/lib/ai/registry";
import { withTimeout, type LLMProvider, type TTSProvider } from "@/lib/ai/types";
import { recordUsage } from "@/lib/server/ai-usage";
import { envDefaultProfile, resolveVoiceProfile } from "@/lib/speaking/voice-profile";
import {
  DIAGNOSTIC_IDS, classifyProviderFailure,
  type DiagnosticItem, type ServerDiagnosticsResponse, type ManagedServiceStatus,
  type DiagnosticsRunRequest, type DiagnosticsCapabilitySnapshot,
} from "@/lib/diagnostics/types";

export const dynamic = "force-dynamic";

/**
 * Diagnostics centre API.
 *
 *  GET  → cheap, secret-free snapshot: active providers + managed services +
 *         Kokoro /health probe (local engine, no external cost).
 *  POST → run REAL probes for the requested check ids. LLM/TTS probes make
 *         small paid API calls on purpose — the UI warns before calling this.
 *
 * Behaviour guarantees (see docs + the settings page):
 *  - never returns API keys or raw env vars;
 *  - GET /api/health and /api/config keep their exact original behaviour;
 *  - the TTS probe exercises the same synthesize() path the exam uses
 *    (TTS_STREAM=0 semantics untouched, word timestamps preserved);
 *  - the LLM probe is a tiny JSON echo, never the IELTS scoring prompt.
 */

/** The exact sentence the deployment doc reserves for voice verification. */
const TTS_TEST_LINE = "Hello. My name is Sarah, and I will be your examiner today.";

function item(base: Omit<DiagnosticItem, "testedAt"> & { testedAt?: string }): DiagnosticItem {
  return { ...base, testedAt: base.testedAt ?? new Date().toISOString() };
}

function now() {
  return new Date().toISOString();
}

// ------------------------------------------------------------------ app probes

async function probeDb(): Promise<DiagnosticItem> {
  const t0 = Date.now();
  try {
    await db.execute(sql`select 1`);
    return item({ id: DIAGNOSTIC_IDS.appDb, group: "application", name: "PostgreSQL", scope: "server", status: "ready", required: true, message: "Database answered SELECT 1.", latencyMs: Date.now() - t0 });
  } catch (e) {
    return item({
      id: DIAGNOSTIC_IDS.appDb, group: "application", name: "PostgreSQL", scope: "server", status: "failed", required: true,
      message: "Database is not responding.",
      detail: (e as Error).message.slice(0, 300),
      repairActions: [
        { id: "db-recheck", label: "Re-run check", description: "Run the database probe again.", available: true },
        { id: "db-config", label: "Connection guide", description: "Check DATABASE_URL in .env (host, port, user, password, database name) and that PostgreSQL is running.", available: false },
      ],
    });
  }
}

async function probeSession(): Promise<DiagnosticItem> {
  const t0 = Date.now();
  try {
    const u = await getCurrentUser();
    if (!u) {
      return item({ id: DIAGNOSTIC_IDS.appSession, group: "application", name: "Session & exam API", scope: "server", status: "failed", required: true, message: "No session cookie — reload the page so the app can issue one." });
    }
    return item({ id: DIAGNOSTIC_IDS.appSession, group: "application", name: "Session & exam API", scope: "server", status: "ready", required: true, message: `Session OK (${u.displayName || "Candidate"}).`, latencyMs: Date.now() - t0 });
  } catch (e) {
    return item({ id: DIAGNOSTIC_IDS.appSession, group: "application", name: "Session & exam API", scope: "server", status: "failed", required: true, message: "Session lookup failed.", detail: (e as Error).message.slice(0, 300) });
  }
}

async function probeBank(): Promise<DiagnosticItem> {
  const t0 = Date.now();
  try {
    const bank = await activeBank();
    if (!bank) {
      return item({
        id: DIAGNOSTIC_IDS.appBank, group: "application", name: "Question bank", scope: "server", status: "not_configured", required: true,
        message: "No question bank has been imported yet.",
        repairActions: [{ id: "bank-import", label: "Import a bank", description: "Import a seasonal bank on the /admin page (Bank import).", available: true, href: "/admin" }],
      });
    }
    const [row] = await db.select({ n: count() }).from(questions).where(eq(questions.setId, bank.id));
    const countAll = Number(row?.n ?? 0);
    if (!countAll) {
      return item({ id: DIAGNOSTIC_IDS.appBank, group: "application", name: "Question bank", scope: "server", status: "failed", required: true, message: `Active bank "${bank.name}" contains no questions.`, detail: "The bank imported empty — re-import the season JSON." });
    }
    const [p1] = await db.select({ n: count() }).from(questions).where(and(eq(questions.setId, bank.id), eq(questions.part, 1)));
    const p1count = Number(p1?.n ?? 0);
    return item({
      id: DIAGNOSTIC_IDS.appBank, group: "application", name: "Question bank", scope: "server",
      status: p1count ? "ready" : "degraded", required: true,
      message: `Bank "${bank.name}" (${bank.season}) — ${countAll} questions, ${p1count} Part 1.`,
      detail: p1count ? undefined : "No Part 1 questions — a full mock cannot start.",
      latencyMs: Date.now() - t0,
    });
  } catch (e) {
    return item({ id: DIAGNOSTIC_IDS.appBank, group: "application", name: "Question bank", scope: "server", status: "failed", required: true, message: "Question bank query failed.", detail: (e as Error).message.slice(0, 300) });
  }
}

async function probeStorage(): Promise<DiagnosticItem> {
  const t0 = Date.now();
  const r = await probeAudioStorage();
  return item({
    id: DIAGNOSTIC_IDS.appStorage, group: "application", name: "Audio storage", scope: "server",
    status: r.ok ? "ready" : "failed", required: true,
    message: r.ok ? "Storage write/read/cleanup OK." : "Audio storage is not writable or not readable.",
    detail: r.detail, latencyMs: Date.now() - t0,
    repairActions: r.ok ? undefined : [
      { id: "storage-dir", label: "Storage guide", description: "Check AUDIO_STORAGE_DIR (default ./storage/audio) and the directory permissions.", available: false },
    ],
  });
}

// ------------------------------------------------------------------ TTS probes

function ttsProviderOf(): { tts: TTSProvider; isBrowser: boolean } {
  const tts = getTTS();
  return { tts, isBrowser: tts.id === "browser-speech-synthesis" };
}

function probeTtsConfig(): DiagnosticItem {
  const { tts, isBrowser } = ttsProviderOf();
  if (isBrowser) {
    return item({
      id: DIAGNOSTIC_IDS.ttsConfig, group: "speech", name: "Examiner voice (TTS)", scope: "provider", status: "degraded", required: true,
      provider: tts.id, model: tts.model ?? null,
      message: "No server voice engine is configured — the exam falls back to the browser's built-in voice.",
      detail: "Configure TTS_BASE_URL + TTS_MODEL (e.g. Kokoro on http://localhost:8880/v1) or AZURE_SPEECH_KEY / AZURE_SPEECH_REGION for a natural examiner voice. See docs/tts-engine-deployment.md.",
      repairActions: [{ id: "tts-deploy-doc", label: "Deployment guide", description: "docs/tts-engine-deployment.md — Kokoro install, GPU/CPU modes and keep-alive rules.", available: false }],
    });
  }
  return item({
    id: DIAGNOSTIC_IDS.ttsConfig, group: "speech", name: "Examiner voice (TTS)", scope: "provider", status: "ready", required: true,
    provider: tts.id, model: tts.model ?? null,
    message: `Server voice engine configured (${tts.id}${tts.model ? ` · ${tts.model}` : ""}).`,
    detail: "Run the synthesis probe to verify the engine actually produces audio.",
  });
}

async function probeTtsSynthesis(): Promise<DiagnosticItem> {
  const { tts, isBrowser } = ttsProviderOf();
  if (isBrowser) return probeTtsConfig(); // nothing to synth server-side
  const profile = envDefaultProfile();
  const t0 = Date.now();
  try {
    const r = await withTimeout(tts.id, TIMEOUTS.ttsMs, (signal) => tts.synthesize(TTS_TEST_LINE, { speechAct: "greeting", profile, signal }));
    const latencyMs = Date.now() - t0;
    void recordUsage({
      service: "tts", provider: tts.id, model: tts.model ?? null, status: "ok",
      latencyMs: Math.round(latencyMs), units: TTS_TEST_LINE.length, unitLabel: "chars",
      meta: { act: "greeting", probe: "diagnostics" },
    });
    const bytes = r.audio?.byteLength ?? 0;
    const mimeOk = /^(audio|application\/octet-stream)/i.test(r.mimeType || "");
    if (!bytes) {
      return item({
        id: DIAGNOSTIC_IDS.ttsSynth, group: "speech", name: "Examiner voice synthesis", scope: "provider", status: "failed", required: true,
        provider: tts.id, model: tts.model ?? null, latencyMs,
        message: "The engine answered but returned EMPTY audio data.",
        detail: `${r.mimeType || "unknown mime"} · 0 bytes — check engine logs; a restart may be needed.`,
      });
    }
    if (!mimeOk || bytes < 800) {
      return item({
        id: DIAGNOSTIC_IDS.ttsSynth, group: "speech", name: "Examiner voice synthesis", scope: "provider", status: "failed", required: true,
        provider: tts.id, model: tts.model ?? null, latencyMs,
        message: "The engine returned data that is not valid audio.",
        detail: `${r.mimeType || "unknown mime"} · ${bytes} bytes (expected ≥ 800 bytes of audio/mpeg|wav).`,
      });
    }
    return item({
      id: DIAGNOSTIC_IDS.ttsSynth, group: "speech", name: "Examiner voice synthesis", scope: "provider", status: latencyMs > 45_000 ? "degraded" : "ready",
      required: true, provider: tts.id, model: tts.model ?? null, latencyMs,
      message: latencyMs > 45_000
        ? `Synthesis works but is slow (${(latencyMs / 1000).toFixed(1)} s for one line).`
        : `Synthesized a ${bytes}-byte ${r.mimeType} clip.`,
      detail: latencyMs > 45_000 ? "Slow engines stretch the time between questions. Prefer the GPU engine (docs/tts-engine-deployment.md) or expect longer waits." : "Real audio data verified — not just HTTP 200.",
      repairActions: latencyMs > 45_000 ? [
        { id: "tts-gpu-doc", label: "GPU engine guide", description: "docs/tts-engine-deployment.md — GPU-first engine setup (3.3 s/line on M-series vs 30–60 s on CPU).", available: false },
      ] : undefined,
    });
  } catch (e) {
    const c = classifyProviderFailure(tts.id, e);
    return item({
      id: DIAGNOSTIC_IDS.ttsSynth, group: "speech", name: "Examiner voice synthesis", scope: "provider", status: c.status === "degraded" ? "failed" : c.status,
      required: true, provider: tts.id, model: tts.model ?? null,
      message: `Examiner voice synthesis failed (${c.kind}).`,
      detail: c.message,
      repairActions: [
        { id: "tts-restart", label: "Restart engine", description: "Restart the managed Kokoro service (only available when a supervisor is configured).", available: true },
        { id: "tts-docs", label: "Deployment guide", description: "docs/tts-engine-deployment.md — engine setup, keep-alive and troubleshooting.", available: false },
      ],
    });
  }
}

// ------------------------------------------------------------------ LLM probe

async function probeLLM(): Promise<DiagnosticItem> {
  const llm: LLMProvider | null = getLLM();
  if (!llm) {
    return item({
      id: DIAGNOSTIC_IDS.llmProbe, group: "ai", name: "Scoring LLM", scope: "provider", status: "not_configured", required: false,
      message: "No scoring LLM is configured — the exam completes but is marked unscored (no band is fabricated).",
      detail: "Set LLM_PROVIDER / an API key (OPENAI_API_KEY, DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, DASHSCOPE_API_KEY, GEMINI_API_KEY) or configure the provider on /admin.",
      repairActions: [{ id: "llm-config", label: "Open AI settings", description: "Configure the provider on the /admin AI panel.", available: true, href: "/admin" }],
    });
  }
  const t0 = Date.now();
  try {
    const raw = await withTimeout(llm.id, TIMEOUTS.llmMs, (signal) => llm.complete(
      [{ role: "user", content: 'Health probe. Reply with exactly this JSON and nothing else: {"ok":true}' }],
      {
        json: true, temperature: 0, maxTokens: 64, signal,
        onUsage: (usage) => void recordUsage({
          service: "llm", provider: llm.id, model: llm.model ?? null, status: "ok",
          latencyMs: Date.now() - t0,
          tokensIn: usage.promptTokens, tokensOut: usage.completionTokens,
          meta: { probe: "diagnostics" },
        }),
      },
    ));
    const latencyMs = Date.now() - t0;
    let parsed = false;
    try { parsed = JSON.parse(raw.trim())?.ok === true; } catch { parsed = false; }
    if (!parsed) {
      return item({
        id: DIAGNOSTIC_IDS.llmProbe, group: "ai", name: "Scoring LLM", scope: "provider", status: "failed", required: false,
        provider: llm.id, model: llm.model ?? null, latencyMs,
        message: "The LLM answered, but its output was not the requested JSON — scoring output would be unreliable.",
        detail: `Response head: ${raw.trim().slice(0, 120)}`,
        repairActions: [{ id: "llm-config", label: "Open AI settings", description: "Check the model id and provider settings on /admin.", available: true, href: "/admin" }],
      });
    }
    return item({
      id: DIAGNOSTIC_IDS.llmProbe, group: "ai", name: "Scoring LLM", scope: "provider", status: "ready", required: false,
      provider: llm.id, model: llm.model ?? null, latencyMs,
      message: `Generation + JSON parsing OK (${latencyMs} ms).`,
    });
  } catch (e) {
    const c = classifyProviderFailure(llm.id, e);
    const kindLabel: Record<string, string> = {
      key_invalid: "API key invalid or unauthorized",
      model_unavailable: "model not found / bad request",
      rate_limited: "rate limited (429)",
      timeout: `no response within ${TIMEOUTS.llmMs} ms`,
      invalid_format: "unexpected response format",
      not_configured: "credentials missing",
      failed: "request failed",
    };
    return item({
      id: DIAGNOSTIC_IDS.llmProbe, group: "ai", name: "Scoring LLM", scope: "provider", status: c.status, required: false,
      provider: llm.id, model: llm.model ?? null,
      message: `Scoring LLM unavailable — ${kindLabel[c.kind] ?? c.kind}.`,
      detail: c.message,
      repairActions: c.kind === "key_invalid" || c.kind === "model_unavailable"
        ? [{ id: "llm-config", label: "Open AI settings", description: "Fix the key / model on the /admin AI panel.", available: true, href: "/admin" }]
        : [{ id: "llm-recheck", label: "Re-run check", description: "Retry the LLM probe (a small paid request).", available: true }],
    });
  }
}

// ------------------------------------------------------------------ pronunciation config

async function probePronunciationConfig(): Promise<DiagnosticItem> {
  const pron = getPronunciation();
  if (!pron) {
    return item({
      id: DIAGNOSTIC_IDS.pronConfig, group: "pronunciation", name: "Pronunciation provider (P)", scope: "provider", status: "not_configured", required: false,
      message: "Not configured — P criterion unavailable.",
      detail: "Set PRONUNCIATION_PROVIDER=azure (AZURE_SPEECH_KEY + AZURE_SPEECH_REGION) or tencent-soe (TENCENT_SECRET_ID/KEY) to enable audio-based pronunciation assessment. FC/LR/GRA still score without it; the Overall band is omitted when P is missing.",
      repairActions: [{ id: "pron-config", label: "Open AI settings", description: "Configure Azure Speech or Tencent SOE on /admin.", available: true, href: "/admin" }],
    });
  }
  return item({
    id: DIAGNOSTIC_IDS.pronConfig, group: "pronunciation", name: "Pronunciation provider (P)", scope: "provider", status: "ready", required: false,
    provider: pron.id, model: pron.model ?? null,
    message: `${pron.id} configured. Run the audio assessment probe to verify it end-to-end.`,
    detail: "The assessment probe needs a 16 kHz mono PCM WAV — the microphone test below produces exactly that. Provider 0–100 scores are service availability evidence only, never IELTS bands, and the test sample is never stored as a result.",
  });
}

// ------------------------------------------------------------------ ASR config

function probeAsrConfig(): DiagnosticItem {
  const asr = getASR();
  if (!asr) {
    return item({ id: DIAGNOSTIC_IDS.asrConfig, group: "speech", name: "Speech recognition (ASR)", scope: "provider", status: "not_configured", required: false, message: "No ASR provider selected." });
  }
  if (asr.location === "browser") {
    return item({
      id: DIAGNOSTIC_IDS.asrConfig, group: "speech", name: "Speech recognition (ASR)", scope: "provider", status: "ready", required: false,
      provider: asr.id, model: asr.model ?? null,
      message: "Browser Web Speech transcribes answers on this device.",
      detail: "Use the browser check below to verify SpeechRecognition support in THIS browser.",
    });
  }
  return item({
    id: DIAGNOSTIC_IDS.asrConfig, group: "speech", name: "Speech recognition (ASR)", scope: "provider", status: "ready", required: false,
    provider: asr.id, model: asr.model ?? null,
    message: `${asr.id} configured${asr.model ? ` · ${asr.model}` : ""}. Run the real transcription probe to verify credentials end-to-end.`,
    detail: "The transcription probe uploads a short recording to the provider — the UI discloses this before it runs.",
  });
}

// ------------------------------------------------------------------ dispatcher

/** Managed-service statuses with a live (local, free) health probe. */
async function probeServices(): Promise<ManagedServiceStatus[]> {
  return Promise.all(managedServices().map(async (s) => {
    if (!s.healthUrl) return { ...s, healthy: null, detail: "Not a Kokoro deployment — no local engine health endpoint." };
    const h = await probeServiceHealth(s.id);
    return { ...s, healthy: h.healthy, detail: h.detail, latencyMs: h.latencyMs };
  }));
}

const SERVER_CHECKS: Record<string, () => Promise<DiagnosticItem>> = {
  [DIAGNOSTIC_IDS.appDb]: probeDb,
  [DIAGNOSTIC_IDS.appSession]: probeSession,
  [DIAGNOSTIC_IDS.appBank]: probeBank,
  [DIAGNOSTIC_IDS.appStorage]: probeStorage,
  [DIAGNOSTIC_IDS.ttsConfig]: async () => probeTtsConfig(),
  [DIAGNOSTIC_IDS.ttsSynth]: probeTtsSynthesis,
  [DIAGNOSTIC_IDS.llmProbe]: probeLLM,
  [DIAGNOSTIC_IDS.pronConfig]: probePronunciationConfig,
  [DIAGNOSTIC_IDS.asrConfig]: async () => probeAsrConfig(),
};

function capabilitySnapshot(): DiagnosticsCapabilitySnapshot {
  const tts = getTTS();
  const asr = getASR();
  const llm = getLLM();
  const pron = getPronunciation();
  const voice = resolveVoiceProfile(process.env.EXAMINER_PROFILE || process.env.TTS_VOICE);
  return {
    tts: { id: tts.id, model: tts.model ?? null, location: tts.location, format: process.env.TTS_FORMAT || "mp3", streaming: typeof tts.synthesizeStream === "function" },
    asr: asr ? { id: asr.id, model: asr.model ?? null, location: asr.location } : null,
    llm: llm ? { id: llm.id, model: llm.model ?? null } : null,
    pronunciation: pron ? { id: pron.id } : null,
    examinerVoice: voice.id,
  };
}

export async function GET() {
  try {
    await getCurrentUser(); // also verifies the session path works
  } catch { /* snapshot stays viewable even without a session */ }
  const services = await probeServices();
  const response: ServerDiagnosticsResponse = {
    items: [],
    services,
    config: capabilitySnapshot(),
  };
  return Response.json(response);
}

export async function POST(req: Request) {
  try {
    await getCurrentUser(); // diagnostics run in a real session context
    const body = (await req.json().catch(() => ({}))) as DiagnosticsRunRequest;
    const requested = Array.isArray(body.checks) && body.checks.length ? body.checks : Object.keys(SERVER_CHECKS);
    const items: DiagnosticItem[] = [];
    for (const id of requested) {
      const run = SERVER_CHECKS[id];
      if (run) items.push(await run());
    }
    const services = await probeServices();
    const response: ServerDiagnosticsResponse = {
      items,
      services,
      config: capabilitySnapshot(),
    };
    return Response.json(response);
  } catch (e) {
    return errorResponse(e);
  }
}
