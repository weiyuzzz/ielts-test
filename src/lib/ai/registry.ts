/**
 * Provider selection. Business logic calls getASR()/getLLM()/getTTS()/getPronunciation()
 * and never references a vendor directly.
 *
 *   ASR_PROVIDER=openai | browser | none        (default: openai if a key exists, else browser)
 *   LLM_PROVIDER=openai | anthropic | none      (default: whichever key exists, else none)
 *   TTS_PROVIDER=openai | azure | browser       (default: auto — configured service, else browser)
 *   PRONUNCIATION_PROVIDER=azure | none         (default: azure if key+region exist, else none)
 */
import type { ASRProvider, LLMProvider, TTSProvider, PronunciationProvider } from "./types";
import { ProviderError } from "./types";
import { openAIASR, openAILLM, anthropicLLM, openAITTS, azureTTS, azurePronunciation } from "./providers";

const hasOpenAI = () => !!(process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || process.env.ASR_API_KEY);

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
  const p = process.env.ASR_PROVIDER || (process.env.OPENAI_API_KEY || process.env.ASR_API_KEY ? "openai" : "browser");
  if (p === "openai") return openAIASR();
  if (p === "browser") return browserASR;
  return null;
}

export function getLLM(): LLMProvider | null {
  const p = process.env.LLM_PROVIDER || (hasOpenAI() ? "openai" : process.env.ANTHROPIC_API_KEY ? "anthropic" : "none");
  if (p === "openai") return openAILLM();
  if (p === "anthropic") return anthropicLLM();
  return null;
}

export function getTTS(): TTSProvider {
  const p = process.env.TTS_PROVIDER;
  if (p === "azure") return azureTTS();
  if (p === "openai") return openAITTS();
  if (p === "browser") return browserTTS;
  // Auto: never fall back to the mechanical browser voice when a real engine is configured.
  if (process.env.TTS_BASE_URL || process.env.TTS_API_KEY || process.env.OPENAI_API_KEY) return openAITTS();
  if (process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION) return azureTTS();
  return browserTTS;
}

export function getPronunciation(): PronunciationProvider | null {
  const p = process.env.PRONUNCIATION_PROVIDER || (process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION ? "azure" : "none");
  return p === "azure" ? azurePronunciation() : null;
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
  return {
    asr: asr ? { id: asr.id, location: asr.location, model: asr.model ?? null } : null,
    llm: llm ? { id: llm.id, model: llm.model ?? null } : null,
    tts: {
      id: tts.id,
      location: tts.location,
      model: tts.model ?? null,
      voice: process.env.TTS_VOICE || (tts.id === "azure-neural-tts" ? process.env.AZURE_TTS_VOICE || "en-GB-SoniaNeural" : "auto"),
      format: process.env.TTS_FORMAT || "mp3",
      streaming: typeof tts.synthesizeStream === "function",
    },
    pronunciation: pron ? { id: pron.id } : null,
  };
}
