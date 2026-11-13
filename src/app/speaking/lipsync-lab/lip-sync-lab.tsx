"use client";
/**
 * Lip Sync Lab — standalone acceptance page for the digital examiner.
 *
 * Input text → play via TTS (or the browser voice) → watch the examiner.
 * The readout shows the CURRENT viseme, playback time, track tier and the
 * live 15-channel viseme weights, so mouth/audio alignment can be judged
 * directly (spec 第七阶段). No exam state is touched.
 *
 * The readout is written straight to the DOM — no React state per frame.
 * While a line is playing it samples at RAF (60 fps); when idle it drops to
 * a 300 ms interval, so an open settings page does not burn a render loop.
 *
 * 3D is strictly click-to-load: the GLB is NOT preloaded and ExaminerAvatar3D
 * is NOT mounted until the user activates it. With `show3D={false}` (the
 * settings page while the 3D digital human is switched off) the lab is a
 * voice audition only — no three.js import, no WebGL, no GLB, no 3D RAF.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ExaminerAvatar3D } from "@/components/examiner/examiner-avatar-3d";
import { speak, stopSpeaking, disposeAudio, warmupSpeech, configureTtsIdentity, waitForTTS, rearmAudio } from "@/lib/audio/speech";
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
  /**
   * false → the 3D digital human is switched off: voice audition only, the
   * 3D pipeline never mounts and the GLB never downloads. Default true
   * (standalone lab page), still click-to-activate.
   */
  show3D?: boolean;
}

export function LipSyncLab({ serverTts, profiles, defaultProfileId, gender, modelId, name, initialVoice, embedded = false, show3D = true }: Props) {
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
  /** True while synthesis is still running (local CPU engines can take ~30s+/line). */
  const [waiting, setWaiting] = useState(false);
  const [waitSec, setWaitSec] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [useBrowserVoice, setUseBrowserVoice] = useState(!serverTts);
  const barRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const visemeRef = useRef<HTMLSpanElement | null>(null);
  const timeRef = useRef<HTMLSpanElement | null>(null);
  const tierRef = useRef<HTMLSpanElement | null>(null);
  /** Cancels the in-flight synthesis wait (Stop button during preparing). */
  const cancelWaitRef = useRef<(() => void) | null>(null);
  /** 3D pipeline activation — nothing Three.js-related exists before this. */
  const [avatar3dOn, setAvatar3dOn] = useState(false);

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
    // Deliberately NO preloadExaminerModel() here: the GLB downloads only when
    // the user activates the 3D examiner (see activate3D below).
  }, [gender, modelId]);

  /** Click-to-load: warm the HTTP cache and mount the real 3D pipeline. */
  function activate3D() {
    if (avatar3dOn) return;
    preloadExaminerModel(modelId ?? (gender === "female" ? "f1" : "m1"));
    setAvatar3dOn(true);
  }

  // Warm the current line while the page sits idle: if synthesis is still
  // running when Play is clicked, the long wait outlives the browser's user
  // activation and audio.play() gets silently blocked by autoplay policy.
  useEffect(() => {
    if (useBrowserVoice || !text.trim()) return;
    const t = setTimeout(() => { void waitForTTS(text, voice, 90_000, "question", voice); }, 300);
    return () => clearTimeout(t);
  }, [text, voice, useBrowserVoice]);

  // One readout: current viseme, clock, tier + channel bars. Full RAF cadence
  // only while a line is playing/waiting; idle it samples at 300 ms so an
  // open settings page never keeps a busy render loop alive.
  useEffect(() => {
    const draw = () => {
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
    let raf = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    if (playing || waiting) {
      const loop = () => {
        raf = requestAnimationFrame(loop);
        draw();
      };
      raf = requestAnimationFrame(loop);
    } else {
      timer = setInterval(draw, 300);
      draw();
    }
    return () => {
      cancelAnimationFrame(raf);
      if (timer) clearInterval(timer);
    };
  }, [playing, waiting]);

  async function play() {
    if (playing || waiting) return;
    // Defensive: the scheduler is a page-global singleton; if ANY component on
    // this page disposed it (exam cleanup, hot reload, future refactor), a
    // disposed scheduler resolves every request with null and the Lab would
    // silently fail to synthesise. rearm() is idempotent and cheap.
    rearmAudio();
    setError(null);
    if (!useBrowserVoice) {
      // Wait for the REAL synthesis — the lab exists to audition voices, so a
      // robotic browser fallback is worse than waiting. Long cap (5 min): a
      // cold local CPU engine needs ~30s per line, more on first run.
      setWaiting(true);
      setWaitSec(0);
      let cancelled = false;
      cancelWaitRef.current = () => { cancelled = true; };
      const ticker = setInterval(() => setWaitSec((s) => s + 1), 1000);
      try {
        const clip = await waitForTTS(text, voice, 300_000, "question", voice);
        clearInterval(ticker);
        setWaiting(false);
        cancelWaitRef.current = null;
        if (cancelled) return;
        if (!clip) {
          setError("Audio could not be synthesised. Check that the TTS engine is running, then try again.");
          return;
        }
        setPlaying(true);
        try {
          // Clip is in the scheduler cache → speak() plays it directly. The
          // browser fallback is explicitly forbidden for this audition.
          await speak(text, { serverTts: true, voice, act: "question", profileId: voice, noBrowserFallback: true });
        } finally {
          setPlaying(false);
        }
        return;
      } catch {
        clearInterval(ticker);
        setWaiting(false);
        cancelWaitRef.current = null;
        return;
      }
    }
    setPlaying(true);
    try {
      await speak(text, { serverTts: false, voice, act: "question", profileId: voice });
    } finally {
      setPlaying(false);
    }
  }

  function stop() {
    cancelWaitRef.current?.();
    cancelWaitRef.current = null;
    stopSpeaking();
    setWaiting(false);
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
        {show3D && avatar3dOn && (
          <ExaminerAvatar3D gender={gender} modelId={modelId} speaking={playing} listening={false} preparing={false} name={examinerName} className="h-44 w-44 shrink-0" />
        )}
        {show3D && !avatar3dOn && (
          <div className="grid h-44 w-44 shrink-0 place-items-center rounded-2xl border border-dashed border-zinc-300 text-center">
            <div className="px-3">
              <p className="text-xs leading-4 text-zinc-400">The 3D examiner is not loaded yet — nothing downloads until you ask for it.</p>
              <button onClick={activate3D} className="mt-2 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700">
                Load 3D examiner
              </button>
            </div>
          </div>
        )}
        {!show3D && (
          <div className="grid h-44 w-44 shrink-0 place-items-center rounded-2xl border border-dashed border-zinc-300 text-center">
            <p className="px-3 text-xs leading-4 text-zinc-400">3D examiner is off — voice audition only. No Three.js, no WebGL, no model download.</p>
          </div>
        )}
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
            <button onClick={play} disabled={playing || waiting || !text.trim()} className={`${btn} bg-zinc-900 text-white hover:bg-zinc-700`}>{waiting ? "Synthesising…" : "Play"}</button>
            <button onClick={stop} className={`${btn} border border-zinc-200`}>{waiting ? "Cancel" : "Stop"}</button>
            <button onClick={() => setText(sampleLine)} className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-50">Reset text</button>
          </div>
          {waiting && (
            <div className="mt-3" aria-live="polite">
              <div className="h-1.5 overflow-hidden rounded-full bg-zinc-200">
                <div className="h-1.5 w-1/3 animate-pulse rounded-full bg-indigo-500" />
              </div>
              <p className="mt-1.5 text-xs text-zinc-400">
                Synthesising the line with the selected voice… {waitSec}s elapsed. A cold local engine can take up to a minute — the real voice never gets swapped for a robotic fallback here.
              </p>
            </div>
          )}
          {error && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{error}</p>}
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
