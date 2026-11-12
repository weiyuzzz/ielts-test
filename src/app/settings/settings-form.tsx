"use client";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui";
import { MicCheck } from "@/components/mic-check";
import { loadVoices, speak, warmupSpeech } from "@/lib/audio/speech";

interface S { displayName: string; targetBand: number; examDate: string; examinerVoice: string; examinerGender: "male" | "female"; showSubtitles: boolean }
interface ProfileOption { id: string; name: string; provider: string }

/** Voice presets that belong to each examiner identity (image ↔ voice pairing). */
const GENDER_VOICE_PRESET: Record<"male" | "female", string> = { female: "azure-sonia", male: "azure-ryan" };
const GENDER_NAME: Record<"male" | "female", string> = { female: "Sarah", male: "James" };

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
   * Switching gender re-pairs the voice automatically — but only when the
   * current voice is "auto" or one of the two gender presets, so a deliberate
   * Voice Lab / custom choice is never clobbered silently.
   */
  function pickGender(gender: "male" | "female") {
    const paired = GENDER_VOICE_PRESET[gender];
    const swappable = s.examinerVoice === "auto" || Object.values(GENDER_VOICE_PRESET).includes(s.examinerVoice);
    setS({ ...s, examinerGender: gender, examinerVoice: swappable ? paired : s.examinerVoice });
  }

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
                <span className={`mt-0.5 block text-xs ${s.examinerGender === g ? "text-zinc-300" : "text-zinc-400"}`}>{GENDER_NAME[g]} · {GENDER_VOICE_PRESET[g].split("-")[1]}</span>
              </button>
            ))}
          </div>
          <span className="mt-1 block text-xs text-zinc-400">The digital examiner and the voice are paired; the choice is frozen when a test starts.</span>
        </label>
        <label className="text-sm">Examiner voice {serverTts ? "(voice profile)" : "(browser voice)"}
          {serverTts ? (
            <>
              <select className={field} value={s.examinerVoice} onChange={(e) => setS({ ...s, examinerVoice: e.target.value })}>
                <option value="auto">Auto · deployment default ({ttsVoice})</option>
                {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                {s.examinerVoice !== "auto" && !profiles.some((p) => p.id === s.examinerVoice) && (
                  <option value={s.examinerVoice}>{s.examinerVoice} · custom</option>
                )}
              </select>
              <span className="mt-1 block text-xs text-zinc-400">
                {ttsStreaming ? "Progressive playback is on." : "Buffered playback."} A running exam keeps the voice it started with.
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
        title="麦克风调试"
        hint="点「试录 3 秒」再回放：能听到自己的声音就说明这条录音通道正常。这里和正式考试用的是同一个采集方式。"
      />
    </Card>
  );
}
