/**
 * Concrete provider implementations (server-only). Each reads its own env vars.
 *  - OpenAI-compatible: works with OpenAI, DeepSeek, Qwen (DashScope compatible mode), Groq, local vLLM, etc.
 *  - Anthropic Messages API
 *  - Azure Speech: Neural TTS + Pronunciation Assessment (audio-based)
 */
import { ProviderError, type ASRProvider, type LLMProvider, type TTSProvider, type PronunciationProvider, type ChatMessage } from "./types";
import { EXAMINER_TTS_INSTRUCTIONS, normalizeExaminerText, toAzureSsml, toProsodySsml } from "./tts-text";

async function check(res: Response, provider: string) {
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new ProviderError(provider, "http", `${res.status} ${body}`);
  }
  return res;
}

function extFor(mime: string) {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return "m4a";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg")) return "mp3";
  return "bin";
}

// ------------------------------------------------------------------ OpenAI-compatible
export function openAIASR(): ASRProvider {
  const base = (process.env.ASR_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const key = process.env.ASR_API_KEY || process.env.OPENAI_API_KEY || "";
  const model = process.env.ASR_MODEL || "whisper-1";
  return {
    id: "openai-compatible-asr",
    model,
    location: "server",
    async transcribe(audio, mimeType, opts) {
      if (!key) throw new ProviderError("openai-asr", "config", "missing API key");
      const fd = new FormData();
      fd.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), `answer.${extFor(mimeType)}`);
      fd.append("model", model);
      fd.append("language", "en");
      fd.append("response_format", "verbose_json");
      fd.append("timestamp_granularities[]", "word");
      if (opts?.prompt) fd.append("prompt", opts.prompt.slice(0, 400));
      const res = await check(
        await fetch(`${base}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd, signal: opts?.signal }),
        "openai-asr",
      );
      const j = (await res.json()) as { text?: string; words?: { word: string; start: number; end: number }[]; language?: string };
      if (typeof j.text !== "string") throw new ProviderError("openai-asr", "invalid_response", "no text");
      return { text: j.text.trim(), words: j.words?.map((w) => ({ word: w.word, start: w.start, end: w.end })), language: j.language };
    },
  };
}

export function openAILLM(): LLMProvider {
  const base = (process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const key = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "";
  const model = process.env.LLM_MODEL || "gpt-4o-mini";
  return {
    id: "openai-compatible-llm",
    model,
    async complete(messages: ChatMessage[], opts) {
      if (!key) throw new ProviderError("openai-llm", "config", "missing API key");
      const res = await check(
        await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages,
            temperature: opts?.temperature ?? 0.2,
            max_tokens: opts?.maxTokens ?? 2500,
            ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
          }),
          signal: opts?.signal,
        }),
        "openai-llm",
      );
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const c = j.choices?.[0]?.message?.content;
      if (typeof c !== "string") throw new ProviderError("openai-llm", "invalid_response", "no content");
      return c;
    },
  };
}

export function anthropicLLM(): LLMProvider {
  const key = process.env.ANTHROPIC_API_KEY || "";
  const model = process.env.LLM_MODEL || "claude-3-5-haiku-latest";
  return {
    id: "anthropic",
    model,
    async complete(messages, opts) {
      if (!key) throw new ProviderError("anthropic", "config", "missing API key");
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
      const res = await check(
        await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({
            model,
            system,
            max_tokens: opts?.maxTokens ?? 2500,
            temperature: opts?.temperature ?? 0.2,
            messages: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content })),
          }),
          signal: opts?.signal,
        }),
        "anthropic",
      );
      const j = (await res.json()) as { content?: { type: string; text?: string }[] };
      const t = j.content?.find((c) => c.type === "text")?.text;
      if (typeof t !== "string") throw new ProviderError("anthropic", "invalid_response", "no text");
      return t;
    },
  };
}

function ttsMime(format: string): string {
  if (format === "wav") return "audio/wav";
  if (format === "flac") return "audio/flac";
  if (format === "aac") return "audio/aac";
  if (format === "opus") return "audio/ogg";
  return "audio/mpeg";
}

/**
 * OpenAI-compatible /audio/speech, also used by self-hosted engines (Kokoro, etc.).
 *
 * Two things matter for examiner audio quality:
 *  - prosody: a flat string sounds mechanical; SSML <break>s give it human rhythm.
 *    Only sent to compatible engines — OpenAI rejects unknown request fields.
 *  - streaming: compatible engines emit one sentence per chunk, so the route can
 *    pipe audio to the browser while it is still being generated.
 */
export function openAITTS(): TTSProvider {
  const base = (process.env.TTS_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const key = process.env.TTS_API_KEY || process.env.OPENAI_API_KEY || "";
  const model = process.env.TTS_MODEL || "gpt-4o-mini-tts";
  const format = process.env.TTS_FORMAT || "mp3";
  const speed = Number(process.env.TTS_SPEED || 0.95);
  const instructions = process.env.TTS_INSTRUCTIONS || EXAMINER_TTS_INSTRUCTIONS;
  const configuredVoice = (v?: string) => (v && v !== "auto" ? v : process.env.TTS_VOICE || "alloy");

  // A custom base URL / dedicated key or a Kokoro model id means a compatible engine.
  const compatible = !!(process.env.TTS_BASE_URL || process.env.TTS_API_KEY) || /^(kokoro|tts-1|tts-1-hd)$/i.test(model);
  const prosody = process.env.TTS_PROSODY ? process.env.TTS_PROSODY !== "0" : compatible;
  const streaming = process.env.TTS_STREAM ? process.env.TTS_STREAM !== "0" : compatible;
  const neural = /gpt-4o.*-tts|gpt-4o-mini-tts/i.test(model);

  const payload = (text: string, voice: string | undefined, stream: boolean) => JSON.stringify({
    model,
    voice: configuredVoice(voice),
    input: prosody ? toProsodySsml(text) : normalizeExaminerText(text),
    response_format: format,
    speed,
    ...(compatible ? { stream } : {}),
    ...(prosody ? { ssml: true, allow_voice_tags: true } : {}),
    ...(neural ? { instructions } : {}),
  });

  const request = (text: string, voice: string | undefined, stream: boolean, signal?: AbortSignal) => {
    if (!key) throw new ProviderError("openai-tts", "config", "missing API key");
    return fetch(`${base}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: payload(text, voice, stream),
      signal,
    });
  };

  return {
    id: "openai-compatible-tts",
    model,
    location: "server",
    async synthesize(text, opts) {
      const res = await check(await request(text, opts?.voice, false, opts?.signal), "openai-tts");
      return { audio: Buffer.from(await res.arrayBuffer()), mimeType: ttsMime(res.headers.get("content-type")?.includes("wav") ? "wav" : format) };
    },
    async synthesizeStream(text, opts) {
      if (!streaming) return null;
      const res = await check(await request(text, opts?.voice, true, opts?.signal), "openai-tts");
      if (!res.body) return null;
      const ct = res.headers.get("content-type") || "";
      return {
        body: res.body as ReadableStream<Uint8Array>,
        mimeType: ttsMime(ct.includes("wav") ? "wav" : ct.includes("flac") ? "flac" : format),
      };
    },
  };
}

/**
 * Azure Neural TTS — the most natural option, including genuine British neural
 * voices. Reuses the same speech key/region as pronunciation assessment.
 */
export function azureTTS(): TTSProvider {
  const key = process.env.AZURE_SPEECH_KEY || "";
  const region = process.env.AZURE_SPEECH_REGION || "";
  const configured = process.env.TTS_VOICE || "";
  const isNeuralName = /^[a-z]{2}-[A-Z]{2}-.+/i.test(configured);
  const fallback = process.env.AZURE_TTS_VOICE || "en-GB-SoniaNeural";
  const defaultVoice = isNeuralName ? configured : fallback;
  const outputFormat = process.env.AZURE_TTS_FORMAT || "riff-48khz-16bit-mono-pcm";

  return {
    id: "azure-neural-tts",
    model: defaultVoice,
    location: "server",
    async synthesize(text, opts) {
      if (!key || !region) throw new ProviderError("azure-tts", "config", "missing AZURE_SPEECH_KEY / AZURE_SPEECH_REGION");
      const voice = opts?.voice && /^[a-z]{2}-[A-Z]{2}-.+/i.test(opts.voice) ? opts.voice : defaultVoice;
      const lang = /^en-GB/i.test(voice) ? "en-GB" : /^en-/i.test(voice) ? voice.slice(0, 5) : "en-GB";
      const res = await check(
        await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": outputFormat,
            "User-Agent": "band-nine-ielts",
          },
          body: toAzureSsml(text, voice, lang),
          signal: opts?.signal,
        }),
        "azure-tts",
      );
      return { audio: Buffer.from(await res.arrayBuffer()), mimeType: outputFormat.includes("mp3") ? "audio/mpeg" : "audio/wav" };
    },
  };
}

// ------------------------------------------------------------------ Azure pronunciation
export function azurePronunciation(): PronunciationProvider {
  const key = process.env.AZURE_SPEECH_KEY || "";
  const region = process.env.AZURE_SPEECH_REGION || "";
  return {
    id: "azure-pronunciation-assessment",
    model: "en-US unscripted",
    async assess(wav, referenceText, opts) {
      if (!key || !region) throw new ProviderError("azure-pron", "config", "missing AZURE_SPEECH_KEY / AZURE_SPEECH_REGION");
      const params = Buffer.from(
        JSON.stringify({ ReferenceText: referenceText.slice(0, 3000), GradingSystem: "HundredMark", Granularity: "Word", Dimension: "Comprehensive", EnableProsodyAssessment: "True" }),
      ).toString("base64");
      const res = await check(
        await fetch(`https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed`, {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
            "Pronunciation-Assessment": params,
            Accept: "application/json",
          },
          body: new Uint8Array(wav),
          signal: opts?.signal,
        }),
        "azure-pron",
      );
      type W = { Word: string; PronunciationAssessment?: { AccuracyScore: number; ErrorType?: string } };
      const j = (await res.json()) as {
        NBest?: { PronunciationAssessment?: { AccuracyScore: number; FluencyScore: number; ProsodyScore?: number; CompletenessScore?: number; PronScore: number }; Words?: W[] }[];
      };
      const best = j.NBest?.[0];
      const pa = best?.PronunciationAssessment;
      if (!pa) throw new ProviderError("azure-pron", "invalid_response", "no PronunciationAssessment in response");
      return {
        accuracy: pa.AccuracyScore,
        fluency: pa.FluencyScore,
        prosody: pa.ProsodyScore,
        completeness: pa.CompletenessScore,
        overall: pa.PronScore,
        words: (best?.Words ?? []).map((w) => ({ word: w.Word, accuracy: w.PronunciationAssessment?.AccuracyScore ?? 0, errorType: w.PronunciationAssessment?.ErrorType })),
      };
    },
  };
}
