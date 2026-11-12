"use client";
/**
 * Lip Sync Lab — standalone acceptance page for the digital examiner.
 *
 * Input text → play via TTS (or the browser voice) → watch the examiner.
 * The readout shows the CURRENT viseme, playback time, track tier and the
 * live 15-channel viseme weights, so mouth/audio alignment can be judged
 * directly (spec 第七阶段). No exam state is touched.
 *
 * The readout is written straight to the DOM from one RAF loop — no React
 * state per frame, same rule as the avatar.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ExaminerAvatar3D } from "@/components/examiner/examiner-avatar-3d";
import { speak, stopSpeaking, disposeAudio, warmupSpeech, configureTtsIdentity, waitForTTS } from "@/lib/audio/speech";
import { primeEnvelope } from "@/lib/audio/examiner-envelope";
import { lipSync } from "@/lib/lipsync/controller";
import { VISEME_CHANNELS } from "@/lib/lipsync/types";
import { examinerModelById, preloadExaminerModel, type ExaminerGender } from "@/lib/avatar/models";

interface Props {
  serverTts: boolean;
  profiles: { id: string; name: string }[];
  defaultProfileId: string;
  gender: ExaminerGender;
  /** Which examiner look to show ("f1"…"f5"/"m1"…"m5"). */
  modelId?: string;
  /** The examiner's display name, used in the sample line and avatar label. */
  name?: string;
  /** Voice preselected from the form ("auto" → the deployment default). */
  initialVoice?: string;
  /** Embedded in the settings page: no page chrome of its own. */
  embedded?: boolean;
}

export function LipSyncLab({ serverTts, profiles, defaultProfileId, gender, modelId, name, initialVoice, embedded = false }: Props) {
  const examinerName = name ?? examinerModelById(modelId ?? "")?.displayName ?? (gender === "female" ? "Sarah" : "James");
  const sampleLine = useMemo(
    () => `Hello. My name is ${examinerName}, and I will be your examiner today. Could I see your identification, please?`,
    [examinerName],
  );
  const preselectedVoice = !initialVoice || initialVoice === "auto" || !profiles.some((p) => p.id === initialVoice) ? defaultProfileId : initialVoice;
  const [text, setText] = useState(sampleLine);
  const [prevLine, setPrevLine] = useState(sampleLine);
  const [prevVoice, setPrevVoice] = useState(preselectedVoice);
  const [voice, setVoice] = useState(preselectedVoice);
  const [playing, setPlaying] = useState(false);
  const [useBrowserVoice, setUseBrowserVoice] = useState(!serverTts);
  const barRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const visemeRef = useRef<HTMLSpanElement | null>(null);
  const timeRef = useRef<HTMLSpanElement | null>(null);
  const tierRef = useRef<HTMLSpanElement | null>(null);

  // Follow the examiner chosen in the form above: when its greeting line
  // changes, reset the text; when the form's voice changes, follow it
  // (React's adjust-state-on-prop-change pattern).
  if (prevLine !== sampleLine) {
    setPrevLine(sampleLine);
    setText(sampleLine);
  }
  if (prevVoice !== preselectedVoice) {
    setPrevVoice(preselectedVoice);
    setVoice(preselectedVoice);
  }

  useEffect(() => {
    warmupSpeech();
    configureTtsIdentity(null, null);
    primeEnvelope();
    preloadExaminerModel(modelId ?? (gender === "female" ? "f1" : "m1"));
  }, [gender, modelId]);

  // Warm the current line while the page sits idle: if synthesis is still
  // running when Play is clicked, the long wait outlives the browser's user
  // activation and audio.play() gets silently blocked by autoplay policy.
  useEffect(() => {
    if (useBrowserVoice || !text.trim()) return;
    const t = setTimeout(() => { void waitForTTS(text, voice, 90_000, "question", voice); }, 300);
    return () => clearTimeout(t);
  }, [text, voice, useBrowserVoice]);

  // One readout loop: current viseme, clock, tier + channel bars.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const s = lipSync.sample(0, performance.now());
      let maxV = "sil";
      let maxW = 0;
      for (let i = 0; i < VISEME_CHANNELS.length; i++) {
        const w = s.channels[i];
        const bar = barRefs.current[i];
        if (bar) bar.style.height = `${Math.max(2, Math.min(40, w * 42))}px`;
        if (w > maxW) { maxW = w; maxV = VISEME_CHANNELS[i]; }
      }
      if (visemeRef.current) visemeRef.current.textContent = maxW > 0.12 ? maxV : "sil";
      if (timeRef.current) timeRef.current.textContent = `${s.time.toFixed(2)}s`;
      if (tierRef.current) tierRef.current.textContent = s.tier;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  async function play() {
    if (playing) return;
    setPlaying(true);
    try {
      if (!useBrowserVoice) {
        // Warm the clip first (buffered POST): this is also how the exam plays
        // prepared lines, and it is what carries the engine word timestamps.
        await waitForTTS(text, voice, 90_000, "question", voice);
      }
      await speak(text, { serverTts: !useBrowserVoice, voice, act: "question", profileId: voice });
    } finally {
      setPlaying(false);
    }
  }

  function stop() {
    stopSpeaking();
    setPlaying(false);
  }

  useEffect(() => () => disposeAudio(), []);

  const btn = "rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-40";
  return (
    <div className={embedded ? "space-y-5" : "mx-auto max-w-3xl space-y-5 p-6"}>
      {!embedded && (
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Lip Sync Lab</h1>
            <p className="text-xs text-zinc-400">Digital examiner lip-sync check page — watch the current viseme, the playback clock and the track tier.</p>
          </div>
          <Link href="/speaking" className="text-xs text-zinc-500 underline">Back</Link>
        </div>
      )}
      {embedded && (
        <div>
          <h2 className="font-semibold">Lip Sync Lab</h2>
          <p className="mt-0.5 text-xs text-zinc-400">Digital examiner lip-sync check — preview voices, watch visemes, clock and track tier.</p>
        </div>
      )}

      <div className="flex items-start gap-5 rounded-2xl border border-zinc-200 bg-white p-5">
        <ExaminerAvatar3D gender={gender} modelId={modelId} speaking={playing} listening={false} preparing={false} name={examinerName} className="h-44 w-44 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded bg-zinc-100 px-2 py-1 font-medium text-zinc-600">{examinerName} · {gender === "female" ? "Female" : "Male"} examiner</span>
            <select value={voice} onChange={(e) => setVoice(e.target.value)} className="rounded-lg border border-zinc-200 px-2 py-1.5">
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <label className="flex items-center gap-1.5 text-zinc-500">
              <input type="checkbox" checked={useBrowserVoice} onChange={(e) => setUseBrowserVoice(e.target.checked)} />
              Browser voice (approximate mode)
            </label>
          </div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className="mt-3 w-full resize-none rounded-lg border border-zinc-200 p-3 text-sm outline-none focus:border-zinc-400" />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button onClick={play} disabled={playing || !text.trim()} className={`${btn} bg-zinc-900 text-white hover:bg-zinc-700`}>Play</button>
            <button onClick={stop} className={`${btn} border border-zinc-200`}>Stop</button>
            <button onClick={() => setText(sampleLine)} className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-50">Reset text</button>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white p-5">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
          <div>Viseme: <span ref={visemeRef} className="ml-1 inline-block rounded bg-zinc-900 px-2 py-0.5 font-mono text-xs text-white">sil</span></div>
          <div>Clock: <span ref={timeRef} className="ml-1 font-mono text-xs">0.00s</span></div>
          <div>Tier: <span ref={tierRef} className="ml-1 font-mono text-xs">rms</span></div>
        </div>
        <div className="mt-4 flex h-12 items-end gap-[3px]" aria-label="Viseme channels">
          {VISEME_CHANNELS.map((v, i) => (
            <div key={v} className="flex w-8 flex-col items-center gap-1">
              <span ref={(el) => { barRefs.current[i] = el; }} className="w-full rounded-t bg-indigo-500" style={{ height: 2 }} />
              <span className="text-[9px] text-zinc-400">{v}</span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs leading-5 text-zinc-400">
          Tier meanings: <span className="font-mono">anchored</span> = engine word-level timestamps (Kokoro); <span className="font-mono">normalized</span> = phoneme duration normalization (approximate); <span className="font-mono">rms</span> = no content data, energy-only fallback.
        </p>
      </div>
    </div>
  );
}
