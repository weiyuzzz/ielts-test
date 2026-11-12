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
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ExaminerAvatar3D } from "@/components/examiner/examiner-avatar-3d";
import { speak, stopSpeaking, disposeAudio, warmupSpeech, configureTtsIdentity, waitForTTS } from "@/lib/audio/speech";
import { primeEnvelope } from "@/lib/audio/examiner-envelope";
import { lipSync } from "@/lib/lipsync/controller";
import { VISEME_CHANNELS } from "@/lib/lipsync/types";
import { preloadExaminerModel, type ExaminerGender } from "@/lib/avatar/models";

interface Props {
  serverTts: boolean;
  profiles: { id: string; name: string }[];
  defaultProfileId: string;
  gender: ExaminerGender;
  /** Embedded in the settings page: no page chrome of its own. */
  embedded?: boolean;
}

const SAMPLES = [
  "Hello. My name is Sarah, and I will be your examiner today. Could I see your identification, please?",
  "I'd like to ask you some questions about yourself. Let's talk about what you do. Do you work, or are you a student?",
  "Now I'm going to give you a topic, and I'd like you to talk about it for one to two minutes.",
];

export function LipSyncLab({ serverTts, profiles, defaultProfileId, gender, embedded = false }: Props) {
  const [text, setText] = useState(SAMPLES[0]);
  const [voice, setVoice] = useState(defaultProfileId);
  const [examiner, setExaminer] = useState<ExaminerGender>(gender);
  const [playing, setPlaying] = useState(false);
  const [useBrowserVoice, setUseBrowserVoice] = useState(!serverTts);
  const barRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const visemeRef = useRef<HTMLSpanElement | null>(null);
  const timeRef = useRef<HTMLSpanElement | null>(null);
  const tierRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    warmupSpeech();
    configureTtsIdentity(null, null);
    primeEnvelope();
    preloadExaminerModel(examiner);
  }, [examiner]);

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
            <p className="text-xs text-zinc-400">数字考官口型验收页 — 观察当前 Viseme、播放时钟与轨道级别。</p>
          </div>
          <Link href="/speaking" className="text-xs text-zinc-500 underline">Back</Link>
        </div>
      )}
      {embedded && (
        <div>
          <h2 className="font-semibold">Lip Sync Lab</h2>
          <p className="mt-0.5 text-xs text-zinc-400">数字考官口型验收 — 试听音色、观察口型与轨道级别。</p>
        </div>
      )}

      <div className="flex items-start gap-5 rounded-2xl border border-zinc-200 bg-white p-5">
        <ExaminerAvatar3D gender={examiner} speaking={playing} listening={false} preparing={false} name={examiner === "female" ? "Sarah" : "James"} className="h-44 w-44 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="flex overflow-hidden rounded-lg border border-zinc-200">
              {(["female", "male"] as const).map((g) => (
                <button key={g} onClick={() => setExaminer(g)} className={`px-3 py-1.5 ${examiner === g ? "bg-zinc-900 text-white" : "bg-white text-zinc-600"}`}>
                  {g === "female" ? "Female" : "Male"}
                </button>
              ))}
            </div>
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
            {SAMPLES.map((s, i) => (
              <button key={i} onClick={() => setText(s)} className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-50">Sample {i + 1}</button>
            ))}
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
          Tier 释义：<span className="font-mono">anchored</span> = 引擎词级时间锚定（Kokoro）；<span className="font-mono">normalized</span> = 音素时长归一化（近似）；<span className="font-mono">rms</span> = 无内容数据，仅能量开合。
        </p>
      </div>
    </div>
  );
}
