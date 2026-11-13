import { getCurrentUser } from "@/lib/server/user";
import { capabilities } from "@/lib/ai/registry";
import { PageHeader, Card } from "@/components/ui";
import { normalizeGender, normalizeModelId, type ExaminerGender } from "@/lib/avatar/models";
import { SettingsForm } from "./settings-form";
import { SystemDiagnostics } from "./diagnostics";

export const dynamic = "force-dynamic";

export default async function Settings() {
  const user = await getCurrentUser();
  const caps = capabilities();
  const tts = caps.tts;
  const saved = user?.examinerVoice ?? "auto";
  const gender: ExaminerGender = normalizeGender(user?.examinerGender);
  const modelId = normalizeModelId(user?.examinerModel, gender);
  return (
    <>
      <PageHeader title="Settings" subtitle="Your goal, examiner voice, microphone and environment diagnostics." />


      <div className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <SettingsForm
              diagnosticsSlot={
                <SystemDiagnostics
                  caps={{
                    serverTts: tts.location === "server",
                    tts: { id: tts.id, model: tts.model, location: tts.location, format: tts.format },
                    asr: caps.asr ? { id: caps.asr.id, model: caps.asr.model, location: caps.asr.location } : null,
                    llm: caps.llm ? { id: caps.llm.id, model: caps.llm.model } : null,
                    pronunciation: caps.pronunciation,
                    examinerVoice: saved,
                    examinerGender: gender,
                    examinerModelId: modelId,
                  }}
                  initialDigitalHuman3d={user?.digitalHuman3d ?? true}
                />
              }
              initial={{ displayName: user?.displayName ?? "Candidate", targetBand: user?.targetBand ?? 7, examDate: user?.examDate ?? "", examinerVoice: saved, examinerGender: gender, examinerModel: modelId, digitalHuman3d: user?.digitalHuman3d ?? true, showSubtitles: user?.showSubtitles ?? true }}
              serverTts={tts.location === "server"}
              ttsVoice={tts.voice}
              ttsStreaming={tts.streaming}
              profiles={tts.profiles}
              defaultProfileId={tts.defaultProfileId}
            />
          </div>
          <Card className="h-fit p-5">
            <h2 className="mb-3 font-semibold">AI services</h2>
            <dl className="space-y-3 text-sm">
              {[
                ["Speech recognition (ASR)", caps.asr ? `${caps.asr.id}${caps.asr.model ? ` · ${caps.asr.model}` : ""}` : "None"],
                ["Examiner / scoring LLM", caps.llm ? `${caps.llm.id} · ${caps.llm.model}` : "Not configured. Learning diagnostics only — no IELTS band is generated."],
                ["Examiner voice (TTS)", `${caps.tts.id} · ${caps.tts.activeProfile.name}${caps.tts.location === "server" ? ` · ${caps.tts.format}${caps.tts.streaming ? " · progressive" : ""}` : ""}`],
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
      </div>
    </>
  );
}
