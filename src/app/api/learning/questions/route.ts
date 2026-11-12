import { errorResponse, requireUser } from "@/lib/server/user";
import { activeLearningLibrary } from "@/lib/server/queries";
import { decideFollowAudio } from "@/lib/content/audio-policy";
import { getASR } from "@/lib/ai/registry";

export const dynamic = "force-dynamic";

/**
 * Question + study material for one topic — the data source of /speaking/practice.
 *
 *   GET /api/learning/questions?topicKey=hometown&part=1
 *
 * Study-only endpoint. The exam never calls it, which is one of the reasons a
 * mock test cannot display a sample answer.
 */
export async function GET(req: Request) {
  try {
    await requireUser();
    const url = new URL(req.url);
    const topicKey = url.searchParams.get("topicKey") || "";
    const partParam = url.searchParams.get("part");
    const part = partParam ? Number(partParam) : null;

    const library = await activeLearningLibrary();
    const questions = library.questions
      .filter((q) => (!topicKey || q.topicKey === topicKey) && (!part || q.part === part))
      .map((q) => ({
        id: q.id,
        part: q.part,
        topic: q.topic,
        topicKey: q.topicKey,
        topicZh: q.topicZh,
        text: q.text,
        textZh: q.textZh,
        cuePoints: q.cuePoints ?? [],
        learning: q.learning,
        followAudio: decideFollowAudio(q.learning.followAudio),
      }));

    const asr = getASR();
    return Response.json({
      season: library.season,
      region: library.region,
      questions,
      asr: asr && asr.location === "server" ? { available: true, id: asr.id } : { available: false, id: asr?.id ?? null },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
