"use client";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui";
import { MicCheck } from "@/components/mic-check";
import { loadVoices, speak, warmupSpeech } from "@/lib/audio/speech";
import { DEFAULT_MODEL_BY_GENDER, examinerModelById, examinerModelsForGender, normalizeModelId, type ExaminerGender } from "@/lib/avatar/models";

interface S { displayName: string; targetBand: number; examDate: string; examinerVoice: string; examinerGender: "male" | "female"; examinerModel: string; showSubtitles: boolean }
interface ProfileOption { id: string; name: string; provider: string; gender?: "male" | "female" | null }

/** The default voice each provider family pairs with an examiner gender. */
const GENDER_VOICE_BY_FAMILY: Record<string, Record<"male" | "female", string>> = {
  kokoro: { female: "kokoro-af-heart", male: "kokoro-bm-george" },
  azure: { female: "azure-sonia", male: "azure-ryan" },
  openai: { female: "openai-marin", male: "openai-onyx" },
  browser: { female: "auto", male: "auto" },
};
const GENDER_NAME: Record<"male" | "female", string> = { female: "Sarah", male: "James" };

/** Infer the provider family of a stored voice preference. */
function voiceFamily(voice: string): string {
  if (voice.startsWith("kokoro") || /^[ab][fm]_[a-z0-9_]+$/i.test(voice)) return "kokoro";
  if (voice.startsWith("azure") || /-[A-Z][a-z]+Neural$/.test(voice)) return "azure";
  if (voice.startsWith("openai")) return "openai";
  if (voice.startsWith("browser")) return "browser";
  return "kokoro"; // "auto" and unknown: the deployment default family
}

export function SettingsForm({ initial, serverTts, ttsVoice, ttsStreaming, profiles }: { initial: S; serverTts: boolean; ttsVoice: string; ttsStreaming: boolean; profiles: ProfileOption[] }) {
  const [s, setS] = useState(initial);
  const [saved, setSaved] = useState<string | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [mic, setMic] = useState("");

  useEffect(() => {
    warmupSpeech();
    loadVoices().then((v) => setVoices(v.filter((x) => x.lang.toLowerCase().startsWith("en"))));
    // localStorage is unavailable during SSR; read it in a deferred callback to
    // avoid a synchronous setState inside the effect body.
    const storedMic = localStorage.getItem("mic-device") || "";
    const t = setTimeout(() => setMic(storedMic), 0);
    return () => clearTimeout(t);
  }, []);

  async function save() {
    setSaved(null);
    const res = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...s, examDate: s.examDate || null }) });
    const j = await res.json();
    setSaved(res.ok ? "Saved" : j.error || "Failed");
  }

  /**
   * Examiner identity: the digital human AND the voice belong to one person.
   * Switching gender re-pairs the voice WITHIN the same provider family (a
   * Kokoro deployment never gets pointed at an unconfigured Azure preset) and
   * the voice list itself only offers voices matching the chosen gender.
   */
  function pickGender(gender: ExaminerGender) {
    const family = voiceFamily(s.examinerVoice);
    const current = profiles.find((p) => p.id === s.examinerVoice);
    // "auto" counts as MISMATCH: it hides which gender the deployment default
    // speaks with, so picking an examiner always pins an explicit voice.
    const isAuto = s.examinerVoice === "auto";
    const genderMatches = !isAuto && (current?.gender == null || current.gender === gender);
    const paired = GENDER_VOICE_BY_FAMILY[family]?.[gender];
    const nextVoice = genderMatches ? s.examinerVoice : paired ?? s.examinerVoice;
    // Keep the chosen look when it already belongs to the target gender…
    const modelKept = examinerModelById(s.examinerModel)?.gender === gender;
    // …otherwise fall back to that gender's default examiner.
    const nextModel = modelKept ? s.examinerModel : DEFAULT_MODEL_BY_GENDER[gender];
    setS({ ...s, examinerGender: gender, examinerVoice: nextVoice, examinerModel: nextModel });
  }

  function pickModel(id: string) {
    setS({ ...s, examinerModel: normalizeModelId(id, s.examinerGender) });
  }

  /** The five examiner looks available for the chosen gender. */
  const examinerChoices = examinerModelsForGender(s.examinerGender);

  /** Voices offered for the chosen examiner: matching gender only (null-gender voices like "auto" always stay). */
  const genderedProfiles = profiles.filter((p) => p.gender == null || p.gender === s.examinerGender);

  const field = "mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-400";
  return (
    <Card className="space-y-5 p-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm">Display name<input className={field} value={s.displayName} onChange={(e) => setS({ ...s, displayName: e.target.value })} /></label>
        <label className="text-sm">Target band
          <select className={field} value={s.targetBand} onChange={(e) => setS({ ...s, targetBand: Number(e.target.value) })}>
            {[5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9].map((b) => <option key={b} value={b}>{b.toFixed(1)}</option>)}
          </select>
        </label>
        <label className="text-sm">Exam date<input type="date" className={field} value={s.examDate} onChange={(e) => setS({ ...s, examDate: e.target.value })} /></label>
        <label className="text-sm">Examiner
          <div className="mt-1 grid grid-cols-2 gap-2">
            {(["female", "male"] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => pickGender(g)}
                className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${s.examinerGender === g ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300"}`}
              >
                <span className="block font-medium">{g === "female" ? "Female examiner" : "Male examiner"}</span>
                <span className={`mt-0.5 block text-xs ${s.examinerGender === g ? "text-zinc-300" : "text-zinc-400"}`}>{GENDER_NAME[g]} · {(GENDER_VOICE_BY_FAMILY[voiceFamily(s.examinerVoice)]?.[g] ?? "").replace(/^(kokoro|openai|azure)[-:]/, "") || "voice"}</span>
              </button>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-5 gap-1.5" role="group" aria-label="Examiner looks">
            {examinerChoices.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => pickModel(m.id)}
                title={m.displayName}
                className={`rounded-lg border px-1 py-2 text-center text-xs transition-colors ${s.examinerModel === m.id ? "border-zinc-900 bg-zinc-900 text-white font-medium" : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300"}`}
              >
                {m.displayName}
              </button>
            ))}
          </div>
          <span className="mt-1 block text-xs text-zinc-400">Pick the examiner&apos;s look — the voice always matches the examiner&apos;s gender. The choice is frozen when a test starts.</span>
        </label>
        <label className="text-sm">Examiner voice {serverTts ? "(voice profile)" : "(browser voice)"}
          {serverTts ? (
            <>
              <select className={field} value={s.examinerVoice} onChange={(e) => setS({ ...s, examinerVoice: e.target.value })}>
                <option value="auto">Auto · deployment default ({ttsVoice})</option>
                {genderedProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                {s.examinerVoice !== "auto" && !profiles.some((p) => p.id === s.examinerVoice) && (
                  <option value={s.examinerVoice}>{s.examinerVoice} · custom</option>
                )}
                {s.examinerVoice !== "auto" && profiles.some((p) => p.id === s.examinerVoice) && !genderedProfiles.some((p) => p.id === s.examinerVoice) && (
                  <option value={s.examinerVoice}>{s.examinerVoice} · other gender</option>
                )}
              </select>
              <span className="mt-1 block text-xs text-zinc-400">
                Only voices matching the {s.examinerGender === "female" ? "female" : "male"} examiner are listed — the digital human and the voice always belong to the same person. {ttsStreaming ? "Progressive playback is on." : "Buffered playback."} A running exam keeps the voice it started with.
              </span>
            </>
          ) : (
            <select className={field} value={s.examinerVoice} onChange={(e) => setS({ ...s, examinerVoice: e.target.value })}>
              <option value="auto">Automatic (British English preferred)</option>
              {voices.map((v) => <option key={v.name} value={v.name}>{v.name} · {v.lang}</option>)}
            </select>
          )}
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.showSubtitles} onChange={(e) => setS({ ...s, showSubtitles: e.target.checked })} /> Show examiner subtitles during the test</label>
      <div className="flex items-center gap-3">
        <button onClick={save} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700">Save</button>
        <button onClick={() => speak(`Good morning. My name is ${GENDER_NAME[s.examinerGender]}. Could I see your identification, please?`, { serverTts, voice: s.examinerVoice, act: "greeting", profileId: s.examinerVoice })} className="rounded-lg border border-zinc-200 px-4 py-2 text-sm">Test voice</button>
        {saved && <span className="text-sm text-zinc-500">{saved}</span>}
      </div>
      <hr className="border-zinc-100" />
      <MicCheck
        deviceId={mic}
        onDeviceChange={(id) => { setMic(id); localStorage.setItem("mic-device", id); }}
        title="Microphone test"
        hint="Record for 3 seconds and play it back — if you can hear yourself, this capture path works. It is the exact same path the exam uses."
      />
    </Card>
  );
}
