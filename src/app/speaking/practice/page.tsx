import { ensureSeed } from "@/lib/server/seed";
import { practiceTopics } from "@/lib/server/queries";
import { PageHeader } from "@/components/ui";
import { capabilities } from "@/lib/ai/registry";
import { envDefaultProfile } from "@/lib/speaking/voice-profile";
import { ShadowingStudio } from "./shadowing-studio";

export const dynamic = "force-dynamic";

export default async function Practice({
  searchParams,
}: {
  searchParams: Promise<{ topicKey?: string; part?: string; q?: string }>;
}) {
  await ensureSeed();
  const params = await searchParams;
  const { season, topics } = await practiceTopics();
  const profile = envDefaultProfile();
  const serverTts = capabilities().tts.id !== "browser-speech-synthesis";

  return (
    <>
      <PageHeader
        title="Shadowing practice"
        subtitle="Shadow sample answers: listen first, record yourself, then compare. Transcript differences are reference only — not a pronunciation diagnosis and not part of your IELTS score."
      />
      <ShadowingStudio
        topics={topics}
        season={season}
        profile={profile}
        serverTts={serverTts}
        initial={{
          topicKey: params.topicKey,
          part: params.part ? Number(params.part) : undefined,
          questionId: params.q ? Number(params.q) : undefined,
        }}
      />
    </>
  );
}
