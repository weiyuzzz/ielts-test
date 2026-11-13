/**
 * Provider-neutral AI service interfaces. Business logic depends only on these.
 * Concrete vendors are selected in ./registry.ts from environment variables.
 */
import type { WordTiming } from "@/db/schema";
import type { ExaminerSpeechAct } from "@/lib/speaking/speech-act";
import type { VoiceProfile } from "@/lib/speaking/voice-profile";

export interface ProviderInfo {
  id: string;
  model?: string;
}

export interface ASRResult {
  text: string;
  words?: WordTiming[];
  confidence?: number;
  language?: string;
}
export interface ASRProvider extends ProviderInfo {
  /** "server" providers transcribe uploaded audio; "browser" means the client supplies Web Speech transcripts. */
  location: "server" | "browser";
  transcribe(audio: Buffer, mimeType: string, opts?: { signal?: AbortSignal; prompt?: string }): Promise<ASRResult>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Token usage reported by the provider for one completion. */
export interface UsageInfo {
  promptTokens?: number;
  completionTokens?: number;
}

export interface LLMProvider extends ProviderInfo {
  complete(messages: ChatMessage[], opts?: {
    json?: boolean;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    /** Called with the provider's usage numbers when the API reports them. */
    onUsage?: (usage: UsageInfo) => void;
  }): Promise<string>;
}

export interface TTSStream {
  body: ReadableStream<Uint8Array>;
  mimeType: string;
}

/**
 * Per-request synthesis options. `profile` / `speechAct` are optional so every
 * existing caller keeps working; when present, the provider adapts rate, pauses,
 * emphasis and steering text to the speech act.
 */
export interface TTSSynthesisOptions {
  voice?: string;
  signal?: AbortSignal;
  profile?: VoiceProfile;
  speechAct?: ExaminerSpeechAct;
}

export interface TTSProvider extends ProviderInfo {
  location: "server" | "browser";
  /** Which steering capabilities the underlying engine actually has. */
  supports?: {
    ssml: boolean;
    instructions: boolean;
    style: boolean;
    pitch: boolean;
  };
  synthesize(text: string, opts?: TTSSynthesisOptions): Promise<TTSSynthesisResult>;
  /**
   * Optional progressive synthesis. When available the API route pipes the audio
   * straight to the browser, so playback starts at the first spoken sentence
   * instead of waiting for the whole line to be generated.
   */
  synthesizeStream?(text: string, opts?: TTSSynthesisOptions): Promise<TTSStream | null>;
}

/**
 * Synthesis result. `words` are OPTIONAL engine-measured word timestamps in
 * real audio seconds (e.g. Kokoro's captioned-speech endpoint). When present
 * the API route forwards them so lip-sync can word-anchor instead of guessing.
 */
export interface TTSSynthesisResult {
  audio: Buffer;
  mimeType: string;
  words?: { word: string; start: number; end: number }[];
}

export interface PronunciationResult {
  accuracy: number;
  fluency: number;
  prosody?: number;
  completeness?: number;
  overall: number;
  words: { word: string; accuracy: number; errorType?: string }[];
}
export interface PronunciationProvider extends ProviderInfo {
  /** Expects 16 kHz mono 16-bit PCM WAV. referenceText = ASR transcript (unscripted assessment). */
  assess(
    wav: Buffer,
    referenceText: string,
    opts?: {
      signal?: AbortSignal;
      /** ASR word timings, when available: providers may use them to align audio to reference text. */
      words?: WordTiming[];
    },
  ): Promise<PronunciationResult>;
}

export class ProviderError extends Error {
  constructor(
    public provider: string,
    public code: "timeout" | "http" | "config" | "invalid_response" | "unsupported",
    message: string,
  ) {
    super(`[${provider}] ${code}: ${message}`);
  }
}

/** Run a provider call with a hard timeout that aborts the underlying request. */
export async function withTimeout<T>(provider: string, ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => {
      // reject first so the race settles with a classified timeout, then cancel the request
      rej(new ProviderError(provider, "timeout", `no response within ${ms}ms`));
      ctrl.abort();
    }, ms);
  });
  try {
    return await Promise.race([fn(ctrl.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
