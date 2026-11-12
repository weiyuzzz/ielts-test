import { getCurrentUser } from "@/lib/server/user";
import { capabilities } from "@/lib/ai/registry";
import { PageHeader, Card } from "@/components/ui";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

export default async function Settings() {
  const user = await getCurrentUser();
  const caps = capabilities();
  return (
    <>
      <PageHeader title="Settings" subtitle="Your goal, examiner voice and microphone." />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SettingsForm initial={{ displayName: user?.displayName ?? "Candidate", targetBand: user?.targetBand ?? 7, examDate: user?.examDate ?? "", examinerVoice: user?.examinerVoice ?? "auto", showSubtitles: user?.showSubtitles ?? true }} serverTts={caps.tts.location === "server"} ttsVoice={caps.tts.voice} ttsStreaming={caps.tts.streaming} />
        </div>
        <Card className="h-fit p-5">
          <h2 className="mb-3 font-semibold">AI services</h2>
          <dl className="space-y-3 text-sm">
            {[
              ["Speech recognition (ASR)", caps.asr ? `${caps.asr.id}${caps.asr.model ? ` · ${caps.asr.model}` : ""}` : "None"],
              ["Examiner / scoring LLM", caps.llm ? `${caps.llm.id} · ${caps.llm.model}` : "Not configured. Heuristic scoring is used."],
              ["Examiner voice (TTS)", `${caps.tts.id} · ${caps.tts.voice}${caps.tts.location === "server" ? ` · ${caps.tts.format}${caps.tts.streaming ? " · progressive" : ""}` : ""}`],
              ["Pronunciation (audio)", caps.pronunciation ? caps.pronunciation.id : "Not configured. Pronunciation will not be scored."],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs uppercase tracking-wide text-zinc-400">{k}</dt>
                <dd className="mt-0.5 text-zinc-700">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-xs leading-5 text-zinc-400">Providers are configured with server environment variables (see .env.example). API keys never reach the browser.</p>
        </Card>
      </div>
    </>
  );
}
