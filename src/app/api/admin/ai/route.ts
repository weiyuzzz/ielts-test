import { errorResponse, HttpError } from "@/lib/server/user";
import { publicAiConfig, writeAiConfig, type AiConfigPatch } from "@/lib/server/ai-config";

export const dynamic = "force-dynamic";

/** When ADMIN_TOKEN is set, writes require the matching x-admin-token header. */
function assertAdmin(req: Request, write = false) {
  if (!write) return;
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return; // local development mode
  if (req.headers.get("x-admin-token") !== expected) throw new HttpError(401, "Admin token required", "admin_unauthorized");
}

/** GET → current AI provider config (API keys masked). */
export async function GET() {
  try {
    return Response.json({ config: publicAiConfig(), protected: !!process.env.ADMIN_TOKEN });
  } catch (e) {
    return errorResponse(e);
  }
}

/** PUT → merge a patch and persist. Omit apiKey to keep the stored one. */
export async function PUT(req: Request) {
  try {
    assertAdmin(req, true);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new HttpError(400, "JSON body required");
    writeAiConfig(body as AiConfigPatch);
    return Response.json({ config: publicAiConfig() });
  } catch (e) {
    return errorResponse(e);
  }
}
