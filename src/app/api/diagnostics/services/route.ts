import { getCurrentUser, errorResponse } from "@/lib/server/user";
import { managedServices, probeServiceHealth, restartManagedService } from "@/lib/server/managed-services";
import type { ServiceRestartResponse } from "@/lib/diagnostics/types";

export const dynamic = "force-dynamic";

/**
 * Managed-service status + restart for the diagnostics centre.
 *
 *  GET   → service list with a live local /health probe.
 *  POST  { id } → restart a WHITELISTED service. Real work happens only when
 *         the operator configured TTS_SERVICE_MANAGER (nssm|launchd) on the
 *         host; the command is a fixed literal (no user input), the attempt is
 *         audit-logged, and success is verified against /health — the API never
 *         reports a fake "restarted". Without a manager the response carries
 *         the manual steps from docs/tts-engine-deployment.md instead.
 *
 * Third-party cloud APIs (Azure, Tencent) deliberately have no restart action:
 * this app cannot restart someone else's service, and pretending otherwise
 * would be a false status.
 */
export async function GET() {
  try {
    const services = await Promise.all(managedServices().map(async (s) => {
      if (!s.healthUrl) return { ...s, healthy: null, detail: "Not a Kokoro deployment — no local engine health endpoint." };
      const h = await probeServiceHealth(s.id);
      return { ...s, healthy: h.healthy, detail: h.detail, latencyMs: h.latencyMs };
    }));
    return Response.json({ services });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "No session cookie. Reload the page." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as { id?: string };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return Response.json({ error: "service id required" }, { status: 400 });

    const known = managedServices().find((s) => s.id === id);
    if (!known) return Response.json({ error: "unknown service id" }, { status: 400 });

    const r = await restartManagedService(id, `user:${user.id}`);
    const response: ServiceRestartResponse & { detail: string } = {
      ok: r.ok,
      phase: r.phase,
      detail: r.detail,
    };
    return Response.json(response);
  } catch (e) {
    return errorResponse(e);
  }
}
