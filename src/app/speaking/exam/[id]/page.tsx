import { getCurrentUser } from "@/lib/server/user";
import { capabilities } from "@/lib/ai/registry";
import { ExamRunner } from "./exam-runner";

export const dynamic = "force-dynamic";

export default async function ExamPage({ params }: PageProps<"/speaking/exam/[id]">) {
  const { id } = await params;
  const user = await getCurrentUser();
  const caps = capabilities();
  return (
    <ExamRunner
      sessionId={id}
      voice={user?.examinerVoice ?? "auto"}
      showSubtitlesDefault={user?.showSubtitles ?? true}
      serverTts={caps.tts.location === "server"}
      browserAsr={caps.asr?.location === "browser"}
      asrAvailable={!!caps.asr}
    />
  );
}
