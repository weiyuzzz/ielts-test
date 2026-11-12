"use client";
/**
 * Examiner Voice Lab — development/QA tool for judging the examiner voice.
 *
 * Machine scores cannot decide whether a voice sounds like a real IELTS
 * examiner, so this panel is built around listening: identical text and the
 * same speech act, two profiles side by side, with the measured cost visible.
 * Nothing here changes exam behaviour; it only synthesises on demand.
 */
import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui";

export interface ProfileInfo {
  id: string;
  name: string;
  provider: string;
  voice: string;
  speed: number;
  pitch: number;
  hasStyle: boolean;
}

export interface LabProfile {
  id: string;
  name: string;
  provider: "azure" | "openai" | "kokoro" | "browser";
  voice: string;
  language: "en-GB";
  speed: number;
  pitch: number;
  instructions?: string;
  prosody: { sentencePauseMs: number; questionPauseMs: number; clausePauseMs: number; emphasisEnabled: boolean };
}

interface Attempt {
  url: string;
  ms: number;
  bytes: number;
  mime: string;
  sampleRate: number | null;
  error?: string;
}

/** The fixed test corpus: same sentences for every provider, so A/B is fair. */
const CORPUS: { label: string; act: string; text: string }[] = [
  { label: "Greeting", act: "greeting", text: "Good morning. My name is Sarah." },
  { label: "ID check", act: "question", text: "Could I see your identification, please?" },
  { label: "Part 1 intro", act: "introduction", text: "In this first part, I'd like to ask you some questions about yourself." },
  { label: "Question", act: "question", text: "Do you enjoy reading books?" },
  { label: "Part 3 question", act: "question", text: "Why do you think some people prefer living in large cities?" },
  { label: "Instruction", act: "instruction", text: "You'll have one minute to prepare. You can make some notes if you wish." },
  { label: "Closing", act: "closing", text: "Thank you. That is the end of the speaking test." },
];

const toLab = (p: ProfileInfo): LabProfile => ({
  id: p.id,
  name: p.name,
  provider: p.provider as LabProfile["provider"],
  voice: p.voice,
  language: "en-GB",
  speed: p.speed,
  pitch: p.pitch,
  prosody: { sentencePauseMs: 260, questionPauseMs: 480, clausePauseMs: 140, emphasisEnabled: true },
});

async function readSampleRate(blob: Blob): Promise<number | null> {
  try {
    const buf = await blob.arrayBuffer();
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    const decoded = await ctx.decodeAudioData(buf.slice(0));
    const rate = decoded.sampleRate;
    await ctx.close();
    return rate;
  } catch {
    return null;
  }
}

/** Synthesise one line through the real proxy, measuring what the user waits for. */
async function synthesize(text: string, act: string, profile: LabProfile): Promise<Attempt> {
  const started = performance.now();
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, act, profile }),
    cache: "no-store",
  });
  const ms = Math.round(performance.now() - started);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { url: "", ms, bytes: 0, mime: "", sampleRate: null, error: body.error || `HTTP ${res.status}` };
  }
  const blob = await res.blob();
  return {
    url: URL.createObjectURL(blob),
    ms,
    bytes: blob.size,
    mime: res.headers.get("content-type") || blob.type || "audio/mpeg",
    sampleRate: await readSampleRate(blob),
    error: undefined,
  };
}

export function VoiceLab({
  serverTts,
  profiles,
  availability,
  speechActs,
  defaultProfileId,
  activeProfileId,
}: {
  serverTts: boolean;
  profiles: ProfileInfo[];
  availability: Record<string, boolean>;
  speechActs: { id: string; label: string }[];
  defaultProfileId: string;
  activeProfileId: string;
}) {
  const pick = (id: string) => profiles.find((p) => p.id === id) ?? profiles[0];
  const [a, setA] = useState<LabProfile>(() => toLab(pick(activeProfileId || defaultProfileId)));
  const [b, setB] = useState<LabProfile>(() => toLab(pick(profiles[1]?.id ?? defaultProfileId)));
  const [act, setAct] = useState("question");
  const [text, setText] = useState(CORPUS[3].text);
  const [resA, setResA] = useState<Attempt | null>(null);
  const [resB, setResB] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState<"a" | "b" | "both" | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => { audioRef.current?.pause(); }, []);

  const usable = (provider: string) => availability[provider] !== false;

  /** Persist the chosen profile as the exam default. Only affects future exams. */
  async function saveForExams(id: string) {
    setSaveMsg(null);
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ examinerVoice: id }),
    });
    setSaveMsg(res.ok ? "Saved — new exams will use this voice." : "Could not save this voice.");
  }

  function play(url: string) {
    if (!url) return;
    audioRef.current?.pause();
    const el = new Audio(url);
    audioRef.current = el;
    void el.play().catch(() => {});
  }

  async function runOne(which: "a" | "b") {
    const profile = which === "a" ? a : b;
    if (!usable(profile.provider)) return;
    setBusy(which);
    const result = await synthesize(text, act, profile);
    if (which === "a") setResA(result); else setResB(result);
    if (result.url) play(result.url);
    setBusy(null);
  }

  async function runBoth() {
    setBusy("both");
    const [ra, rb] = await Promise.all([synthesize(text, act, a), synthesize(text, act, b)]);
    setResA(ra);
    setResB(rb);
    setBusy(null);
  }

  const fmtSize = (bytes: number) => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

  function editor(profile: LabProfile, set: (p: LabProfile) => void, label: string, result: Attempt | null, which: "a" | "b") {
    return (
      <div className="rounded-xl border border-zinc-200 p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{label}</span>
          {result && !result.error && <span className="text-xs tabular-nums text-zinc-400">{result.ms} ms</span>}
        </div>
        <select
          className="mt-2 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
          value={profile.id}
          onChange={(e) => set(toLab(pick(e.target.value)))}
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id} disabled={!usable(p.provider)}>
              {p.name}{usable(p.provider) ? "" : " — not configured"}
            </option>
          ))}
        </select>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="text-xs text-zinc-500">Speed · {profile.speed.toFixed(2)}
            <input type="range" min={0.8} max={1.15} step={0.01} value={profile.speed} className="mt-1 w-full" onChange={(e) => set({ ...profile, speed: Number(e.target.value) })} />
          </label>
          <label className="text-xs text-zinc-500">Pitch · {profile.pitch >= 0 ? "+" : ""}{profile.pitch.toFixed(1)}
            <input type="range" min={-2} max={2} step={0.1} value={profile.pitch} className="mt-1 w-full" onChange={(e) => set({ ...profile, pitch: Number(e.target.value) })} />
          </label>
        </div>
        <button
          onClick={() => runOne(which)}
          disabled={busy !== null || !usable(profile.provider) || !serverTts}
          className="mt-3 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm disabled:opacity-40"
        >
          {busy === which ? "Synthesising…" : `Play ${label}`}
        </button>
        <button onClick={() => saveForExams(profile.id)} className="mt-2 w-full text-xs text-zinc-500 underline">Use for exams</button>
        {result?.error && <p className="mt-2 rounded-lg bg-red-50 p-2 text-xs text-red-700">{result.error}</p>}
        {result && !result.error && (
          <dl className="mt-3 space-y-1 text-xs text-zinc-500">
            <div className="flex justify-between"><dt>Format</dt><dd className="tabular-nums">{result.mime}</dd></div>
            <div className="flex justify-between"><dt>Sample rate</dt><dd className="tabular-nums">{result.sampleRate ? `${result.sampleRate} Hz` : "—"}</dd></div>
            <div className="flex justify-between"><dt>Size</dt><dd className="tabular-nums">{fmtSize(result.bytes)}</dd></div>
            <div className="flex justify-between"><dt>Synthesis</dt><dd className="tabular-nums">{result.ms} ms</dd></div>
          </dl>
        )}
      </div>
    );
  }

  if (!serverTts) {
    return (
      <Card className="p-6">
        <h2 className="text-sm font-semibold">Examiner Voice Lab</h2>
        <p className="mt-2 text-sm text-zinc-500">No server TTS is configured, so there is nothing to compare. The browser voice is used as a fallback and cannot be profiled here.</p>
      </Card>
    );
  }

  return (
    <Card className="space-y-4 p-6">
      <div>
        <h2 className="text-sm font-semibold">Examiner Voice Lab</h2>
        <p className="mt-1 text-xs text-zinc-500">Same sentence, same speech act, two profiles — listen and pick. Machine scores cannot judge naturalness.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-zinc-500">Speech act
          <select className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm" value={act} onChange={(e) => setAct(e.target.value)}>
            {speechActs.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="text-xs text-zinc-500">Test sentence
          <input className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {CORPUS.map((c) => (
          <button
            key={c.label}
            onClick={() => { setText(c.text); setAct(c.act); }}
            className="rounded-full border border-zinc-200 px-2.5 py-1 text-xs text-zinc-600 hover:bg-zinc-50"
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {editor(a, setA, "A", resA, "a")}
        {editor(b, setB, "B", resB, "b")}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={runBoth}
          disabled={busy !== null}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy === "both" ? "Synthesising both…" : "A/B compare"}
        </button>
        <button
          onClick={() => { if (resA?.url) play(resA.url); }}
          disabled={!resA?.url}
          className="rounded-lg border border-zinc-200 px-3 py-2 text-sm disabled:opacity-40"
        >Replay A</button>
        <button
          onClick={() => { if (resB?.url) play(resB.url); }}
          disabled={!resB?.url}
          className="rounded-lg border border-zinc-200 px-3 py-2 text-sm disabled:opacity-40"
        >Replay B</button>
        <span className="text-xs text-zinc-400">Unavailable providers are marked, never silently substituted.</span>
        {saveMsg && <span className="text-xs text-zinc-600">{saveMsg}</span>}
      </div>
    </Card>
  );
}
