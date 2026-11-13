import { getCurrentUser, errorResponse } from "@/lib/server/user";
import { getASR, TIMEOUTS } from "@/lib/ai/registry";
import { withTimeout } from "@/lib/ai/types";
import { recordUsage } from "@/lib/server/ai-usage";
import { classifyProviderFailure, type AsrDiagnosticResponse } from "@/lib/diagnostics/types";

export const dynamic = "force-dynamic";

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/**
 * Real ASR transcription probe for the diagnostics centre.
 *
 * The client records ~4–6 s, sends the audio here; the CURRENT ASR provider
 * (OpenAI-compatible Whisper, Tencent ASR — whatever the registry resolves)
 * transcribes it. The audio is NEVER written to the exam tables, the storage
 * tree, or any answer record — it lives in memory for the duration of the
 * request only. The response tells the UI exactly which third-party service
 * received the audio so the page can disclose it.
 */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "No session cookie. Reload the page." }, { status: 401 });

    const form = await req.formData().catch(() => null);
    const file = form?.get("audio");
    if (!(file instanceof Blob) || !file.size) {
      return Response.json({ error: "audio file missing" }, { status: 400 });
    }
    if (file.size > MAX_AUDIO_BYTES) {
      return Response.json({ error: "audio too large for a diagnostics probe (max 8 MB)" }, { status: 413 });
    }
    const mime = String(form?.get("mime") || file.type || "audio/webm");

    const asr = getASR();
    const fail = (status: AsrDiagnosticResponse["status"], message: string): Response =>
      Response.json({ status, provider: null, model: null, message, uploadedTo: null } satisfies AsrDiagnosticResponse, { status: 200 });

    if (!asr) return fail("not_configured", "No ASR provider is configured.");
    if (asr.location === "browser") {
      return fail("not_configured", "The active ASR provider runs in the browser (Web Speech) — use the browser check; there is nothing to upload.");
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const t0 = Date.now();
    try {
      const r = await withTimeout(asr.id, TIMEOUTS.asrMs, (signal) => asr.transcribe(buf, mime, { signal }));
      const latencyMs = Date.now() - t0;
      void recordUsage({
        service: "asr", provider: asr.id, model: asr.model ?? null, status: "ok",
        latencyMs: Math.round(latencyMs), units: buf.byteLength, unitLabel: "bytes",
        meta: { probe: "diagnostics" },
      });
      const text = (r.text ?? "").trim();
      const response: AsrDiagnosticResponse = {
        status: text ? "ready" : "failed",
        provider: asr.id,
        model: asr.model ?? null,
        message: text
          ? `Transcribed in ${(latencyMs / 1000).toFixed(1)} s.`
          : "The provider answered but returned EMPTY text — the audio may be silent or unsupported.",
        ...(text ? { text } : {}),
        latencyMs,
        uploadedTo: asr.id,
      };
      return Response.json(response);
    } catch (e) {
      const c = classifyProviderFailure(asr.id, e);
      void recordUsage({
        service: "asr", provider: asr.id, model: asr.model ?? null, status: "failed",
        latencyMs: Date.now() - t0, units: buf.byteLength, unitLabel: "bytes",
        meta: { probe: "diagnostics", kind: c.kind },
      });
      const response: AsrDiagnosticResponse = {
        status: c.status === "degraded" ? "failed" : c.status,
        provider: asr.id,
        model: asr.model ?? null,
        message: `Transcription failed (${c.kind}).`,
        detail: c.message,
        latencyMs: Date.now() - t0,
        uploadedTo: asr.id,
      };
      return Response.json(response);
    }
  } catch (e) {
    return errorResponse(e);
  }
}
