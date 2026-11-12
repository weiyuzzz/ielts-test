import { requireUser, errorResponse, HttpError } from "@/lib/server/user";
import { buildTrackForText } from "@/lib/lipsync/g2p";

/**
 * Viseme timeline for lip-sync (text → relative-time track).
 *
 * The track is generated from TEXT only (phonemes + duration tables); the
 * client warps it onto the real audio clock (word anchors / audio duration).
 * Engine-measured word timestamps travel with the audio itself
 * (`X-TTS-Words` on /api/tts), this endpoint only supplies the content.
 *
 * POST { text, lang?: "en-GB" } → { track: VisemeTrack }
 */
export const dynamic = "force-dynamic";

const MAX_TEXT = 1500;

export async function POST(req: Request): Promise<Response> {
  try {
    await requireUser();
    const body = (await req.json().catch(() => ({}))) as { text?: unknown; lang?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text || text.length > MAX_TEXT) throw new HttpError(400, "text required (max 1500 chars)");
    const lang = body.lang === "en-US" ? "a" : "b";
    const track = await buildTrackForText(text, { lang });
    return Response.json(
      { track },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
