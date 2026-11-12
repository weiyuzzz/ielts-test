import { getTTS, getTTSFor, TIMEOUTS } from "@/lib/ai/registry";
import { withTimeout, type TTSProvider } from "@/lib/ai/types";
import { requireUser, errorResponse, HttpError } from "@/lib/server/user";
import { concatChunks, getClip, pendingClip, putClip, ttsCacheKey, withInflight, type CachedClip } from "@/lib/server/tts-cache";
import { isSpeechAct, type ExaminerSpeechAct } from "@/lib/speaking/speech-act";
import { profileFingerprint, resolveVoiceProfile, sanitizeProfile, type VoiceProfile } from "@/lib/speaking/voice-profile";

/**
 * Examiner TTS proxy (keeps API keys on the server).
 *
 *  GET  /api/tts?text=…&voice=…&act=question&profile=azure-sonia
 *  POST /api/tts { text, voice, act, profile }
 *       `profile` may be a preset id ("azure-sonia"), "provider:voice"
 *       ("azure:en-GB-RyanNeural") or a full VoiceProfile object (Voice Lab).
 *
 * GET streams sentence by sentence on engines that support it, so playback
 * starts at the first sentence. POST always returns complete audio.
 *
 * The cache key includes the profile fingerprint (provider, voice, language,
 * speed, pitch, style, instructions, prosody, format) plus the speech act, so
 * changing the voice can never serve a clip generated for another one.
 */
export const dynamic = "force-dynamic";

const MAX_TEXT = 1500;

interface TtsRequest {
  text: string;
  profile: VoiceProfile;
  act: ExaminerSpeechAct;
  /** True when the caller chose a profile explicitly (Voice Lab), which also
   *  selects the provider instead of following the deployment's default. */
  explicitProfile: boolean;
}

function parseText(text?: string | null): string {
  if (!text || !text.trim()) throw new HttpError(400, "text required (max 1500 chars)");
  if (text.length > MAX_TEXT) throw new HttpError(400, "text too long (max 1500 chars)");
  return text.trim();
}

function buildRequest(input: { text?: string | null; voice?: string | null; act?: string | null; profile?: unknown }): TtsRequest {
  const text = parseText(input.text);
  const explicitProfile = input.profile !== undefined && input.profile !== null && input.profile !== "";
  let profile: VoiceProfile;
  if (explicitProfile) {
    profile = typeof input.profile === "string" ? resolveVoiceProfile(input.profile) : sanitizeProfile(input.profile);
  } else {
    profile = resolveVoiceProfile(input.voice);
  }
  const act: ExaminerSpeechAct = isSpeechAct(input.act) ? input.act : "question";
  return { text, profile, act, explicitProfile };
}

function keyFor(tts: TTSProvider, model: string | undefined, req: TtsRequest, format: string): string {
  return ttsCacheKey([
    tts.id,
    model,
    profileFingerprint(req.profile, req.act, format),
    req.text,
  ]);
}

function baseHeaders(extra: Record<string, string>): Record<string, string> {
  return {
    "Cache-Control": "private, no-store",
    "X-Accel-Buffering": "no",
    ...extra,
  };
}

function audioResponse(clip: CachedClip, cache: string, tts: TTSProvider, req: TtsRequest): Response {
  return new Response(new Uint8Array(clip.audio), {
    headers: baseHeaders({
      "Content-Type": clip.mimeType,
      "Content-Length": String(clip.audio.byteLength),
      "X-TTS-Cache": cache,
      "X-TTS-Provider": tts.id,
      "X-TTS-Voice": req.profile.voice,
      "X-TTS-Act": req.act,
    }),
  });
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

async function buffered(tts: TTSProvider, req: TtsRequest, key: string): Promise<Response> {
  const clip = await withInflight(key, async () => {
    const r = await withTimeout(tts.id, TIMEOUTS.ttsMs, (signal) =>
      tts.synthesize(req.text, { voice: req.profile.voice, profile: req.profile, speechAct: req.act, signal }),
    );
    const out: CachedClip = { audio: new Uint8Array(r.audio), mimeType: r.mimeType };
    putClip(key, out);
    return out;
  });
  return audioResponse(clip, "miss", tts, req);
}

async function handle(req: TtsRequest, allowStream: boolean): Promise<Response> {
  await requireUser();
  const format = process.env.TTS_FORMAT || "mp3";
  const tts = req.explicitProfile ? getTTSFor(req.profile.provider) : getTTS();
  if (tts.location !== "server") throw new HttpError(501, "Server TTS not configured; use browser speech synthesis", "browser_tts");

  const key = keyFor(tts, tts.model, req, format);

  const hit = getClip(key);
  if (hit) return audioResponse(hit, "hit", tts, req);

  // Another request is already synthesising this exact line — wait for it and
  // serve the finished clip rather than starting a second expensive job.
  const pending = pendingClip(key);
  if (pending) {
    await pending.catch(() => {});
    const after = getClip(key);
    if (after) return audioResponse(after, "hit", tts, req);
  }

  if (allowStream && tts.synthesizeStream) {
    const stream = await tts
      .synthesizeStream(req.text, { voice: req.profile.voice, profile: req.profile, speechAct: req.act, signal: AbortSignal.timeout(TIMEOUTS.ttsMs * 3) })
      .catch(() => null);
    if (stream?.body) {
      const [client, copy] = stream.body.tee();
      // Keep the in-flight slot until the whole clip has been buffered.
      void withInflight(key, async () => {
        const chunks = await collect(copy);
        if (chunks.length) putClip(key, { audio: concatChunks(chunks), mimeType: stream.mimeType });
      }).catch(() => {});
      return new Response(client, {
        headers: baseHeaders({
          "Content-Type": stream.mimeType,
          "X-TTS-Cache": "miss-stream",
          "X-TTS-Provider": tts.id,
          "X-TTS-Voice": req.profile.voice,
          "X-TTS-Act": req.act,
        }),
      });
    }
  }

  return buffered(tts, req, key);
}

function onError(e: unknown): Response {
  if (e instanceof Error && /timeout|http|config/.test(e.message) && !(e instanceof HttpError)) {
    return Response.json({ error: e.message, code: "tts_failed" }, { status: 502 });
  }
  return errorResponse(e);
}

export async function GET(req: Request): Promise<Response> {
  try {
    const u = new URL(req.url);
    return await handle(
      buildRequest({
        text: u.searchParams.get("text"),
        voice: u.searchParams.get("voice"),
        act: u.searchParams.get("act"),
        profile: u.searchParams.get("profile") ?? undefined,
      }),
      true,
    );
  } catch (e) {
    return onError(e);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return await handle(
      buildRequest({
        text: typeof body.text === "string" ? body.text : null,
        voice: typeof body.voice === "string" ? body.voice : null,
        act: typeof body.act === "string" ? body.act : null,
        profile: body.profile,
      }),
      false,
    );
  } catch (e) {
    return onError(e);
  }
}
