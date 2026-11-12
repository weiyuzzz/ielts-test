"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { DualRecorder, RecorderError, listInputDevices, requestMicPermission, type Recording } from "@/lib/audio/recorder";
import { BrowserTranscriber, browserAsrSupported, prefetchTTS, prefetchManyTTS, speak, stopSpeaking, warmupSpeech } from "@/lib/audio/speech";
import { uploadWithRetry, postJson, UploadError } from "@/lib/audio/upload";
import { LINES } from "@/lib/speaking/examiner";
import type { SpeakingExamConfig } from "@/lib/speaking/config";

interface StepView {
  id: string; stepIndex: number; part: number; kind: string; topic: string; examinerLead: string; promptText: string; cuePoints: string[];
  generator: string; prepSeconds: number; answerSeconds: number; status: string; repeatCount: number;
  questionAudioUrl: string | null;
  answer: { id: string; status: string } | null;
}
interface SessionView {
  session: { id: string; mode: string; status: string; currentStep: number; examinerName: string; config: SpeakingExamConfig };
  steps: StepView[];
}
type Phase = "loading" | "setup" | "examiner" | "prep" | "recording" | "review" | "uploading" | "advancing" | "finishing" | "blocked" | "error";
type CountdownResult = "timeout" | "early" | "repeat" | "device" | "aborted";

interface Props { sessionId: string; voice: string; showSubtitlesDefault: boolean; serverTts: boolean; browserAsr: boolean; asrAvailable: boolean }

const uid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Exact examiner line for a step — one source of truth for speaking AND prefetching. */
function examinerLine(step: StepView, o: { first: boolean; noResponse: boolean }): string {
  const ack = o.first ? "" : o.noResponse ? LINES.noResponse : LINES.ack[step.stepIndex % LINES.ack.length];
  return step.kind === "cue_card"
    ? [ack, step.examinerLead, "Here is your topic."].filter(Boolean).join(" ")
    : [ack, step.examinerLead, step.promptText].filter(Boolean).join(" ");
}

/**
 * Every line this session could possibly speak, in play order. The whole script
 * is known before the candidate presses "begin", so synthesis can happen during
 * the setup screen instead of blocking the examiner's first question.
 */
function examLines(v: SessionView): string[] {
  const out: string[] = [];
  const add = (s?: string) => { if (s?.trim()) out.push(s); };
  const answered = v.steps.some((s) => s.status === "answered");
  const current = v.steps.find((s) => s.stepIndex === v.session.currentStep);
  // 1) the first line must be ready before anything else
  if (current && current.status !== "answered") add(examinerLine(current, { first: !answered, noResponse: false }));
  // 2) fixed script lines
  add(LINES.part2Start);
  add(LINES.closing);
  add(`${LINES.noResponse.split(".")[0]}. ${LINES.closing}`);
  // 3) every remaining step, both acknowledgement variants and the repeat form
  for (const step of v.steps) {
    if (step.status === "answered") continue;
    add(examinerLine(step, { first: false, noResponse: false }));
    add(examinerLine(step, { first: false, noResponse: true }));
    if (step.kind !== "cue_card") add(`${LINES.repeatPrefix} ${step.promptText}`);
  }
  return [...new Set(out)];
}

export function ExamRunner({ sessionId, voice, showSubtitlesDefault, serverTts, browserAsr, asrAvailable }: Props) {
  const router = useRouter();
  const [view, setView] = useState<SessionView | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [subtitle, setSubtitle] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [showSubs, setShowSubs] = useState(showSubtitlesDefault);
  const [cd, setCd] = useState({ left: 0, total: 0 });
  const [canEarly, setCanEarly] = useState(false);
  const [level, setLevel] = useState(0);
  const [progress, setProgress] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ title: string; message: string; action: string } | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [review, setReview] = useState<{ url: string; transcript: string } | null>(null);
  const [online, setOnline] = useState(true);
  const [liveText, setLiveText] = useState("");
  const [current, setCurrent] = useState<StepView | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const recRef = useRef<DualRecorder | null>(null);
  const trRef = useRef<BrowserTranscriber | null>(null);
  const cdResolve = useRef<((r: CountdownResult) => void) | null>(null);
  const userAction = useRef<((v: string) => void) | null>(null);
  const prevNoResponse = useRef(false);
  const levelTs = useRef(0);

  const load = useCallback(async (): Promise<SessionView> => {
    const res = await fetch(`/api/speaking/sessions/${sessionId}`, { cache: "no-store" });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || "Could not load exam");
    setView(j);
    return j;
  }, [sessionId]);

  useEffect(() => {
    warmupSpeech();
    let cancelled = false;
    // Deferred so the effect body has no synchronous setState and SSR stays
    // deterministic (localStorage is only available in the browser).
    const t = setTimeout(() => {
      load()
        .then((v) => {
          if (cancelled) return;
          // Synthesise the entire script while the candidate reads the setup screen.
          // By the time they grant microphone access, the first line is already buffered.
          prefetchManyTTS(examLines(v), voice, serverTts);
          if (v.session.status === "completed") router.replace(`/speaking/report/${sessionId}`);
          else if (v.session.status === "abandoned") { setFatal("This exam was ended early and can no longer be continued."); setPhase("error"); }
          else setPhase("setup");
        })
        .catch((e) => { if (!cancelled) { setFatal(e.message); setPhase("error"); } });
      setDeviceId(localStorage.getItem("mic-device") || "");
      setOnline(navigator.onLine);
    }, 0);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      clearTimeout(t);
      cancelled = true;
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      abortRef.current?.abort();
      recRef.current?.cleanup();
      stopSpeaking();
    };
  }, [load, router, sessionId, serverTts, voice]);

  // Warn before leaving while the exam is running (state is saved server-side, but the current answer would be lost)
  useEffect(() => {
    const running = ["examiner", "prep", "recording", "review", "uploading"].includes(phase);
    const h = (e: BeforeUnloadEvent) => { if (running) e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [phase]);

  const waitUser = () => new Promise<string>((res) => { userAction.current = res; });
  const act = (v: string) => { const f = userAction.current; userAction.current = null; f?.(v); };

  function countdown(seconds: number, earlyAfter: number, signal: AbortSignal): Promise<CountdownResult> {
    return new Promise((resolve) => {
      const start = Date.now();
      setCd({ left: seconds, total: seconds });
      setCanEarly(earlyAfter <= 0);
      let done = false;
      const finish = (r: CountdownResult) => {
        if (done) return;
        done = true;
        clearInterval(t);
        cdResolve.current = null;
        setCanEarly(false);
        resolve(r);
      };
      const t = setInterval(() => {
        const el = (Date.now() - start) / 1000;
        setCd({ left: Math.max(0, Math.ceil(seconds - el)), total: seconds });
        if (el >= earlyAfter) setCanEarly(true);
        if (el >= seconds) finish("timeout");
      }, 250);
      cdResolve.current = finish;
      signal.addEventListener("abort", () => finish("aborted"));
    });
  }

  /** Pre-recorded examiner audio from the bank takes priority over TTS. */
  function playPresetAudio(url: string, signal: AbortSignal): Promise<boolean> {
    const audio = new Audio(url);
    audio.preload = "auto";
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        audio.pause();
        signal.removeEventListener("abort", onAbort);
        resolve(ok);
      };
      const onAbort = () => finish(false);
      audio.onended = () => finish(true);
      audio.onerror = () => finish(false);
      signal.addEventListener("abort", onAbort, { once: true });
      void audio.play().catch(() => finish(false));
    });
  }

  async function say(text: string, signal: AbortSignal, audioUrl?: string | null) {
    if (signal.aborted) return;
    setSubtitle(text);
    setSpeaking(true);
    setPhase("examiner");
    if (audioUrl && (await playPresetAudio(audioUrl, signal))) {
      setSpeaking(false);
      return;
    }
    const r = await speak(text, { serverTts, voice, signal });
    setSpeaking(false);
    if (!r.ok && !signal.aborted) setNotice("The examiner voice is unavailable in this browser. Read the question on screen instead.");
  }

  async function record(step: StepView, signal: AbortSignal, cfg: SpeakingExamConfig): Promise<{ rec: Recording; transcript: string } | null> {
    let repeats = step.repeatCount;
    for (;;) {
      // start microphone (with recovery UI)
      const rec = new DualRecorder();
      for (;;) {
        try {
          rec.onLevel = (l) => { const now = performance.now(); if (now - levelTs.current > 80) { levelTs.current = now; setLevel(l); } };
          rec.onError = () => cdResolve.current?.("device");
          await rec.start(deviceId || undefined);
          break;
        } catch (e) {
          rec.cleanup();
          const err = e as RecorderError;
          setDevices(await listInputDevices().catch(() => []));
          setBlocked({ title: "Microphone problem", message: err.message, action: "retry-mic" });
          setPhase("blocked");
          await waitUser();
          setBlocked(null);
          if (signal.aborted) return null;
        }
      }
      recRef.current = rec;
      let tr: BrowserTranscriber | null = null;
      if (browserAsr) {
        tr = new BrowserTranscriber();
        tr.onUpdate = (t) => setLiveText(t);
        tr.start();
        trRef.current = tr;
      }
      setLiveText("");
      setPhase("recording");
      const r = await countdown(step.answerSeconds, cfg.minFinishSeconds, signal);
      const recording = await rec.stop();
      recRef.current = null;
      const transcript = tr ? await tr.stop() : "";
      setLevel(0);
      if (r === "aborted") return null;
      if (r === "repeat") {
        try {
          await postJson(`/api/speaking/sessions/${sessionId}/repeat`, { examQuestionId: step.id });
          repeats++;
          await say(`${LINES.repeatPrefix} ${step.promptText}`, signal);
        } catch (e) {
          setNotice((e as Error).message);
        }
        continue;
      }
      if (r === "device") setNotice("Your microphone was disconnected. The answer so far has been kept. Check the device before the next question.");
      if (cfg.allowRerecord && recording.durationMs > 500) {
        const url = URL.createObjectURL(recording.blob ?? recording.wav ?? new Blob());
        setReview({ url, transcript });
        setPhase("review");
        const choice = await waitUser();
        URL.revokeObjectURL(url);
        setReview(null);
        if (choice === "rerecord") continue;
      }
      void repeats;
      return { rec: recording, transcript };
    }
  }

  async function submit(step: StepView, data: { rec: Recording; transcript: string }, signal: AbortSignal, cfg: SpeakingExamConfig) {
    const idem = uid();
    for (;;) {
      const fd = new FormData();
      fd.append("examQuestionId", step.id);
      fd.append("idempotencyKey", idem);
      fd.append("durationMs", String(data.rec.durationMs));
      const ext = (m: string) => (m.includes("mp4") ? "m4a" : m.includes("ogg") ? "ogg" : m.includes("wav") ? "wav" : "webm");
      if (data.rec.blob && data.rec.blob.size <= cfg.maxUploadBytes) fd.append("audio", data.rec.blob, `answer.${ext(data.rec.blob.type)}`);
      if (data.rec.wav && data.rec.wav.size <= cfg.maxUploadBytes) fd.append("wav", data.rec.wav, "answer.wav");
      if (data.transcript) fd.append("browserTranscript", data.transcript);
      setPhase("uploading");
      setProgress(0);
      try {
        const r = await uploadWithRetry<{ status: string }>(`/api/speaking/sessions/${sessionId}/answers`, fd, {
          onProgress: setProgress,
          onRetry: (n, e) => setNotice(`Upload problem (${e.message}). Retrying… (${n})`),
        });
        setProgress(null);
        setNotice(null);
        prevNoResponse.current = r.status === "no_response";
        return true;
      } catch (e) {
        setProgress(null);
        const err = e as UploadError;
        if (err.status === 409) return true; // server already has an answer for this step → resync
        setBlocked({ title: "Upload failed", message: `${err.message}. Your recording is still on this device.`, action: "retry-upload" });
        setPhase("blocked");
        await waitUser();
        setBlocked(null);
        if (signal.aborted) return false;
      }
    }
  }

  async function run() {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const signal = ctrl.signal;
    // unlock audio output on iOS/Safari inside the user gesture
    try { if ("speechSynthesis" in window) speechSynthesis.speak(new SpeechSynthesisUtterance("")); } catch {}
    try {
      let v = await load();
      let first = !v.steps.some((s) => s.status === "answered");
      // The full script (including fixed lines) was queued on the setup screen.
      while (!signal.aborted) {
        const cfg = v.session.config;
        const step = v.steps.find((s) => s.stepIndex === v.session.currentStep);
        if (!step) throw new Error("Exam step not found");
        setCurrent(step);
        if (step.status !== "answered") {
          const line = examinerLine(step, { first, noResponse: prevNoResponse.current });
          first = false;
          if (step.kind === "cue_card") {
            await say(line, signal, step.questionAudioUrl);
            setPhase("prep");
            await countdown(step.prepSeconds, 10, signal);
            if (signal.aborted) return;
            await say(LINES.part2Start, signal);
          } else {
            await say(line, signal, step.questionAudioUrl);
          }
          if (signal.aborted) return;
          // While the user records this answer, synthesise the next question in the
          // background so the examiner starts speaking with no gap (server TTS only).
          if (serverTts) {
            const next = v.steps.find((s) => s.stepIndex === step.stepIndex + 1 && s.status !== "answered");
            if (next) {
              prefetchTTS(examinerLine(next, { first: false, noResponse: false }), voice, true);
              if (next.kind === "cue_card") prefetchTTS(LINES.part2Start, voice, true);
            }
          }
          const data = await record(step, signal, cfg);
          if (!data) return;
          // The examiner stops the candidate at 2 minutes, as in the real test.
          if (step.kind === "cue_card" && !signal.aborted) await say(LINES.part2TimeUp, signal);
          if (!(await submit(step, data, signal, cfg))) return;
        }
        setPhase("advancing");
        let adv: { finished?: boolean };
        try {
          adv = await postJson<{ finished?: boolean }>(`/api/speaking/sessions/${sessionId}/advance`, { fromStep: step.stepIndex });
        } catch (e) {
          if ((e as UploadError).status === 409) { v = await load(); continue; }
          throw e;
        }
        if (adv.finished) {
          setPhase("finishing");
          await say(prevNoResponse.current ? `${LINES.noResponse.split(".")[0]}. ${LINES.closing}` : LINES.closing, signal);
          setPhase("finishing");
          await postJson(`/api/speaking/sessions/${sessionId}/finish`);
          router.replace(`/speaking/report/${sessionId}`);
          return;
        }
        v = await load();
        // A Part 3 follow-up can be inserted by the state machine at advance time;
        // queue any lines that were not part of the original plan.
        if (serverTts) prefetchManyTTS(examLines(v), voice, true);
      }
    } catch (e) {
      if (!signal.aborted) { setFatal((e as Error).message); setPhase("error"); }
    }
  }

  async function startFromSetup() {
    try {
      await requestMicPermission(deviceId || undefined);
      setDevices(await listInputDevices());
      setNotice(null);
      run();
    } catch (e) {
      setDevices(await listInputDevices().catch(() => []));
      setNotice((e as Error).message);
    }
  }

  async function exitExam() {
    if (!confirm("End this exam now? Your answers so far are saved, but the exam cannot be resumed or scored.")) return;
    abortRef.current?.abort();
    recRef.current?.cleanup();
    stopSpeaking();
    act("abort");
    await postJson(`/api/speaking/sessions/${sessionId}/abandon`).catch(() => {});
    router.push("/speaking");
  }

  // ------------------------------------------------------------------ render
  const cfg = view?.session.config;
  const steps = view?.steps ?? [];
  const parts = [...new Set(steps.map((s) => s.part))];
  const answered = steps.filter((s) => s.status === "answered").length;
  const pct = cd.total ? cd.left / cd.total : 0;
  const mmss = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
  const step = current;
  const repeatsLeft = step && cfg ? cfg.maxRepeatsPerQuestion - step.repeatCount : 0;

  if (phase === "error") {
    return (
      <div className="grid min-h-screen place-items-center bg-zinc-50 p-6">
        <div className="max-w-md rounded-2xl border border-zinc-200 bg-white p-8 text-center">
          <h1 className="text-lg font-semibold">Exam unavailable</h1>
          <p className="mt-2 text-sm text-zinc-500">{fatal}</p>
          <div className="mt-6 flex justify-center gap-3">
            <button onClick={() => location.reload()} className="rounded-lg border border-zinc-200 px-4 py-2 text-sm">Reload</button>
            <Link href="/speaking" className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white">Back to Speaking</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 text-zinc-900">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-zinc-900 text-xs font-bold text-white">B9</span>
          <div className="hidden text-sm font-medium sm:block">{view?.session.mode === "full" ? "Speaking mock test" : "Speaking practice"}</div>
        </div>
        <ol className="flex items-center gap-1.5" aria-label="Exam progress">
          {parts.map((p) => (
            <li key={p} className={`rounded-full px-2.5 py-1 text-xs font-medium ${step?.part === p ? "bg-zinc-900 text-white" : steps.filter((s) => s.part === p).every((s) => s.status === "answered") ? "bg-emerald-50 text-emerald-700" : "bg-zinc-100 text-zinc-500"}`}>Part {p}</li>
          ))}
          <li className="ml-2 hidden text-xs tabular-nums text-zinc-400 sm:block">{answered}/{steps.length}</li>
        </ol>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowSubs(!showSubs)} className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100">{showSubs ? "Hide" : "Show"} subtitles</button>
          {phase !== "setup" && phase !== "loading" && <button onClick={exitExam} className="rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-50">End exam</button>}
        </div>
      </header>
      {!online && <div className="bg-amber-50 px-4 py-2 text-center text-xs text-amber-800">You are offline. Recording continues and the upload will retry automatically when the connection returns.</div>}
      {notice && <div className="bg-zinc-900 px-4 py-2 text-center text-xs text-white">{notice} <button className="ml-2 underline" onClick={() => setNotice(null)}>Dismiss</button></div>}

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-6 sm:py-10">
        {(phase === "loading" || phase === "setup") && (
          <div className="rounded-2xl border border-zinc-200 bg-white p-6 sm:p-8">
            <h1 className="text-xl font-semibold">{answered > 0 ? "Resume your exam" : "Before you start"}</h1>
            <ul className="mt-4 space-y-2 text-sm text-zinc-600">
              <li>• Find a quiet place and use headphones if possible.</li>
              <li>• The examiner speaks each question aloud. Answer as soon as the recording starts.</li>
              <li>• Full mock: 11–14 minutes — Part 1 4–5 min (3 topics, 10–11 short questions), Part 2 3–4 min (1 min notes + 2 min talk), Part 3 4–5 min.</li>
              {cfg?.part2.enabled && <li>• Part 2: you get {cfg.part2.prepSeconds}s to prepare (keep paper ready), then speak for up to {cfg.part2.answerSeconds / 60} minutes.</li>}
              <li>• {cfg?.allowRerecord ? "Practice mode: you can listen back and re-record each answer." : "Mock mode: one attempt per question, as in the real test."}</li>
              {answered > 0 && <li className="font-medium text-zinc-900">• {answered} answers are already saved. You will continue from question {(view?.session.currentStep ?? 0) + 1}.</li>}
            </ul>
            {!asrAvailable && <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">No speech recognition is configured. Your answers will be recorded, but they cannot be transcribed or scored.</p>}
            {browserAsr && !browserAsrSupported() && <p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">This browser does not support built-in speech recognition. Use Chrome, Edge or Safari, or ask the administrator to configure server ASR. Recordings will still be saved.</p>}
            <label className="mt-6 block text-sm">Microphone
              <select className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm" value={deviceId} onChange={(e) => { setDeviceId(e.target.value); localStorage.setItem("mic-device", e.target.value); }}>
                <option value="">System default</option>
                {devices.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}
              </select>
            </label>
            <button disabled={phase === "loading"} onClick={startFromSetup} className="mt-6 w-full rounded-xl bg-zinc-900 py-3 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50">
              {phase === "loading" ? "Loading…" : answered > 0 ? "Allow microphone & resume" : "Allow microphone & begin"}
            </button>
          </div>
        )}

        {phase === "blocked" && blocked && (
          <div className="rounded-2xl border border-amber-200 bg-white p-6">
            <h2 className="font-semibold text-amber-800">{blocked.title}</h2>
            <p className="mt-2 text-sm text-zinc-600">{blocked.message}</p>
            {blocked.action === "retry-mic" && (
              <select className="mt-4 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm" value={deviceId} onChange={(e) => { setDeviceId(e.target.value); localStorage.setItem("mic-device", e.target.value); }}>
                <option value="">System default</option>
                {devices.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}
              </select>
            )}
            <button onClick={() => act("retry")} className="mt-4 rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white">Try again</button>
          </div>
        )}

        {step && !["setup", "loading", "blocked"].includes(phase) && (
          <>
            <div className="flex items-center gap-3">
              <div className={`grid h-11 w-11 place-items-center rounded-full bg-zinc-900 text-sm font-semibold text-white ${speaking ? "ring-4 ring-indigo-200" : ""}`}>{view?.session.examinerName[0]}</div>
              <div>
                <div className="text-sm font-medium">{view?.session.examinerName} · Examiner</div>
                <div className="text-xs text-zinc-400">{speaking ? "Speaking…" : phase === "recording" ? "Listening" : phase === "prep" ? "Waiting while you prepare" : phase === "uploading" || phase === "advancing" ? "Saving your answer…" : phase === "finishing" ? "Finishing the test" : ""}</div>
              </div>
            </div>
            {showSubs && subtitle && <p className="mt-4 rounded-xl bg-white px-4 py-3 text-sm leading-6 text-zinc-600 ring-1 ring-zinc-200">{subtitle}</p>}

            <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-6 sm:p-8">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
                <span>Part {step.part}</span><span>·</span><span>{step.topic}</span>
                {step.kind === "follow_up" && <span className="rounded bg-indigo-50 px-1.5 py-0.5 normal-case text-indigo-700">follow-up · {step.generator}</span>}
              </div>
              {step.kind === "cue_card" ? (
                <div>
                  <h2 className="text-lg font-semibold leading-7 sm:text-xl">{step.promptText}</h2>
                  <p className="mt-4 text-sm text-zinc-500">You should say:</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-zinc-800">{step.cuePoints.map((c) => <li key={c}>{c}</li>)}</ul>
                  {phase === "prep" && <textarea placeholder="Notes (not saved or assessed)" className="mt-5 h-28 w-full resize-none rounded-lg border border-zinc-200 p-3 text-sm outline-none focus:border-zinc-400" />}
                </div>
              ) : (
                <h2 className={`text-lg font-semibold leading-7 sm:text-xl ${showSubs || phase !== "examiner" ? "" : "blur-sm"}`}>{step.promptText}</h2>
              )}
            </section>

            <section className="mt-6 flex flex-col items-center">
              {(phase === "recording" || phase === "prep") && (
                <>
                  <div className="relative grid h-36 w-36 place-items-center">
                    <svg viewBox="0 0 100 100" className="absolute inset-0 -rotate-90">
                      <circle cx="50" cy="50" r="45" fill="none" stroke="#e4e4e7" strokeWidth="5" />
                      <circle cx="50" cy="50" r="45" fill="none" stroke={phase === "recording" ? "#dc2626" : "#18181b"} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${pct * 283} 283`} />
                    </svg>
                    <div className="text-center">
                      <div className="text-3xl font-semibold tabular-nums">{mmss(cd.left)}</div>
                      <div className="text-xs text-zinc-400">{phase === "recording" ? "Recording" : "Preparation"}</div>
                    </div>
                  </div>
                  {phase === "recording" && (
                    <div className="mt-4 flex h-8 items-end gap-1" aria-label="Input level">
                      {Array.from({ length: 16 }).map((_, i) => (
                        <span key={i} className="w-1.5 rounded-full bg-red-500 transition-all" style={{ height: `${Math.max(4, Math.min(32, level * 32 * (0.6 + 0.4 * Math.sin(i * 1.7 + level * 10))))}px`, opacity: level > i / 20 ? 1 : 0.25 }} />
                      ))}
                    </div>
                  )}
                  {phase === "recording" && browserAsr && cfg?.showTranscriptLive && liveText && <p className="mt-3 max-w-xl text-center text-xs text-zinc-400">{liveText}</p>}
                  <div className="mt-5 flex flex-wrap justify-center gap-3">
                    {phase === "recording" && repeatsLeft > 0 && step.kind !== "cue_card" && (
                      <button onClick={() => cdResolve.current?.("repeat")} className="rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm">Ask to repeat ({repeatsLeft})</button>
                    )}
                    <button disabled={!canEarly} onClick={() => cdResolve.current?.("early")} className="rounded-lg bg-zinc-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-30">
                      {phase === "prep" ? "Start speaking now" : "Finish answer"}
                    </button>
                  </div>
                  {phase === "recording" && !canEarly && <p className="mt-2 text-xs text-zinc-400">You can finish after {cfg?.minFinishSeconds}s</p>}
                </>
              )}
              {phase === "review" && review && (
                <div className="w-full rounded-2xl border border-zinc-200 bg-white p-5">
                  <div className="mb-2 text-sm font-medium">Listen back</div>
                  <audio controls src={review.url} className="w-full" />
                  {review.transcript && <p className="mt-3 text-sm text-zinc-600"><span className="text-xs uppercase tracking-wide text-zinc-400">Recognised: </span>{review.transcript}</p>}
                  <div className="mt-4 flex gap-3">
                    <button onClick={() => act("rerecord")} className="rounded-lg border border-zinc-200 px-4 py-2 text-sm">Re-record</button>
                    <button onClick={() => act("submit")} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white">Submit answer</button>
                  </div>
                </div>
              )}
              {(phase === "uploading" || phase === "advancing" || phase === "finishing") && (
                <div className="w-full max-w-sm text-center text-sm text-zinc-500">
                  {phase === "uploading" ? "Uploading answer…" : phase === "advancing" ? "Next question…" : "Submitting your test for scoring…"}
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-200">
                    <div className={`h-1.5 rounded-full bg-zinc-900 transition-all ${progress === null ? "w-1/3 animate-pulse" : ""}`} style={progress !== null ? { width: `${Math.round(progress * 100)}%` } : undefined} />
                  </div>
                </div>
              )}
              {phase === "examiner" && <div className="text-sm text-zinc-400">Listen to the examiner…</div>}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
