import { requireUser, errorResponse } from "@/lib/server/user";
import { getSessionView } from "@/lib/server/exam-service";

export async function GET(_req: Request, ctx: RouteContext<"/api/speaking/sessions/[id]">) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    return Response.json(await getSessionView(user, id));
  } catch (e) {
    return errorResponse(e);
  }
}
