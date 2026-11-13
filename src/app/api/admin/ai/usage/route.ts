import { errorResponse, HttpError } from "@/lib/server/user";
import { getUsageSummary } from "@/lib/server/ai-usage";

export const dynamic = "force-dynamic";

/** When ADMIN_TOKEN is set, usage data requires the matching x-admin-token header. */
function assertAdmin(req: Request) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return; // local development mode
  if (req.headers.get("x-admin-token") !== expected) throw new HttpError(401, "Admin token required", "admin_unauthorized");
}

/** GET → aggregated consumption per AI service + the 20 most recent calls. */
export async function GET(req: Request) {
  try {
    assertAdmin(req);
    const summary = await getUsageSummary();
    return Response.json(summary);
  } catch (e) {
    return errorResponse(e);
  }
}
