import { db } from "@/db";
import { audioAssets } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { requireUser, errorResponse, HttpError } from "@/lib/server/user";
import { readAudio } from "@/lib/server/storage";

/** Streams a user's own recording. Supports Range requests (required by Safari for <audio>). */
export async function GET(req: Request, ctx: RouteContext<"/api/audio/[id]">) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "Not found");
    const [a] = await db.select().from(audioAssets).where(and(eq(audioAssets.id, id), eq(audioAssets.userId, user.id))).limit(1);
    if (!a) throw new HttpError(404, "Not found");
    const buf = await readAudio(a.storageKey);
    const type = a.mimeType.split(";")[0];
    const range = req.headers.get("range");
    const m = range?.match(/bytes=(\d*)-(\d*)/);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
      if (start > end || start >= buf.length) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${buf.length}` } });
      return new Response(new Uint8Array(buf.subarray(start, end + 1)), {
        status: 206,
        headers: { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${buf.length}`, "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1), "Cache-Control": "private, max-age=3600" },
      });
    }
    return new Response(new Uint8Array(buf), { headers: { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": String(buf.length), "Cache-Control": "private, max-age=3600" } });
  } catch (e) {
    return errorResponse(e);
  }
}
