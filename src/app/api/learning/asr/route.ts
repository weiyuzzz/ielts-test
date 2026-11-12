import { getASR, TIMEOUTS } from "@/lib/ai/registry";
import { withTimeout } from "@/lib/ai/types";
import { errorResponse, HttpError, requireUser } from "@/lib/server/user";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Shadowing transcription.
 *
 *   POST /api/learning/asr   (multipart: audio=<wav|webm>, hint=<reference text>)
 *
 * Contract — degradation is part of the contract, not an afterthought:
 *   200 { status: "ok", text, provider }          transcribed
 *   200 { status: "unavailable", reason }         no server ASR configured
 *   200 { status: "failed", error }               provider refused / timed out
 *   400 invalid_audio                             nothing usable was uploaded
 *
 * A 200 with a status field is deliberate: a missing ASR key must not look like
 * a broken page. The client keeps the recording playable either way.
 *
 * The audio is transcribed in memory and then dropped. Nothing is written to
 * `answer_records` / `audio_assets` — a practice take is not exam evidence.
 */
export async function POST(req: Request) {
  try {
    await requireUser();
    const form = await req.formData().catch(() => null);
    if (!form) throw new HttpError(400, "multipart/form-data required", "invalid_request");
    const file = form.get("audio");
    if (!(file instanceof Blob) || !file.size) throw new HttpError(400, "audio file required", "invalid_audio");
    if (file.size > MAX_BYTES) throw new HttpError(413, "audio is too large for practice transcription", "audio_too_large");

    const asr = getASR();
    if (!asr || asr.location !== "server") {
      return Response.json({
        status: "unavailable",
        reason: "未配置服务端语音识别（ASR_PROVIDER / OPENAI_API_KEY）。录音与回放仍然可用，转写对比暂不可用。",
      });
    }

    const hint = String(form.get("hint") || "").slice(0, 600);
    const started = Date.now();
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      const mime = file.type || "audio/wav";
      const result = await withTimeout(asr.id, TIMEOUTS.asrMs, (signal) =>
        asr.transcribe(buf, mime, { signal, prompt: hint || undefined }),
      );
      if (!result.text?.trim()) {
        return Response.json({ status: "failed", error: "识别结果为空，可能录音太短或环境太吵。" });
      }
      return Response.json({
        status: "ok",
        text: result.text,
        provider: asr.id,
        model: asr.model ?? null,
        confidence: result.confidence ?? null,
        latencyMs: Date.now() - started,
      });
    } catch (e) {
      return Response.json({ status: "failed", error: (e as Error).message.slice(0, 300) });
    }
  } catch (e) {
    return errorResponse(e);
  }
}
