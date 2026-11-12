import { ensureSeed } from "@/lib/server/seed";
import { activeLearningLibrary } from "@/lib/server/queries";
import { PageHeader } from "@/components/ui";
import { decideFollowAudio } from "@/lib/content/audio-policy";
import { capabilities } from "@/lib/ai/registry";
import { envDefaultProfile } from "@/lib/speaking/voice-profile";
import { LearningBrowser, type LibraryItem } from "./learning-browser";

export const dynamic = "force-dynamic";

export default async function Questions() {
  await ensureSeed();
  const library = await activeLearningLibrary();
  const profile = envDefaultProfile();
  // `browser-speech-synthesis` means the deployment has no neural engine; the
  // study player then uses the browser voice and says so, instead of pretending.
  const serverTts = capabilities().tts.id !== "browser-speech-synthesis";

  // The page ships ~550 questions. Sending every sample answer, vocabulary list
  // and translation up front made the first paint ~1.7 MB, so the study material
  // travels separately: the list carries a summary, and the panel pulls the full
  // content for one topic on first expand.
  const items: LibraryItem[] = library.questions.map((q) => ({
    ...q,
    learning: { sampleAnswer: null, ideaNotes: [], keyPhrases: [], vocabGroups: [], followAudio: q.learning.followAudio },
    summary: {
      hasAnswer: !!q.learning.sampleAnswer?.paragraphs?.length,
      ideas: q.learning.ideaNotes?.length ?? 0,
      phrases: q.learning.keyPhrases?.length ?? 0,
      vocab: q.learning.vocabGroups?.length ?? 0,
    },
    cuePoints: q.cuePoints ?? [],
    follow: decideFollowAudio(q.learning.followAudio),
  }));

  return (
    <>
      <PageHeader
        title="Question learning library"
        subtitle="Bank questions with learning material: sample answers, idea breakdowns, key phrases and shadowing. The exam reads the question itself only — learning material never appears in the mock test."
      />
      <LearningBrowser
        items={items}
        coverage={library.coverage}
        season={library.season}
        region={library.region}
        profile={profile}
        serverTts={serverTts}
      />
    </>
  );
}
