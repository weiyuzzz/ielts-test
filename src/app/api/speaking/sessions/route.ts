import { db } from "@/db";
import { examSessions, assessments } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { requireUser, errorResponse, HttpError } from "@/lib/server/user";
import { createSession } from "@/lib/server/exam-service";
import type { SpeakingMode } from "@/lib/speaking/config";

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = (await req.json().catch(() => ({}))) as { mode?: string };
    const mode = body.mode as SpeakingMode;
    if (!["full", "part1", "part2", "part3"].includes(mode)) throw new HttpError(400, "mode must be full|part1|part2|part3");
    const s = await createSession(user, mode);
    return Response.json({ id: s.id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function GET() {
  try {
    const user = await requireUser();
    const rows = await db.select().from(examSessions).where(eq(examSessions.userId, user.id)).orderBy(desc(examSessions.startedAt)).limit(100);
    const out = [];
    for (const r of rows) {
      const [a] = await db.select({ status: assessments.status, overallBand: assessments.overallBand }).from(assessments).where(eq(assessments.sessionId, r.id)).orderBy(desc(assessments.startedAt)).limit(1);
      out.push({ id: r.id, mode: r.mode, status: r.status, startedAt: r.startedAt, completedAt: r.completedAt, assessment: a ?? null });
    }
    return Response.json({ sessions: out });
  } catch (e) {
    return errorResponse(e);
  }
}
