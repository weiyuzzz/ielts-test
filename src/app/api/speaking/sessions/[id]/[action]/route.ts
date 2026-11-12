import { requireUser, errorResponse, HttpError } from "@/lib/server/user";
import { advance, repeatQuestion, finishSession, abandonSession, retryScoring, loadOwned } from "@/lib/server/exam-service";
import { getReport } from "@/lib/server/report-service";

/** POST advance | repeat | finish | abandon | report(retry scoring) */
export async function POST(req: Request, ctx: RouteContext<"/api/speaking/sessions/[id]/[action]">) {
  try {
    const user = await requireUser();
    const { id, action } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { fromStep?: number; examQuestionId?: string };
    switch (action) {
      case "advance":
        if (typeof body.fromStep !== "number") throw new HttpError(400, "fromStep required");
        return Response.json(await advance(user, id, body.fromStep));
      case "repeat":
        return Response.json(await repeatQuestion(user, id, String(body.examQuestionId || "")));
      case "finish":
        return Response.json(await finishSession(user, id));
      case "abandon":
        return Response.json(await abandonSession(user, id));
      case "report":
        return Response.json(await retryScoring(user, id));
      default:
        throw new HttpError(404, "Unknown action");
    }
  } catch (e) {
    return errorResponse(e);
  }
}

export async function GET(_req: Request, ctx: RouteContext<"/api/speaking/sessions/[id]/[action]">) {
  try {
    const user = await requireUser();
    const { id, action } = await ctx.params;
    if (action !== "report") throw new HttpError(404, "Unknown action");
    await loadOwned(user, id);
    const r = await getReport(id);
    if (!r) throw new HttpError(404, "No assessment yet");
    return Response.json(r);
  } catch (e) {
    return errorResponse(e);
  }
}
