import { getCurrentUser, errorResponse } from "@/lib/server/user";
import { getPronunciation, TIMEOUTS } from "@/lib/ai/registry";
import { withTimeout } from "@/lib/ai/types";
import { recordUsage } from "@/lib/server/ai-usage";
import {
  classifyProviderFailure, inspectWavHeader,
  type PronunciationDiagnosticResponse,
} from "@/lib/diagnostics/types";

export const dynamic = "force-dynamic";

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
/** Known reference text so the result can be judged against an expected script. */
const TEST_REFERENCE = "Hello. My name is Sarah, and I will be your examiner today.";

/**
 * Real pronunciation-assessment probe for the diagnostics centre.
 *
 * Accepts a 16 kHz mono PCM WAV (exactly what RecordingSession produces, so the
 * ASR test recording is REUSED — the user never records twice), sends it to the
 * configured Azure / Tencent SOE provider and reports whether the raw
 * availability metrics (Accuracy / Fluency / Prosody / Completeness + words)
 * come back.
 *
 * Rules enforced here (see the spec):
 *  - provider 0–100 numbers are SERVICE AVAILABILITY evidence, not IELTS bands;
 *  - the test sample is never persisted as a user result (no DB writes);
 *  - no ASR text is ever used to infer a pronunciation score.
 */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "No session cookie. Reload the page." }, { status: 401 });

    const form = await req.formData().catch(() => null);
    const file = form?.get("wav");
    if (!(file instanceof Blob) || !file.size) {
      return Response.json({ error: "wav file missing" }, { status: 400 });
    }
    if (file.size > MAX_AUDIO_BYTES) {
      return Response.json({ error: "audio too large for a diagnostics probe (max 8 MB)" }, { status: 413 });
    }
    const reference = String(form?.get("referenceText") || TEST_REFERENCE).slice(0, 3000);

    const pron = getPronunciation();
    if (!pron) {
      return Response.json({
        status: "not_configured",
        provider: null,
        message: "Not configured — P criterion unavailable.",
        uploadedProvider: null,
      } satisfies PronunciationDiagnosticResponse);
    }

    const buf = new Uint8Array(await file.arrayBuffer());
    const wav = inspectWavHeader(buf);
    if (!wav.ok) {
      return Response.json({
        status: "failed",
        provider: pron.id,
        message: "Unavailable — pronunciation assessment failed.",
        detail: `Audio format check failed: ${wav.detail}. The provider requires 16 kHz mono 16-bit PCM WAV — the microphone test in this panel produces exactly that.`,
        formatOk: false,
        formatDetail: wav.detail,
        uploadedProvider: null,
      });
    }

    const t0 = Date.now();
    try {
      const r = await withTimeout(pron.id, TIMEOUTS.pronMs, (signal) => pron.assess(Buffer.from(buf), reference, { signal }));
      const latencyMs = Date.now() - t0;
      void recordUsage({
        service: "pronunciation", provider: pron.id, status: "ok",
        latencyMs: Math.round(latencyMs), units: buf.byteLength, unitLabel: "bytes",
        meta: { probe: "diagnostics", referenceWords: reference.split(/\s+/).length },
      });
      const hasMetrics = Number.isFinite(r.accuracy) && Number.isFinite(r.fluency) && Number.isFinite(r.overall);
      return Response.json({
        status: hasMetrics ? "ready" : "failed",
        provider: pron.id,
        message: hasMetrics
          ? `Assessment completed in ${(latencyMs / 1000).toFixed(1)} s — availability metrics returned (NOT IELTS bands).`
          : "Unavailable — pronunciation assessment failed.",
        detail: hasMetrics ? undefined : "The provider response was missing Accuracy/Fluency scores.",
        latencyMs,
        ...(hasMetrics ? {
          metrics: { accuracy: r.accuracy, fluency: r.fluency, prosody: r.prosody, completeness: r.completeness, overall: r.overall },
          words: r.words?.slice(0, 20).map((w) => ({ word: w.word, accuracy: w.accuracy, errorType: w.errorType })),
        } : {}),
        formatOk: true,
        formatDetail: wav.detail,
        uploadedProvider: pron.id,
      });
    } catch (e) {
      const c = classifyProviderFailure(pron.id, e);
      void recordUsage({
        service: "pronunciation", provider: pron.id, status: "failed",
        latencyMs: Date.now() - t0, units: buf.byteLength, unitLabel: "bytes",
        meta: { probe: "diagnostics", kind: c.kind },
      });
      return Response.json({
        status: c.status === "degraded" ? "failed" : c.status,
        provider: pron.id,
        message: c.status === "not_configured"
          ? "Not configured — P criterion unavailable."
          : "Unavailable — pronunciation assessment failed.",
        detail: c.message,
        latencyMs: Date.now() - t0,
        formatOk: true,
        formatDetail: wav.detail,
        uploadedProvider: pron.id,
      });
    }
  } catch (e) {
    return errorResponse(e);
  }
}
