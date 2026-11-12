/**
 * Provider selection. Business logic calls getASR()/getLLM()/getTTS()/getPronunciation()
 * and never references a vendor directly.
 *
 *   ASR_PROVIDER=openai | tencent-asr | browser | none  (default: openai if a key exists, else tencent-asr if Tencent credentials+AppID exist, else browser)
 *   LLM_PROVIDER=openai | deepseek | anthropic | none  (default: whichever key exists, else none)
 *   TTS_PROVIDER=openai | azure | browser       (default: auto — configured service, else browser)
 *   PRONUNCIATION_PROVIDER=azure | tencent-soe | none  (default: azure if key+region exist, else tencent-soe if Tencent credentials exist, else none)
 */
import type { ASRProvider, LLMProvider, TTSProvider, PronunciationProvider } from "./types";
import { ProviderError } from "./types";
import { openAIASR, openAILLM, deepseekLLM, qwenLLM, geminiLLM, anthropicLLM, openAITTS, azureTTS, azurePronunciation } from "./providers";
import { tencentSoePronunciation } from "./tencent-soe";
import { tencentAsr } from "./tencent-asr";
import { SPEECH_ACT_LIST } from "@/lib/speaking/speech-act";
import { readAiConfig, envOverridesFor, withEnvOverrides, type ProviderKey } from "@/lib/server/ai-config";

import { DEFAULT_PROFILE_ID, VOICE_PRESETS, resolveVoiceProfile, type VoiceProviderId } from "@/lib/speaking/voice-profile";

const hasOpenAI = () => !!(process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || process.env.ASR_API_KEY);

/**
 * Apply the /admin AI config to process.env for the duration of a synchronous
 * provider construction. The provider factories capture their settings at
 * construction time, so restoring the env afterwards is safe.
 */
function withCfg<T>(key: ProviderKey, fn: () => T): T {
  return withEnvOverrides(envOverridesFor(readAiConfig(), key), fn);
}

export const browserASR: ASRProvider = {
  id: "browser-web-speech",
  model: "Web Speech API (client)",
  location: "browser",
  async transcribe() {
    throw new ProviderError("browser-web-speech", "unsupported", "browser ASR runs on the client");
  },
};

export const browserTTS: TTSProvider = {
  id: "browser-speech-synthesis",
  location: "browser",
  async synthesize() {
    throw new ProviderError("browser-speech-synthesis", "unsupported", "browser TTS runs on the client");
  },
};

export function getASR(): ASRProvider | null {
  return withCfg("asr", () => {
    const p = process.env.ASR_PROVIDER || (process.env.OPENAI_API_KEY || process.env.ASR_API_KEY ? "openai" : process.env.TENCENT_SECRET_ID && process.env.TENCENT_APP_ID ? "tencent-asr" : "browser");
    if (p === "openai") return openAIASR();
    if (p === "tencent-asr") return tencentAsr();
    if (p === "browser") return browserASR;
    return null;
  });
}

export function getLLM(): LLMProvider | null {
  return withCfg("llm", () => {
    const p = process.env.LLM_PROVIDER || (hasOpenAI() ? "openai" : process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.DEEPSEEK_API_KEY ? "deepseek" : process.env.DASHSCOPE_API_KEY ? "qwen" : process.env.GEMINI_API_KEY ? "gemini" : "none");
    if (p === "openai") return openAILLM();
    if (p === "deepseek") return deepseekLLM();
    if (p === "qwen") return qwenLLM();
    if (p === "gemini") return geminiLLM();
    if (p === "anthropic") return anthropicLLM();
    return null;
  });
}

/**
 * Fallback scoring LLM, used ONLY when the primary provider fails. Configured
 * via LLM_FALLBACK_PROVIDER (+ optional LLM_FALLBACK_MODEL / LLM_FALLBACK_API_KEY /
 * LLM_FALLBACK_BASE_URL). Same rubric, same validator; every degradation is
 * recorded on the assessment — never a silent switch.
 */
export function getLLMFallback(): LLMProvider | null {
  const p = process.env.LLM_FALLBACK_PROVIDER;
  if (!p || p === "none") return null;
  const overrides: Record<string, string | undefined> = {
    LLM_PROVIDER: p,
    LLM_MODEL: process.env.LLM_FALLBACK_MODEL || process.env.LLM_MODEL,
    LLM_BASE_URL: process.env.LLM_FALLBACK_BASE_URL || process.env.LLM_BASE_URL,
  };
  if (p === "anthropic") {
    overrides.ANTHROPIC_API_KEY = process.env.LLM_FALLBACK_API_KEY || process.env.ANTHROPIC_API_KEY;
  } else {
    overrides.LLM_API_KEY = process.env.LLM_FALLBACK_API_KEY || process.env.LLM_API_KEY;
    if (p === "deepseek") overrides.DEEPSEEK_API_KEY = process.env.LLM_FALLBACK_API_KEY || process.env.DEEPSEEK_API_KEY;
    if (p === "qwen") overrides.DASHSCOPE_API_KEY = process.env.LLM_FALLBACK_API_KEY || process.env.DASHSCOPE_API_KEY;
    if (p === "gemini") overrides.GEMINI_API_KEY = process.env.LLM_FALLBACK_API_KEY || process.env.GEMINI_API_KEY;
  }
  return withEnvOverrides(overrides, () => getLLM());
}

export function getTTS(): TTSProvider {
  return withCfg("tts", () => {
    const p = process.env.TTS_PROVIDER;
    if (p === "azure") return azureTTS();
    if (p === "openai") return openAITTS();
    if (p === "browser") return browserTTS;
    // Auto: never fall back to the mechanical browser voice when a real engine is configured.
    if (process.env.TTS_BASE_URL || process.env.TTS_API_KEY || process.env.OPENAI_API_KEY) return openAITTS();
    if (process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION) return azureTTS();
    return browserTTS;
  });
}

const hasAzureSpeech = () => !!(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);
const hasServerTts = () => !!(process.env.TTS_BASE_URL || process.env.TTS_API_KEY || process.env.OPENAI_API_KEY);

/**
 * Resolve the provider a VoiceProfile asks for. A missing credential is a hard
 * error rather than a silent downgrade: swapping the examiner's voice mid-test
 * would be worse than telling the caller the voice is unavailable.
 */
export function getTTSFor(provider: VoiceProviderId): TTSProvider {
  return withCfg("tts", () => {
  if (provider === "azure") {
    if (!hasAzureSpeech()) throw new ProviderError("azure-tts", "config", "AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not configured");
    return azureTTS();
  }
  if (provider === "openai" || provider === "kokoro") {
    if (!hasServerTts()) throw new ProviderError("openai-compatible-tts", "config", "TTS_BASE_URL / TTS_API_KEY not configured");
    return openAITTS();
  }
  return browserTTS;
  });
}

/** Which providers this deployment can actually reach — used by the Voice Lab. */
export function ttsAvailability() {
  return withCfg("tts", () => ({
    azure: hasAzureSpeech(),
    openai: hasServerTts(),
    kokoro: hasServerTts(),
    browser: true,
  }));
}

export function getPronunciation(): PronunciationProvider | null {
  return withCfg("pronunciation", () => {
    const p = process.env.PRONUNCIATION_PROVIDER || (process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION ? "azure" : process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY ? "tencent-soe" : "none");
    if (p === "azure") return azurePronunciation();
    if (p === "tencent-soe") return tencentSoePronunciation();
    return null;
  });
}

export const TIMEOUTS = {
  asrMs: Number(process.env.ASR_TIMEOUT_MS || 45000),
  llmMs: Number(process.env.LLM_TIMEOUT_MS || 60000),
  llmFollowUpMs: Number(process.env.LLM_FOLLOWUP_TIMEOUT_MS || 8000),
  // Long Part 2 instructions take >10 s on local/CPU engines.
  ttsMs: Number(process.env.TTS_TIMEOUT_MS || 30000),
  pronMs: Number(process.env.PRONUNCIATION_TIMEOUT_MS || 30000),
};

/** Public, secret-free capability description for the client. */
export function capabilities() {
  const asr = getASR();
  const llm = getLLM();
  const tts = getTTS();
  const pron = getPronunciation();
  const cfg = readAiConfig();
  const active = resolveVoiceProfile(process.env.EXAMINER_PROFILE || cfg.tts.voice || process.env.TTS_VOICE);
  return {
    asr: asr ? { id: asr.id, location: asr.location, model: asr.model ?? null } : null,
    llm: llm ? { id: llm.id, model: llm.model ?? null } : null,
    tts: {
      id: tts.id,
      location: tts.location,
      model: tts.model ?? null,
      voice: cfg.tts.voice || process.env.TTS_VOICE || (tts.id === "azure-neural-tts" ? process.env.AZURE_TTS_VOICE || "en-GB-SoniaNeural" : "auto"),
      format: process.env.TTS_FORMAT || "mp3",
      streaming: typeof tts.synthesizeStream === "function",
      supports: tts.supports ?? { ssml: false, instructions: false, style: false, pitch: false },
      /** Voice profiles the UI may offer, plus what this deployment can actually reach. */
      profiles: VOICE_PRESETS.map((p) => ({
        id: p.id, name: p.name, provider: p.provider, voice: p.voice,
        speed: p.speed, pitch: p.pitch ?? 0, hasStyle: !!p.style,
      })),
      defaultProfileId: DEFAULT_PROFILE_ID,
      activeProfile: { id: active.id, name: active.name, provider: active.provider, voice: active.voice, speed: active.speed },
      availability: ttsAvailability(),
      speechActs: SPEECH_ACT_LIST.map((a) => ({ id: a.id, label: a.label })),
    },
    pronunciation: pron ? { id: pron.id } : null,
  };
}
