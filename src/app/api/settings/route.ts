import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireUser, errorResponse, HttpError } from "@/lib/server/user";
import { normalizeGender, normalizeModelId } from "@/lib/avatar/models";

export async function PUT(req: Request) {
  try {
    const user = await requireUser();
    const b = (await req.json().catch(() => ({}))) as { displayName?: string; targetBand?: number; examDate?: string | null; examinerVoice?: string; examinerGender?: string; examinerModel?: string; digitalHuman3d?: boolean; showSubtitles?: boolean };
    const patch: Partial<typeof users.$inferInsert> = {};
    if (b.displayName !== undefined) patch.displayName = String(b.displayName).slice(0, 60) || "Candidate";
    if (b.targetBand !== undefined) {
      const t = Number(b.targetBand);
      if (!(t >= 4 && t <= 9) || (t * 2) % 1 !== 0) throw new HttpError(400, "targetBand must be 4–9 in half bands");
      patch.targetBand = t;
    }
    if (b.examDate !== undefined) patch.examDate = b.examDate && /^\d{4}-\d{2}-\d{2}$/.test(b.examDate) ? b.examDate : null;
    if (b.examinerVoice !== undefined) patch.examinerVoice = String(b.examinerVoice).slice(0, 120);
    if (b.examinerGender !== undefined) patch.examinerGender = b.examinerGender === "male" ? "male" : "female";
    if (b.examinerModel !== undefined) {
      const gender = patch.examinerGender ?? user.examinerGender;
      patch.examinerModel = normalizeModelId(b.examinerModel, normalizeGender(gender));
    }
    if (b.digitalHuman3d !== undefined) patch.digitalHuman3d = !!b.digitalHuman3d;
    if (b.showSubtitles !== undefined) patch.showSubtitles = !!b.showSubtitles;
    const [u] = await db.update(users).set(patch).where(eq(users.id, user.id)).returning();
    return Response.json({ ok: true, user: { displayName: u.displayName, targetBand: u.targetBand, examDate: u.examDate, examinerVoice: u.examinerVoice, examinerGender: u.examinerGender, examinerModel: u.examinerModel, digitalHuman3d: u.digitalHuman3d, showSubtitles: u.showSubtitles } });
  } catch (e) {
    return errorResponse(e);
  }
}
