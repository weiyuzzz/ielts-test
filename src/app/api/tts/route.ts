import { getTTS, TIMEOUTS } from "@/lib/ai/registry";
import { withTimeout } from "@/lib/ai/types";
import { requireUser, errorResponse, HttpError } from "@/lib/server/user";
import { concatChunks, getClip, pendingClip, putClip, ttsCacheKey, withInflight, type CachedClip } from "@/lib/server/tts-cache";

/**
 * Examiner TTS proxy (keeps API keys on the server).
 *
 *  GET  /api/tts?text=…&voice=…  → progressive audio; compatible engines stream
 *                                  sentence by sentence, so the browser starts
 *                                  playing at the first sentence.
 *  POST /api/tts {text, voice}    → complete audio (kept for compatibility).
 *
 * Both paths share an LRU cache keyed by everything that changes the waveform,
 * so repeated lines (fixed script, reloads, "Test voice") are served instantly.
 * Returns 501 when the browser TTS provider is active.
 */
export const dynamic = "force-dynamic";

const MAX_TEXT = 1500;

interface TtsParams { text: string; voice: string }

function parse(text?: string | null, voice?: string | null): TtsParams {
  if (!text || !text.trim()) throw new HttpError(400, "text required (max 1500 chars)");
  if (text.length > MAX_TEXT) throw new HttpError(400, "text too long (max 1500 chars)");
  return { text: text.trim(), voice: voice || "auto" };
}

function keyFor(ttsId: string, model: string | undefined, p: TtsParams): string {
  return ttsCacheKey([
    ttsId, model, p.voice, p.text,
    process.env.TTS_MODEL, process.env.TTS_FORMAT, process.env.TTS_SPEED,
    process.env.TTS_PROSODY, process.env.TTS_INSTRUCTIONS,
    process.env.AZURE_TTS_VOICE, process.env.AZURE_TTS_FORMAT,
  ]);
}

function audioResponse(clip: CachedClip, cache: string): Response {
  return new Response(new Uint8Array(clip.audio), {
    headers: {
      "Content-Type": clip.mimeType,
      "Content-Length": String(clip.audio.byteLength),
      "Cache-Control": "private, no-store",
      "X-TTS-Cache": cache,
      "X-Accel-Buffering": "no",
    },
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

async function buffered(tts: ReturnType<typeof getTTS>, p: TtsParams, key: string): Promise<Response> {
  const clip = await withInflight(key, async () => {
    const r = await withTimeout(tts.id, TIMEOUTS.ttsMs, (signal) => tts.synthesize(p.text, { voice: p.voice, signal }));
    const out: CachedClip = { audio: new Uint8Array(r.audio), mimeType: r.mimeType };
    putClip(key, out);
    return out;
  });
  return audioResponse(clip, "miss");
}

async function handle(p: TtsParams, allowStream: boolean): Promise<Response> {
  await requireUser();
  const tts = getTTS();
  if (tts.location !== "server") throw new HttpError(501, "Server TTS not configured; use browser speech synthesis", "browser_tts");
  const key = keyFor(tts.id, tts.model, p);

  const hit = getClip(key);
  if (hit) return audioResponse(hit, "hit");

  // Another request is already synthesising this exact line — wait for it and
  // serve the finished clip rather than starting a second expensive job.
  const pending = pendingClip(key);
  if (pending) {
    await pending.catch(() => {});
    const after = getClip(key);
    if (after) return audioResponse(after, "hit");
  }

  if (allowStream && tts.synthesizeStream) {
    const stream = await tts
      .synthesizeStream(p.text, { voice: p.voice, signal: AbortSignal.timeout(TIMEOUTS.ttsMs * 3) })
      .catch(() => null);
    if (stream?.body) {
      const [client, copy] = stream.body.tee();
      // Keep the in-flight slot until the whole clip has been buffered.
      void withInflight(key, async () => {
        const chunks = await collect(copy);
        if (chunks.length) putClip(key, { audio: concatChunks(chunks), mimeType: stream.mimeType });
      }).catch(() => {});
      return new Response(client, {
        headers: {
          "Content-Type": stream.mimeType,
          "Cache-Control": "private, no-store",
          "X-TTS-Cache": "miss-stream",
          "X-Accel-Buffering": "no",
        },
      });
    }
  }

  return buffered(tts, p, key);
}

function onError(e: unknown): Response {
  if (e instanceof Error && /timeout|http/.test(e.message) && !(e instanceof HttpError)) {
    return Response.json({ error: e.message, code: "tts_failed" }, { status: 502 });
  }
  return errorResponse(e);
}

export async function GET(req: Request): Promise<Response> {
  try {
    const u = new URL(req.url);
    return await handle(parse(u.searchParams.get("text"), u.searchParams.get("voice")), true);
  } catch (e) {
    return onError(e);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as { text?: string; voice?: string };
    return await handle(parse(body.text, body.voice), false);
  } catch (e) {
    return onError(e);
  }
}
