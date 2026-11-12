import { requireUser, errorResponse, HttpError } from "@/lib/server/user";
import { submitAnswer } from "@/lib/server/exam-service";

export async function POST(req: Request, ctx: RouteContext<"/api/speaking/sessions/[id]/answers">) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const len = Number(req.headers.get("content-length") || 0);
    if (len > 60 * 1024 * 1024) throw new HttpError(413, "Upload too large");
    const form = await req.formData().catch(() => {
      throw new HttpError(400, "Expected multipart/form-data");
    });
    const r = await submitAnswer(user, id, form);
    return Response.json(r, { status: r.duplicate ? 200 : 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
