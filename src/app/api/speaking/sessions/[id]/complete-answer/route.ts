import { requireUser, errorResponse, HttpError } from "@/lib/server/user";
import { completeAnswer } from "@/lib/server/exam-service";

/**
 * POST /api/speaking/sessions/:id/complete-answer
 * multipart: examQuestionId, idempotencyKey, durationMs, fromStep,
 *            audio?, wav?, browserTranscript?
 *
 * One request commits the answer AND advances the state machine, returning the
 * full next-step view. The legacy /answers and /advance endpoints remain intact.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/speaking/sessions/[id]/complete-answer">) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const len = Number(req.headers.get("content-length") || 0);
    if (len > 60 * 1024 * 1024) throw new HttpError(413, "Upload too large");
    const form = await req.formData().catch(() => {
      throw new HttpError(400, "Expected multipart/form-data");
    });
    const r = await completeAnswer(user, id, form);
    // 201 for a newly stored answer, 200 for an idempotent retry — same as /answers.
    return Response.json(r, { status: r.answer.duplicate ? 200 : 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
