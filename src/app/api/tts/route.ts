import { getTTS, getTTSFor, TIMEOUTS } from "@/lib/ai/registry";
import { withTimeout, type TTSProvider } from "@/lib/ai/types";
import { requireUser, errorResponse, HttpError } from "@/lib/server/user";
import {
  concatChunks, getClip, pendingClip, putClip, ttsCacheKey,
  withInflightPriority, activeJobPriority, cancelPrefetchJob, type CachedClip,
} from "@/lib/server/tts-cache";
import { isSpeechAct, type ExaminerSpeechAct } from "@/lib/speaking/speech-act";
import { recordUsage } from "@/lib/server/ai-usage";
import { profileFingerprint, resolveVoiceProfile, sanitizeProfile, type VoiceProfile } from "@/lib/speaking/voice-profile";
import { readAiConfig, envOverridesFor, withEnvOverrides } from "@/lib/server/ai-config";

/**
 * Examiner TTS proxy (keeps API keys on the server).
 *
 *  GET  /api/tts?text=…&voice=…&act=question&profile=azure-sonia
 *       → progressive audio for LIVE playback. Highest priority: never waits on
 *         a POST warm-up, and cancels that warm-up instead.
 *  POST /api/tts { text, voice, act, profile }
 *       → complete audio for background PREFETCH. Best effort, cancellable.
 *
 * `profile` may be a preset id ("azure-sonia"), "provider:voice"
 * ("azure:en-GB-RyanNeural") or a full VoiceProfile object (Voice Lab).
 *
 * Both paths share the LRU cache keyed by everything that changes the waveform:
 * provider, model, the VoiceProfile fingerprint (voice, language, speed, pitch,
 * style, instructions, prosody), the speech act, the output format and the text.
 * `X-TTS-Cache` distinguishes hit / miss / miss-stream; `X-TTS-Synthesis-Ms`
 * and `Server-Timing` feed the client performance trace.
 * Returns 501 when the browser TTS provider is active.
 */
export const dynamic = "force-dynamic";

const MAX_TEXT = 1500;

interface TtsParams {
  text: string;
  profile: VoiceProfile;
  act: ExaminerSpeechAct;
  /** True when the caller chose a profile explicitly (Voice Lab / a session
   *  snapshot), which also selects the provider instead of the deployment default. */
  explicitProfile: boolean;
}

function parseText(text?: string | null): string {
  if (!text || !text.trim()) throw new HttpError(400, "text required (max 1500 chars)");
  if (text.length > MAX_TEXT) throw new HttpError(400, "text too long (max 1500 chars)");
  return text.trim();
}

function buildParams(input: { text?: string | null; voice?: string | null; act?: string | null; profile?: unknown }): TtsParams {
  const text = parseText(input.text);
  const explicitProfile = input.profile !== undefined && input.profile !== null && input.profile !== "";
  const profile = explicitProfile
    ? typeof input.profile === "string"
      ? resolveVoiceProfile(input.profile)
      : sanitizeProfile(input.profile)
    : resolveVoiceProfile(input.voice);
  const act: ExaminerSpeechAct = isSpeechAct(input.act) ? input.act : "question";
  return { text, profile, act, explicitProfile };
}

/** Output format actually requested from the engine (part of the cache identity). */
function outputFormat(tts: TTSProvider): string {
  if (tts.id === "azure-neural-tts") return process.env.AZURE_TTS_FORMAT || "riff-48khz-16bit-mono-pcm";
  return process.env.TTS_FORMAT || "mp3";
}

function keyFor(tts: TTSProvider, p: TtsParams): string {
  return ttsCacheKey([
    tts.id,
    tts.model,
    profileFingerprint(p.profile, p.act, outputFormat(tts)),
    p.text,
  ]);
}

function ttsHeaders(extra: Record<string, string>, tts: TTSProvider, p: TtsParams): Record<string, string> {
  return {
    "Cache-Control": "private, no-store",
    "X-Accel-Buffering": "no",
    "X-TTS-Provider": tts.id,
    "X-TTS-Voice": p.profile.voice,
    "X-TTS-Act": p.act,
    ...extra,
  };
}

function audioResponse(clip: CachedClip, cache: string, tts: TTSProvider, p: TtsParams, synthesisMs = 0): Response {
  void recordUsage({
    service: "tts", provider: tts.id, model: tts.model ?? null, status: "ok",
    latencyMs: Math.round(synthesisMs), units: p.text.length, unitLabel: "chars",
    meta: { cache, act: p.act },
  });
  const headers: Record<string, string> = {
    "Content-Type": clip.mimeType,
    "Content-Length": String(clip.audio.byteLength),
    "X-TTS-Cache": cache,
    "X-TTS-Synthesis-Ms": String(Math.round(synthesisMs)),
    "Server-Timing": `tts;dur=${Math.round(synthesisMs)};desc="${cache}"`,
  };
  // Engine-measured word times ride along for word-anchored lip-sync.
  if (clip.words?.length) {
    headers["X-TTS-Words"] = Buffer.from(JSON.stringify(clip.words)).toString("base64");
  }
  return new Response(new Uint8Array(clip.audio), { headers: ttsHeaders(headers, tts, p) });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return chunks;
}

function mergeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const valid = signals.filter((s): s is AbortSignal => !!s);
  return valid.length === 1 ? valid[0] : AbortSignal.any(valid);
}

/** Complete buffered synthesis, used by POST prefetch and as the stream fallback. */
async function buffered(tts: TTSProvider, p: TtsParams, key: string, requestSignal?: AbortSignal): Promise<Response> {
  const started = Date.now();
  // A live stream for this exact line is already producing the clip — share it
  // instead of starting a second (duplicate) synthesis job.
  if (activeJobPriority(key) === "live") {
    const live = pendingClip(key);
    if (live) {
      await live.catch(() => {});
      const fromLive = getClip(key);
      if (fromLive) return audioResponse(fromLive, "hit", tts, p, Date.now() - started);
    }
  }
  try {
    const clip = await withInflightPriority<CachedClip>(key, "prefetch", async (jobSignal) => {
      const signal = mergeSignals(jobSignal, requestSignal);
      const r = await withTimeout(tts.id, TIMEOUTS.ttsMs, (timeoutSignal) =>
        tts.synthesize(p.text, { voice: p.profile.voice, profile: p.profile, speechAct: p.act, signal: mergeSignals(signal, timeoutSignal) }));
      const out: CachedClip = { audio: new Uint8Array(r.audio), mimeType: r.mimeType, ...(r.words?.length ? { words: r.words } : {}) };
      putClip(key, out);
      return out;
    });
    return audioResponse(clip, "miss", tts, p, Date.now() - started);
  } catch (e) {
    // A warm-up cancelled because live playback arrived is expected, not an error.
    if ((e as Error)?.name === "AbortError" || requestSignal?.aborted) {
      return Response.json({ error: "prefetch superseded by live playback", code: "tts_prefetch_cancelled" }, { status: 409 });
    }
    throw e;
  }
}

/**
 * Progressive GET stream. This path deliberately does NOT await any pending
 * prefetch: the old implementation blocked the browser's <audio> on a slow POST
 * warm-up, which is the main source of examiner voice delay.
 */
async function streaming(tts: TTSProvider, p: TtsParams, key: string, requestSignal?: AbortSignal): Promise<Response | null> {
  if (!tts.synthesizeStream) return null;

  // Another live stream is already generating this line: wait for its cached
  // result rather than creating a duplicate synthesis job for the same text.
  if (activeJobPriority(key) === "live") {
    const live = pendingClip(key);
    if (live) {
      await Promise.race([
        live.catch(() => {}),
        new Promise<void>((r) => setTimeout(r, TIMEOUTS.ttsMs * 3)),
      ]);
      const after = getClip(key);
      if (after) return audioResponse(after, "hit", tts, p);
    }
  }

  // Free the engine from a background warm-up of the same line.
  cancelPrefetchJob(key);

  const started = Date.now();
  const signal = mergeSignals(requestSignal, AbortSignal.timeout(TIMEOUTS.ttsMs * 3));
  const stream = await tts
    .synthesizeStream(p.text, { voice: p.profile.voice, profile: p.profile, speechAct: p.act, signal })
    .catch(() => null);
  if (!stream?.body) return null;

  const [client, copy] = stream.body.tee();
  // Register as a *live* job. A later POST prefetch for the same line will share
  // this collection instead of synthesising the sentence a second time.
  void withInflightPriority(key, "live", async () => {
    const chunks = await collect(copy);
    if (chunks.length) putClip(key, { audio: concatChunks(chunks), mimeType: stream.mimeType });
  }).catch(() => {});

  return new Response(client, {
    headers: ttsHeaders(
      {
        "Content-Type": stream.mimeType,
        "X-TTS-Cache": "miss-stream",
        "X-TTS-Synthesis-Ms": String(Date.now() - started),
        "Server-Timing": `tts;dur=${Date.now() - started};desc="miss-stream"`,
      },
      tts,
      p,
    ),
  });
}

/** Pick the provider: an explicit profile (Voice Lab / session snapshot) wins,
 *  otherwise the deployment default. A provider without credentials must fail
 *  loudly — never silently substitute a different voice. */
function providerFor(p: TtsParams): TTSProvider {
  return p.explicitProfile ? getTTSFor(p.profile.provider) : getTTS();
}

function onError(e: unknown): Response {
  if (e instanceof Error && /timeout|http|config/.test(e.message) && !(e instanceof HttpError)) {
    return Response.json({ error: e.message, code: "tts_failed" }, { status: 502 });
  }
  return errorResponse(e);
}

export async function GET(req: Request): Promise<Response> {
  try {
    await requireUser();
    const u = new URL(req.url);
    // Resolve the voice INSIDE the admin-config override scope: the sidecar's
    // tts.voice must win over the preset default exactly like env TTS_VOICE.
    const p = withEnvOverrides(envOverridesFor(readAiConfig(), "tts"), () => buildParams({
      text: u.searchParams.get("text"),
      voice: u.searchParams.get("voice"),
      act: u.searchParams.get("act"),
      profile: u.searchParams.get("profile") ?? undefined,
    }));
    const tts = providerFor(p);
    if (tts.location !== "server") throw new HttpError(501, "Server TTS not configured; use browser speech synthesis", "browser_tts");
    const key = keyFor(tts, p);

    const hit = getClip(key);
    if (hit) return audioResponse(hit, "hit", tts, p, 0);

    const streamed = await streaming(tts, p, key, req.signal);
    if (streamed) return streamed;
    return await buffered(tts, p, key, req.signal);
  } catch (e) {
    return onError(e);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    await requireUser();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const p = withEnvOverrides(envOverridesFor(readAiConfig(), "tts"), () => buildParams({
      text: typeof body.text === "string" ? body.text : null,
      voice: typeof body.voice === "string" ? body.voice : null,
      act: typeof body.act === "string" ? body.act : null,
      profile: body.profile,
    }));
    const tts = providerFor(p);
    if (tts.location !== "server") throw new HttpError(501, "Server TTS not configured; use browser speech synthesis", "browser_tts");
    const key = keyFor(tts, p);

    const hit = getClip(key);
    if (hit) return audioResponse(hit, "hit", tts, p, 0);
    return await buffered(tts, p, key, req.signal);
  } catch (e) {
    return onError(e);
  }
}
