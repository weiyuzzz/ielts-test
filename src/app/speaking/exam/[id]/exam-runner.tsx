"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { RecorderError, listInputDevices, type Recording } from "@/lib/audio/recorder";
import { RecordingSession } from "@/lib/audio/recording-session";
import {
  BrowserTranscriber, browserAsrSupported, speak, speakPreset, disposeAudio,
  warmupSpeech, promoteTTS, audioMetrics, type ScriptLine,
} from "@/lib/audio/speech";
import { AudioPreloader, classifyScriptLines, type PreloadEntry } from "@/lib/audio/audio-resources";
import { outcomeOf, type PlaybackOutcome } from "@/lib/audio/audio-lifecycle";
import { uploadWithRetry, postJson, UploadError } from "@/lib/audio/upload";
import { LINES } from "@/lib/speaking/examiner";
import type { SpeakingExamConfig } from "@/lib/speaking/config";
import type { ExaminerSpeechAct } from "@/lib/speaking/speech-act";

interface StepView {
  id: string; stepIndex: number; part: number; kind: string; topic: string; examinerLead: string; promptText: string; cuePoints: string[];
  generator: string; prepSeconds: number; answerSeconds: number; status: string; repeatCount: number;
  questionAudioUrl: string | null;
  /** VoiceProfile the pre-recorded clip was made with; null when unknown. */
  questionVoiceProfile: string | null;
  answer: { id: string; status: string } | null;
}
interface SessionView {
  session: {
    id: string; mode: string; status: string; currentStep: number; examinerName: string;
    config: SpeakingExamConfig;
    /** Frozen at session creation, so a settings change cannot change the examiner mid-test. */
    voiceProfile: { id: string; voice: string; provider: string } | null;
  };
  steps: StepView[];
}
/** Response of the unified complete-answer endpoint. */
interface CompleteResponse {
  answer: { answerId: string; status: string; duplicate: boolean; asrDurationMs: number };
  advance: { currentStep: number; finished?: boolean; duplicate?: boolean; partChanged?: boolean; followUp?: { text: string; generator: string } };
  timings: { submitMs: number; advanceMs: number };
  view: SessionView;
}
type Phase = "loading" | "setup" | "examiner" | "prep" | "recording" | "review" | "uploading" | "advancing" | "finishing" | "blocked" | "error";
type CountdownResult = "timeout" | "early" | "repeat" | "device" | "aborted";

interface Props {
  sessionId: string; voice: string; showSubtitlesDefault: boolean; serverTts: boolean;
  browserAsr: boolean; asrAvailable: boolean;
  /** Engine identity for the TTS cache key (model/format changes must not reuse old audio). */
  ttsModel?: string | null; ttsFormat?: string | null;
}

const uid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * Exact examiner utterance for a step — one source of truth for speaking AND
 * prefetching. Each part keeps its own delivery: a short acknowledgement, the
 * step's lead-in (greeting on the very first turn, introduction afterwards) and
 * the question itself.
 */
function examinerLines(step: StepView, o: { first: boolean; noResponse: boolean }): ScriptLine[] {
  const out: ScriptLine[] = [];
  if (!o.first) {
    out.push({
      text: o.noResponse ? LINES.noResponse : LINES.ack[step.stepIndex % LINES.ack.length],
      act: "acknowledgement",
    });
  }
  if (step.examinerLead) out.push({ text: step.examinerLead, act: o.first ? "greeting" : "introduction" });
  if (step.kind === "cue_card") out.push({ text: "Here is your topic.", act: "instruction" });
  else out.push({ text: step.promptText, act: "question" });
  return out.filter((l) => l.text.trim());
}

/** Joined text for the on-screen subtitle (the whole utterance as one block). */
const lineText = (lines: ScriptLine[]) => lines.map((l) => l.text).filter(Boolean).join(" ");

/**
 * A bank recording may only replace the generated voice when it is known to be
 * the SAME voice. An unlabelled clip, or one recorded with another profile, could
 * be a different person — skip it instead of switching examiner mid-test.
 */
function presetAudioFor(step: StepView, profileId: string): string | null {
  if (!step.questionAudioUrl) return null;
  if (!step.questionVoiceProfile || step.questionVoiceProfile !== profileId) return null;
  return step.questionAudioUrl;
}

/** True when the previous answer was classified as "no response" (used on resume). */
function currentNoResponse(v: SessionView): boolean {
  return v.steps.find((s) => s.stepIndex === v.session.currentStep - 1)?.answer?.status === "no_response";
}

interface ScriptPlan {
  entries: PreloadEntry[];
  presetUrls: string[];
  /** The first utterance, line by line — exactly what `say()` will speak. */
  firstLines: ScriptLine[];
  firstQuestionAudioUrl: string | null;
}

/**
 * Build a PRIORITISED resource plan for the whole session. Unlike the old
 * `examLines()` (which flattened everything into one FIFO order), backups and
 * repeat forms are explicitly LOW so they can never delay a real question.
 */
function buildScriptPlan(v: SessionView, profileId: string): ScriptPlan {
  const answered = v.steps.some((s) => s.status === "answered");
  const current = v.steps.find((s) => s.stepIndex === v.session.currentStep);
  const noResponse = currentNoResponse(v);
  const firstLines: ScriptLine[] = current && current.status !== "answered"
    ? examinerLines(current, { first: !answered, noResponse })
    : [];
  const remaining = v.steps.filter((s) => s.status !== "answered");
  const nextLines: ScriptLine[] = [];
  const rest: ScriptLine[] = [];
  const backups: ScriptLine[] = [];
  for (const step of remaining) {
    for (const line of examinerLines(step, { first: false, noResponse: false })) {
      if (step.stepIndex === (current?.stepIndex ?? -1) + 1) nextLines.push(line);
      else if (step !== current) rest.push(line);
    }
    for (const line of examinerLines(step, { first: false, noResponse: true })) backups.push(line);
    if (step.kind !== "cue_card") backups.push({ text: `${LINES.repeatPrefix} ${step.promptText}`, act: "question" });
  }
  const fixed: ScriptLine[] = [
    { text: LINES.part2Start, act: "instruction" },
    { text: LINES.part2TimeUp, act: "time_warning" },
    { text: LINES.closing, act: "closing" },
    { text: `${LINES.noResponse.split(".")[0]}. ${LINES.closing}`, act: "closing" },
  ];
  const entries = classifyScriptLines({ opening: firstLines, first: firstLines, next: nextLines, rest, fixed, backups });
  return {
    entries,
    presetUrls: remaining.map((s) => presetAudioFor(s, profileId)).filter((u): u is string => !!u),
    firstLines,
    firstQuestionAudioUrl: current ? presetAudioFor(current, profileId) : null,
  };
}

export function ExamRunner({ sessionId, voice, showSubtitlesDefault, serverTts, browserAsr, asrAvailable, ttsModel, ttsFormat }: Props) {
  const router = useRouter();
  const [view, setView] = useState<SessionView | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [subtitle, setSubtitle] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [showSubs, setShowSubs] = useState(showSubtitlesDefault);
  const [cd, setCd] = useState({ left: 0, total: 0 });
  const [canEarly, setCanEarly] = useState(false);
  const [level, setLevel] = useState(0);
  /** Rolling input envelope (oldest → newest) so the bars move like a real meter. */
  const [bars, setBars] = useState<number[]>(() => new Array(32).fill(0));
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
  /** Dev-only: shows how many preloaded resources are ready (subscribable state). */
  const [readiness, setReadiness] = useState<{ ready: number; total: number } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const recSessionRef = useRef<RecordingSession | null>(null);
  const trRef = useRef<BrowserTranscriber | null>(null);
  const preloaderRef = useRef<AudioPreloader | null>(null);
  const planRef = useRef<ScriptPlan | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const cdResolve = useRef<((r: CountdownResult) => void) | null>(null);
  const userAction = useRef<((v: string) => void) | null>(null);
  const prevNoResponse = useRef(false);
  const levelTs = useRef(0);
  /** Voice profile frozen when this session was created (falls back to the current
   *  setting only for sessions recorded before profiles existed). */
  const voiceRef = useRef(voice);

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
    const t = setTimeout(() => {
      load()
        .then((v) => {
          if (cancelled) return;
          // The session froze its voice when it was created; the current setting
          // must never change the examiner halfway through a test.
          const profileId = v.session.voiceProfile?.id ?? voice;
          voiceRef.current = profileId;
          // One coordinator for TTS + preset bank audio + fixed examiner lines.
          const preloader = new AudioPreloader({ voice: profileId, profile: profileId, serverTts, model: ttsModel, format: ttsFormat });
          preloaderRef.current = preloader;
          const unsub = preloader.subscribe((s) => setReadiness({ ready: s.readyCount, total: s.totalCount }));
          unsubscribeRef.current = unsub;
          const plan = buildScriptPlan(v, profileId);
          planRef.current = plan;
          // Fire-and-forget: the exam never waits for the whole backup script.
          preloader.prepareScript(plan.entries, plan.presetUrls);
          prevNoResponse.current = currentNoResponse(v);
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
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      abortRef.current?.abort();
      recSessionRef.current?.dispose();
      recSessionRef.current = null;
      trRef.current?.stop().catch(() => {});
      preloaderRef.current?.dispose();
      preloaderRef.current = null;
      disposeAudio();
    };
  }, [load, router, sessionId, serverTts, voice, ttsModel, ttsFormat]);

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

  /**
   * Play one examiner line. Returns an EXPLICIT lifecycle outcome so a failed
   * or interrupted play can never be mistaken for a completed one.
   * On failure we keep the on-screen subtitle (the original degradation) but
   * require the candidate to acknowledge before recording starts — the exam
   * must not silently advance on broken audio.
   */
  async function say(lines: ScriptLine[] | string, signal: AbortSignal, audioUrl?: string | null): Promise<PlaybackOutcome> {
    const queue: ScriptLine[] = typeof lines === "string" ? [{ text: lines, act: "question" }] : lines;
    const full = lineText(queue);
    if (signal.aborted || !full.trim()) return outcomeOf("interrupted", "none", { aborted: true });
    setSubtitle(full);
    setSpeaking(true);
    setPhase("examiner");
    const profileId = voiceRef.current;
    for (const l of queue) promoteTTS(l.text, profileId, l.act, profileId);
    try {
      let outcome: PlaybackOutcome | null = null;
      if (audioUrl) {
        const preset = await speakPreset(audioUrl, signal);
        if (preset.status === "ended" || preset.status === "interrupted") outcome = preset;
        // failed → fall through to TTS (pre-recorded audio is optional)
      }
      if (!outcome) {
        // Speak each part with its own delivery: the acknowledgement stays short
        // and warm, the lead-in is an introduction, the question rises naturally.
        for (const l of queue) {
          if (signal.aborted) return outcomeOf("interrupted", "none", { aborted: true });
          if (!l.text.trim()) continue;
          const r = await speak(l.text, { serverTts, voice: profileId, act: l.act, profileId, signal });
          outcome = r.outcome;
          if (!r.ok) break;
        }
      }
      if (!outcome) outcome = outcomeOf("failed", "none");
      if (outcome.status === "failed" && !signal.aborted) {
        setNotice("The examiner voice is unavailable in this browser. Read the question on screen instead.");
        setBlocked({ title: "Examiner audio unavailable", message: "The examiner voice could not be played. Read the question in the subtitles, then continue when you are ready.", action: "continue-anyway" });
        setPhase("blocked");
        await waitUser();
        setBlocked(null);
        if (signal.aborted) return outcomeOf("interrupted", outcome.via, { aborted: true });
      }
      return outcome;
    } finally {
      setSpeaking(false);
    }
  }

  /** One RecordingSession owns the mic + AudioContext for the WHOLE exam. */
  async function record(step: StepView, signal: AbortSignal, cfg: SpeakingExamConfig): Promise<{ rec: Recording; transcript: string } | null> {
    const rs = recSessionRef.current;
    if (!rs) throw new Error("Recording session is not ready");
    let repeats = step.repeatCount;
    for (;;) {
      try {
        // One RecordingSession owns the mic + AudioContext for the whole exam; each
        // answer only swaps the MediaRecorder/PCM buffer, so starting is instant.
        rs.onLevel = (l) => {
          const now = performance.now();
          if (now - levelTs.current < 70) return;
          levelTs.current = now;
          setLevel(l);
          // Fast attack, slow release — the classic behaviour of a recording meter.
          setBars((prev) => {
            const next = prev.slice(1);
            next.push(Math.max(l, (prev[prev.length - 1] ?? 0) * 0.55));
            return next;
          });
        };
        rs.onError = (e) => { if (e.code === "device_disconnected") cdResolve.current?.("device"); };
        rs.startAnswer(); // fresh MediaRecorder + PCM buffer, SAME stream/context
      } catch (e) {
        const err = e as RecorderError;
        setDevices(await listInputDevices().catch(() => []));
        setBlocked({ title: "Microphone problem", message: err.message, action: "retry-mic" });
        setPhase("blocked");
        await waitUser();
        setBlocked(null);
        if (signal.aborted) return null;
        try { await rs.reopen(deviceId || undefined); }
        catch (e2) { setNotice((e2 as Error).message); return null; }
        continue;
      }
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
      const recording = await rs.stopAnswer();
      const transcript = tr ? await tr.stop() : "";
      trRef.current = null;
      setLevel(0);
      setBars(new Array(32).fill(0));
      if (r === "aborted") return null;
      if (r === "repeat") {
        try {
          await postJson(`/api/speaking/sessions/${sessionId}/repeat`, { examQuestionId: step.id });
          repeats++;
          const o = await say([{ text: `${LINES.repeatPrefix} ${step.promptText}`, act: "question" }], signal);
          if (o.status === "interrupted") return null;
        } catch (e) {
          setNotice((e as Error).message);
        }
        continue;
      }
      if (r === "device") {
        setNotice("Your microphone was disconnected. The answer so far has been kept. Check the device before the next question.");
        try { await rs.reopen(deviceId || undefined); } catch { /* next answer will surface the error */ }
      }
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

  /** ONE round trip: answer + authoritative advance + full next-step view. */
  async function submitAndAdvance(step: StepView, data: { rec: Recording; transcript: string }, signal: AbortSignal, cfg: SpeakingExamConfig): Promise<CompleteResponse | null> {
    const idem = uid();
    const fd = new FormData();
    fd.append("examQuestionId", step.id);
    fd.append("idempotencyKey", idem);
    fd.append("durationMs", String(data.rec.durationMs));
    fd.append("fromStep", String(step.stepIndex));
    const ext = (m: string) => (m.includes("mp4") ? "m4a" : m.includes("ogg") ? "ogg" : m.includes("wav") ? "wav" : "webm");
    if (data.rec.blob && data.rec.blob.size <= cfg.maxUploadBytes) fd.append("audio", data.rec.blob, `answer.${ext(data.rec.blob.type)}`);
    if (data.rec.wav && data.rec.wav.size <= cfg.maxUploadBytes) fd.append("wav", data.rec.wav, "answer.wav");
    if (data.transcript) fd.append("browserTranscript", data.transcript);

    for (;;) {
      setPhase("uploading");
      setProgress(0);
      const t0 = performance.now();
      try {
        const r = await uploadWithRetry<CompleteResponse>(`/api/speaking/sessions/${sessionId}/complete-answer`, fd, {
          onProgress: setProgress,
          onRetry: (n, e) => setNotice(`Upload problem (${e.message}). Retrying… (${n})`),
        });
        audioMetrics.record("upload_duration_ms", performance.now() - t0, "none");
        audioMetrics.record("asr_duration_ms", r.answer?.asrDurationMs ?? 0, "none", "server sync ASR");
        audioMetrics.record("advance_duration_ms", r.timings?.advanceMs ?? 0, "none");
        setProgress(null);
        setNotice(null);
        return r;
      } catch (e) {
        audioMetrics.record("upload_duration_ms", performance.now() - t0, "none", "failed");
        setProgress(null);
        const err = e as UploadError;
        if (err.status === 409) return null; // conflicting state → resync from the server
        setBlocked({ title: "Upload failed", message: `${err.message}. Your recording is still on this device.`, action: "retry-upload" });
        setPhase("blocked");
        await waitUser();
        setBlocked(null);
        if (signal.aborted) return null;
      }
    }
  }

  async function run() {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const signal = ctrl.signal;
    // unlock audio output on iOS/Safari inside the user gesture
    try { if ("speechSynthesis" in window) speechSynthesis.speak(new SpeechSynthesisUtterance("")); } catch { /* ignore */ }
    try {
      let v = await load();
      let first = !v.steps.some((s) => s.status === "answered");
      while (!signal.aborted) {
        const cfg = v.session.config;
        const step = v.steps.find((s) => s.stepIndex === v.session.currentStep);
        if (!step) throw new Error("Exam step not found");
        setCurrent(step);
        audioMetrics.startTurn(step.stepIndex);

        let data: { rec: Recording; transcript: string } | null = null;
        if (step.status !== "answered") {
          const lines = examinerLines(step, { first, noResponse: prevNoResponse.current });
          first = false;
          // A bank clip may only be used when it was recorded with THIS voice.
          const preset = presetAudioFor(step, voiceRef.current);
          if (step.kind === "cue_card") {
            if ((await say(lines, signal, preset)).status === "interrupted") return;
            setPhase("prep");
            await countdown(step.prepSeconds, 10, signal);
            if (signal.aborted) return;
            if ((await say([{ text: LINES.part2Start, act: "instruction" }], signal)).status === "interrupted") return;
          } else if ((await say(lines, signal, preset)).status === "interrupted") return;
          if (signal.aborted) return;

          // Prepare the NEXT question while the candidate answers this one.
          const next = v.steps.find((s) => s.stepIndex === step.stepIndex + 1 && s.status !== "answered");
          if (next) {
            preloaderRef.current?.prepareNext(
              examinerLines(next, { first: false, noResponse: false }),
              presetAudioFor(next, voiceRef.current),
            );
          }

          data = await record(step, signal, cfg);
          if (!data) return;
          // The examiner stops the candidate at 2 minutes, as in the real test.
          if (step.kind === "cue_card" && !signal.aborted
            && (await say([{ text: LINES.part2TimeUp, act: "time_warning" }], signal)).status === "interrupted") return;
        }

        setPhase("advancing");
        let result: CompleteResponse | null;
        if (data) {
          result = await submitAndAdvance(step, data, signal, cfg);
        } else {
          // Resume case: the answer is already stored but advance was lost.
          // The legacy /advance endpoint is kept for this path.
          const t0 = performance.now();
          try {
            const adv = await postJson<CompleteResponse["advance"]>(`/api/speaking/sessions/${sessionId}/advance`, { fromStep: step.stepIndex });
            audioMetrics.record("advance_duration_ms", performance.now() - t0, "none", "resync");
            result = {
              answer: { answerId: "", status: step.answer?.status ?? "answered", duplicate: true, asrDurationMs: 0 },
              advance: adv,
              timings: { submitMs: 0, advanceMs: performance.now() - t0 },
              view: await load(),
            };
          } catch (e) {
            if ((e as UploadError).status === 409) { v = await load(); continue; }
            throw e;
          }
        }
        if (!result) { v = await load(); continue; } // 409 → re-read authoritative state
        prevNoResponse.current = result.answer.status === "no_response";

        if (result.advance.finished) {
          setPhase("finishing");
          const closing = prevNoResponse.current ? `${LINES.noResponse.split(".")[0]}. ${LINES.closing}` : LINES.closing;
          if ((await say([{ text: closing, act: "closing" }], signal)).status === "interrupted") return;
          setPhase("finishing");
          await postJson(`/api/speaking/sessions/${sessionId}/finish`);
          audioMetrics.endTurn("finished");
          router.replace(`/speaking/report/${sessionId}`);
          return;
        }

        v = result.view; // no extra GET /sessions/:id round trip
        setView(v);
        // A Part 3 follow-up can be inserted by the state machine at advance
        // time. Queue any newly-appeared lines so they can stream immediately.
        const plan = buildScriptPlan(v, voiceRef.current);
        planRef.current = plan;
        preloaderRef.current?.replan(plan.entries, plan.presetUrls, plan.firstLines);
        audioMetrics.endTurn("advanced");
      }
    } catch (e) {
      if (!signal.aborted) { setFatal((e as Error).message); setPhase("error"); }
    }
  }

  async function startFromSetup() {
    try {
      const plan = planRef.current;
      // Readiness gate (opening + first question only) and mic acquisition are
      // independent, so run them together instead of serialising two waits.
      // getUserMedia + AudioContext are acquired ONCE for the whole session.
      const rs = new RecordingSession({});
      await Promise.all([
        preloaderRef.current?.ensureOpeningAndFirst(
          plan?.firstLines ?? [],
          plan?.firstQuestionAudioUrl ?? null,
          plan?.firstLines[0]?.act ?? "greeting",
        ) ?? Promise.resolve(),
        rs.acquire(deviceId || undefined),
      ]);
      recSessionRef.current = rs;
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
    recSessionRef.current?.dispose();
    recSessionRef.current = null;
    trRef.current?.stop().catch(() => {});
    disposeAudio(); // cancels every queued TTS task + stops live audio
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
  // The ring is the timer: preparation fills it clockwise, answering drains it
  // anticlockwise, so the direction itself tells you which phase you are in.
  const RING_C = 2 * Math.PI * 45;
  const isPrep = phase === "prep";
  const ringFrac = cd.total ? (isPrep ? 1 - pct : pct) : 0;
  const urgent = cd.total > 0 && cd.left <= 10;
  const critical = cd.total > 0 && cd.left <= 5;
  const hearing = phase === "recording" && level > 0.05;
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
          {process.env.NODE_ENV !== "production" && readiness && readiness.total > 0 && (
            <span className="hidden rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-700 sm:inline" title="Preloaded audio resources ready">
              audio {readiness.ready}/{readiness.total}
            </span>
          )}
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
            <button onClick={() => act("retry")} className="mt-4 rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white">
              {blocked.action === "retry-mic" ? "Try again" : "Continue"}
            </button>
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
                  <div className="relative grid h-40 w-40 place-items-center">
                    {/* Live input halo: breathes with the candidate's voice. */}
                    <div
                      className="pointer-events-none absolute inset-0 rounded-full transition-all duration-150"
                      style={{ boxShadow: hearing ? `0 0 0 ${5 + level * 16}px rgba(220,38,38,0.10)` : "0 0 0 0 rgba(220,38,38,0)" }}
                      aria-hidden
                    />
                    <svg viewBox="0 0 100 100" className="absolute inset-0 -rotate-90">
                      <circle cx="50" cy="50" r="45" fill="none" stroke="#e4e4e7" strokeWidth="5" />
                      <circle
                        cx="50" cy="50" r="45" fill="none"
                        stroke={isPrep ? "#18181b" : critical ? "#dc2626" : urgent ? "#f59e0b" : "#dc2626"}
                        strokeWidth="5" strokeLinecap="round"
                        strokeDasharray={`${Math.max(0.001, ringFrac) * RING_C} ${RING_C}`}
                        style={{
                          transform: `scale(${isPrep ? 1 : -1}, 1)`,
                          transformOrigin: "50px 50px",
                          transition: "stroke-dasharray 220ms linear, stroke 300ms ease",
                        }}
                      />
                    </svg>
                    <div className="text-center">
                      <div className={`text-4xl font-semibold tabular-nums ${critical ? "animate-pulse text-red-600" : urgent ? "text-amber-600" : "text-zinc-900"}`}>{mmss(cd.left)}</div>
                      <div className="mt-1 text-[11px] uppercase tracking-wide text-zinc-400">
                        {phase === "recording" ? (hearing ? "Hearing you" : "Listening") : "Preparation"}
                      </div>
                    </div>
                  </div>
                  {phase === "recording" && (
                    <div className="mt-5 flex flex-col items-center">
                      <div className="flex h-10 items-center gap-[3px]" aria-label="Microphone input level" role="img">
                        {bars.map((v, i) => (
                          <span
                            key={i}
                            className={`w-[3px] rounded-full transition-[height,background-color] duration-75 ${hearing ? "bg-red-500" : "bg-zinc-300"}`}
                            style={{ height: `${Math.max(3, Math.min(40, v * 46))}px`, opacity: 0.35 + Math.min(0.65, v * 2.2) }}
                          />
                        ))}
                      </div>
                      <p className="mt-2 text-[11px] text-zinc-400">{hearing ? "Your voice is being recorded" : "Speak now — the meter follows your voice"}</p>
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
