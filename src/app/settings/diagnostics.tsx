"use client";
/**
 * System Diagnostics — the exam environment check centre on /settings.
 *
 * Three scopes, one vocabulary (src/lib/diagnostics/types.ts):
 *   browser   — microphone, recorder, AudioContext, Web Speech, WebGL, GLB, FPS
 *   server    — DB, session, question bank, audio storage (POST /api/diagnostics)
 *   provider  — TTS synthesis, LLM generation, ASR transcription, pronunciation
 *
 * Rules implemented here:
 *  - nothing paid or permissioned runs on page load; "Run Full Diagnostics"
 *    first shows what will be called (LLM/TTS = small paid requests, ASR/P =
 *    microphone recording uploaded to the provider) and lets the user proceed;
 *  - microphone permission is requested ONLY by an explicit click;
 *  - the ASR/P probes reuse ONE 5 s test recording (16 kHz mono WAV, exactly
 *    the exam capture path); it stays in memory and is never written to the
 *    exam records;
 *  - the 3D check exercises the REAL ExaminerAvatar3D pipeline (loader +
 *    renderer + viseme morph targets + FPS), not a detached WebGL sample;
 *  - the readiness summary separates examReady / scoringReady /
 *    completeBandReady / digitalHumanReady and recommends a mode instead of
 *    demanding all-green.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui";
import { AudioPlayer } from "@/components/audio-player";
import { RecordingSession } from "@/lib/audio/recording-session";
import { browserAsrSupported, speak } from "@/lib/audio/speech";
import { ExaminerAvatar3D, webglSupport, type AvatarProbeInfo } from "@/components/examiner/examiner-avatar-3d";
import type { ExaminerGender } from "@/lib/avatar/models";
import {
  DIAGNOSTIC_IDS, computeReadiness,
  type DiagnosticGroup, type DiagnosticItem, type DiagnosticStatus,
  type ManagedServiceStatus, type ReadinessSummary,
  type ServerDiagnosticsResponse,
} from "@/lib/diagnostics/types";

const TTS_TEST_LINE = "Hello. My name is Sarah, and I will be your examiner today.";
const RECORD_MS = 5000; // 4–6 s per the spec; long enough for a real ASR/P probe
const RETRYABLE_BROWSER = new Set<string>([
  DIAGNOSTIC_IDS.browserEnvironment, DIAGNOSTIC_IDS.browserWebSpeech, DIAGNOSTIC_IDS.gpuWebgl,
  DIAGNOSTIC_IDS.gpuThree, DIAGNOSTIC_IDS.gpuModelDownload, DIAGNOSTIC_IDS.gpuModelRender,
]);

interface Caps {
  serverTts: boolean;
  tts: { id: string; model: string | null; location: string; format: string };
  asr: { id: string; model: string | null; location: string } | null;
  llm: { id: string; model: string | null } | null;
  pronunciation: { id: string } | null;
  examinerVoice: string;
  examinerGender: ExaminerGender;
  examinerModelId: string;
}

interface Props {
  caps: Caps;
  initialDigitalHuman3d: boolean;
}

type ItemMap = Record<string, DiagnosticItem>;

const GROUPS: { id: DiagnosticGroup; title: string; hint: string }[] = [
  { id: "application", title: "Application & Database", hint: "Next.js API, PostgreSQL, session, question bank, audio storage." },
  { id: "speech", title: "Speech & Recording", hint: "Examiner voice, microphone, recording playback, speech recognition." },
  { id: "ai", title: "AI Services", hint: "Scoring LLM — a small paid request is made when probed." },
  { id: "pronunciation", title: "Pronunciation", hint: "P-criterion provider — needs the microphone test recording." },
  { id: "digital-human", title: "Digital Human & GPU", hint: "Browser-side GPU/WebGL/3D model checks — no server cost." },
];

const STATUS_STYLE: Record<DiagnosticStatus, { label: string; cls: string }> = {
  ready: { label: "Ready", cls: "bg-emerald-50 text-emerald-700" },
  degraded: { label: "Degraded", cls: "bg-amber-50 text-amber-700" },
  failed: { label: "Failed", cls: "bg-red-50 text-red-700" },
  not_configured: { label: "Not configured", cls: "bg-zinc-100 text-zinc-500" },
  not_tested: { label: "Not tested", cls: "bg-zinc-100 text-zinc-400" },
  disabled: { label: "Off", cls: "bg-zinc-100 text-zinc-400" },
};

function nowIso() {
  return new Date().toISOString();
}

/** Free, permission-free browser checks — safe to run on mount. */
async function checkEnvironment(): Promise<DiagnosticItem> {
  const secure = typeof window !== "undefined" && window.isSecureContext;
  const md = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  const ok = navigator.onLine && secure && md;
  const problems = [!navigator.onLine && "offline", !secure && "not a secure context (HTTPS/localhost)", !md && "mediaDevices.getUserMedia unavailable"].filter(Boolean).join("; ");
  return {
    id: DIAGNOSTIC_IDS.browserEnvironment, group: "speech", name: "Browser environment", scope: "browser",
    status: ok ? "ready" : "failed", required: true,
    message: ok ? "Online, secure context, mediaDevices available." : `Browser cannot run the exam environment: ${problems}.`,
    testedAt: nowIso(),
    repairActions: !navigator.onLine ? [{ id: "net", label: "Check network", description: "Reconnect to the network and re-run this check.", available: false }] : undefined,
  };
}

async function checkWebSpeech(): Promise<DiagnosticItem> {
  const supported = browserAsrSupported();
  return {
    id: DIAGNOSTIC_IDS.browserWebSpeech, group: "speech", name: "Web Speech API (browser ASR)", scope: "browser",
    status: supported ? "ready" : "not_configured", required: false,
    message: supported
      ? "SpeechRecognition available — browser transcription can substitute for server ASR."
      : "SpeechRecognition not available in this browser (Chrome/Edge/Safari support it).",
    detail: supported ? undefined : "Only matters when ASR provider is 'browser'; recordings still work.",
    testedAt: nowIso(),
  };
}

async function checkWebgl(): Promise<DiagnosticItem> {
  const s = webglSupport();
  return {
    id: DIAGNOSTIC_IDS.gpuWebgl, group: "digital-human", name: "WebGL / WebGL2", scope: "browser",
    status: s.supported ? (s.webgl2 ? "ready" : "degraded") : "failed", required: false,
    message: s.supported
      ? `${s.webgl2 ? "WebGL2" : "WebGL 1"} context created${s.renderer ? ` — ${s.renderer}` : ""}.`
      : "WebGL is not available — the 3D examiner cannot run here.",
    detail: s.renderer ? "Renderer string is what the browser reports (it may be masked); the browser cannot expose real GPU model, VRAM or machine specs." : undefined,
    testedAt: nowIso(),
    repairActions: s.supported ? undefined : [{ id: "use-2d", label: "Use 2D examiner", description: "Switch the examiner to the lightweight 2D avatar (Examiner section above).", available: true }],
  };
}

export function SystemDiagnostics({ caps, initialDigitalHuman3d }: Props) {
  const [items, setItems] = useState<ItemMap>({});
  const [services, setServices] = useState<ManagedServiceStatus[]>([]);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [confirmCost, setConfirmCost] = useState(false);
  const [digitalHuman3d, setDigitalHuman3d] = useState(initialDigitalHuman3d);
  const [probeKey, setProbeKey] = useState(0);
  const [probeMounted, setProbeMounted] = useState(false);
  const [recording, setRecording] = useState(false);
  const [testWav, setTestWav] = useState<Blob | null>(null);
  const [testBlob, setTestBlob] = useState<Blob | null>(null);
  const [testClipUrl, setTestClipUrl] = useState<string | null>(null);
  const [auditioning, setAuditioning] = useState(false);
  const [restartNote, setRestartNote] = useState<string | null>(null);
  const ranOnceRef = useRef(false);

  const upsert = useCallback((next: DiagnosticItem[]) => {
    setItems((prev) => {
      const merged = { ...prev };
      for (const it of next) merged[it.id] = it;
      return merged;
    });
  }, []);

  const setRunningFor = useCallback((ids: string[], on: boolean) => {
    setRunning((prev) => {
      const s = new Set(prev);
      for (const id of ids) { if (on) s.add(id); else s.delete(id); }
      return s;
    });
  }, []);

  // ---- live sync with the Examiner card's 3D toggle ------------------------
  useEffect(() => {
    const on = (e: Event) => {
      const v = (e as CustomEvent<boolean>).detail;
      setDigitalHuman3d(!!v);
    };
    window.addEventListener("b9:digital-human", on);
    return () => window.removeEventListener("b9:digital-human", on);
  }, []);

  // ---- free checks on mount (never paid, never permissioned) ---------------
  useEffect(() => {
    void (async () => {
      const [env, ws, gl] = await Promise.all([checkEnvironment(), checkWebSpeech(), checkWebgl()]);
      upsert([env, ws, gl]);
    })();
    void (async () => {
      try {
        const res = await fetch("/api/diagnostics", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as ServerDiagnosticsResponse;
        setServices(j.services ?? []);
      } catch { /* snapshot is best-effort */ }
    })();
  }, [upsert]);

  // ---- server probes --------------------------------------------------------
  const runServerChecks = useCallback(async (ids: string[]) => {
    setRunningFor(ids, true);
    try {
      const res = await fetch("/api/diagnostics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checks: ids }),
      });
      const j = (await res.json()) as ServerDiagnosticsResponse & { error?: string };
      if (j.items) upsert(j.items);
      if (j.services) setServices(j.services);
      if (j.error) {
        upsert(ids.map((id) => ({
          id, group: "application" as DiagnosticGroup, name: id, scope: "server" as const,
          status: "failed" as const, required: false, message: j.error ?? "Diagnostics request failed.", testedAt: nowIso(),
        })));
      }
    } catch (e) {
      upsert(ids.map((id) => ({
        id, group: "application" as DiagnosticGroup, name: id, scope: "server" as const,
        status: "failed" as const, required: false, message: `Diagnostics request failed: ${(e as Error).message}`, testedAt: nowIso(),
      })));
    } finally {
      setRunningFor(ids, false);
      ranOnceRef.current = true;
    }
  }, [setRunningFor, upsert]);

  const SERVER_ALL = useMemo<string[]>(() => Object.values(DIAGNOSTIC_IDS).filter((id) => ["app.", "tts.config", "tts.synth", "llm.", "pron.config", "asr.config"].some((p) => id.startsWith(p))), []);

  const runFull = useCallback(async () => {
    setConfirmCost(false);
    const free: DiagnosticItem[] = [await checkEnvironment(), await checkWebSpeech(), await checkWebgl()];
    upsert(free);
    await runServerChecks(SERVER_ALL);
    // The 3D probe exercises the real pipeline; it costs nothing (local files).
    if (digitalHuman3d) {
      setProbeMounted(true);
      setProbeKey((k) => k + 1);
    }
  }, [digitalHuman3d, runServerChecks, SERVER_ALL, upsert]);

  const retryFailed = useCallback(async () => {
    const failedIds = Object.values(items).filter((i) => i.status === "failed" || i.status === "degraded").map((i) => i.id);
    if (!failedIds.length) return;
    const serverIds = failedIds.filter((id) => SERVER_ALL.includes(id));
    if (serverIds.length) await runServerChecks(serverIds);
    const pending: DiagnosticItem[] = [];
    if (failedIds.includes(DIAGNOSTIC_IDS.browserEnvironment)) pending.push(await checkEnvironment());
    if (failedIds.includes(DIAGNOSTIC_IDS.browserWebSpeech)) pending.push(await checkWebSpeech());
    if (failedIds.includes(DIAGNOSTIC_IDS.gpuWebgl)) pending.push(await checkWebgl());
    if (pending.length) upsert(pending);
    if (failedIds.some((id) => id.startsWith("gpu.model") || id === DIAGNOSTIC_IDS.gpuThree)) {
      setProbeMounted(true);
      setProbeKey((k) => k + 1);
    }
  }, [items, runServerChecks, SERVER_ALL, upsert]);

  // ---- microphone recording test (the ASR/P source audio) ------------------
  async function runRecordTest() {
    setRecording(true);
    upsert([{
      id: DIAGNOSTIC_IDS.browserMicrophone, group: "speech", name: "Microphone permission & capture", scope: "browser",
      status: "degraded", required: true, message: "Requesting microphone…", testedAt: nowIso(),
    }]);
    const rs = new RecordingSession({});
    try {
      await rs.acquire(localStorage.getItem("mic-device") || undefined);
      upsert([{
        id: DIAGNOSTIC_IDS.browserMicrophone, group: "speech", name: "Microphone permission & capture", scope: "browser",
        status: "ready", required: true, message: `Microphone acquired (${rs.captureMode}).`, testedAt: nowIso(),
      }]);
      // Recorder + AudioContext capability follow from the capture mode.
      upsert([
        {
          id: DIAGNOSTIC_IDS.browserRecorder, group: "speech", name: "MediaRecorder", scope: "browser",
          status: rs.captureMode === "media-recorder-only" && !testBlob ? "degraded" : "ready", required: true,
          message: rs.captureMode === "media-recorder-only" ? "Web Audio unavailable — MediaRecorder-only capture." : `Recorder + ${rs.captureMode} PCM capture available.`,
          testedAt: nowIso(),
        },
        {
          id: DIAGNOSTIC_IDS.browserAudioContext, group: "speech", name: "AudioContext", scope: "browser",
          status: rs.captureMode === "media-recorder-only" ? "not_configured" : "ready", required: true,
          message: rs.captureMode === "media-recorder-only" ? "Web Audio unavailable in this browser." : "AudioContext created and resumed for capture.",
          testedAt: nowIso(),
        },
      ]);
      setRecording(true);
      rs.startAnswer();
      await new Promise((r) => setTimeout(r, RECORD_MS));
      const rec = await rs.stopAnswer();
      const wav = rec.wav;
      const blob = rec.blob ?? wav;
      if (!blob || !blob.size) throw new Error("No audio was captured — check the input device.");
      setTestWav(wav);
      setTestBlob(blob);
      if (testClipUrl) URL.revokeObjectURL(testClipUrl);
      setTestClipUrl(URL.createObjectURL(blob));
      upsert([{
        id: DIAGNOSTIC_IDS.browserRecordPlayback, group: "speech", name: `Record & playback test (${RECORD_MS / 1000} s)`, scope: "browser",
        status: "ready", required: true,
        message: `Captured ${(rec.durationMs / 1000).toFixed(1)} s (${blob.type || "audio"}${wav ? " + 16 kHz mono WAV" : ""}). Play it back below.`,
        detail: "This recording stays on this device and is only uploaded if you run the ASR / pronunciation probes.",
        testedAt: nowIso(),
      }]);
    } catch (e) {
      const msg = (e as Error).message;
      const denied = /permission/i.test(msg);
      upsert([{
        id: DIAGNOSTIC_IDS.browserMicrophone, group: "speech", name: "Microphone permission & capture", scope: "browser",
        status: "failed", required: true, message: msg, testedAt: nowIso(),
        repairActions: denied ? [
          { id: "perm-fix", label: "Permission fix", description: "Click the lock/camera icon in the address bar → Microphone → Allow, then reload the page and run this check again.", available: false },
          { id: "perm-chrome", label: "Chrome settings", description: "chrome://settings/content/microphone — make sure this site is not blocked.", available: false },
        ] : undefined,
      }]);
    } finally {
      rs.dispose();
      setRecording(false);
    }
  }

  // ---- examiner voice audition (real playback path) -------------------------
  async function runAudition() {
    setAuditioning(true);
    try {
      const r = await speak(TTS_TEST_LINE, {
        serverTts: caps.serverTts,
        voice: caps.examinerVoice,
        act: "greeting",
        profileId: caps.examinerVoice,
      });
      upsert([{
        id: DIAGNOSTIC_IDS.ttsAudition, group: "speech", name: "Speaker & playback audition", scope: "browser",
        status: r.outcome.status === "ended" ? "ready" : r.outcome.status === "interrupted" ? "not_tested" : "failed",
        required: true,
        message: r.outcome.status === "ended"
          ? `Played through the ${r.via} path — if you heard it, the output chain is fine.`
          : `Playback did not complete (${r.outcome.status} via ${r.via}).`,
        testedAt: nowIso(),
      }]);
    } finally {
      setAuditioning(false);
    }
  }

  // ---- ASR transcription probe ----------------------------------------------
  async function runAsrProbe() {
    if (!testWav && !testBlob) return;
    const body = new FormData();
    body.append("audio", testWav ?? testBlob!, "probe.wav");
    body.append("mime", (testWav ?? testBlob)!.type || "audio/wav");
    setRunningFor([DIAGNOSTIC_IDS.asrTranscribe], true);
    try {
      const res = await fetch("/api/diagnostics/asr", { method: "POST", body });
      const j = await res.json();
      upsert([{
        id: DIAGNOSTIC_IDS.asrTranscribe, group: "speech", name: "ASR transcription probe", scope: "provider",
        status: j.status ?? "failed", required: false,
        provider: j.provider ?? null, model: j.model ?? null,
        message: j.message ?? "Probe failed.",
        detail: j.detail ?? (j.text ? undefined : undefined),
        latencyMs: j.latencyMs,
        testedAt: nowIso(),
        repairActions: j.status === "not_configured" ? [
          { id: "asr-config", label: "Open AI settings", description: "Configure ASR_PROVIDER on /admin.", available: true, href: "/admin" },
        ] : undefined,
      }]);
    } catch (e) {
      upsert([{
        id: DIAGNOSTIC_IDS.asrTranscribe, group: "speech", name: "ASR transcription probe", scope: "provider",
        status: "failed", required: false, message: `Probe request failed: ${(e as Error).message}`, testedAt: nowIso(),
      }]);
    } finally {
      setRunningFor([DIAGNOSTIC_IDS.asrTranscribe], false);
    }
  }

  // ---- pronunciation assessment probe ---------------------------------------
  async function runPronProbe() {
    if (!testWav) return;
    const body = new FormData();
    body.append("wav", testWav, "probe.wav");
    body.append("referenceText", TTS_TEST_LINE);
    setRunningFor([DIAGNOSTIC_IDS.pronAssess], true);
    try {
      const res = await fetch("/api/diagnostics/pronunciation", { method: "POST", body });
      const j = await res.json();
      const metrics = j.metrics ? `Accuracy ${j.metrics.accuracy} · Fluency ${j.metrics.fluency}${j.metrics.prosody != null ? ` · Prosody ${j.metrics.prosody}` : ""}${j.metrics.completeness != null ? ` · Completeness ${j.metrics.completeness}` : ""} · ${j.words?.length ?? 0} word scores` : undefined;
      upsert([{
        id: DIAGNOSTIC_IDS.pronAssess, group: "pronunciation", name: "Pronunciation assessment probe", scope: "provider",
        status: j.status ?? "failed", required: false,
        provider: j.provider ?? null,
        message: j.message ?? "Probe failed.",
        detail: [j.detail, metrics, j.formatOk === false ? j.formatDetail : undefined].filter(Boolean).join(" — ") || undefined,
        latencyMs: j.latencyMs,
        testedAt: nowIso(),
        repairActions: j.status === "not_configured" ? [
          { id: "pron-config", label: "Open AI settings", description: "Configure Azure Speech / Tencent SOE on /admin.", available: true, href: "/admin" },
        ] : undefined,
      }]);
    } catch (e) {
      upsert([{
        id: DIAGNOSTIC_IDS.pronAssess, group: "pronunciation", name: "Pronunciation assessment probe", scope: "provider",
        status: "failed", required: false, message: `Probe request failed: ${(e as Error).message}`, testedAt: nowIso(),
      }]);
    } finally {
      setRunningFor([DIAGNOSTIC_IDS.pronAssess], false);
    }
  }

  // ---- 3D pipeline probe -----------------------------------------------------
  const onProbe = useCallback((info: AvatarProbeInfo) => {
    if (info.error) {
      upsert([
        { id: DIAGNOSTIC_IDS.gpuModelDownload, group: "digital-human", name: "GLB model download", scope: "browser", status: "failed", required: false, message: `The examiner model failed to load: ${info.error}`, testedAt: nowIso(),
          repairActions: [
            { id: "model-retry", label: "Retry download", description: "Re-run the 3D test (the GLB is served from this origin).", available: true },
            { id: "model-switch", label: "Switch examiner look", description: "Pick another examiner in the Examiner section — some looks have different model files.", available: false },
          ] },
        { id: DIAGNOSTIC_IDS.gpuModelRender, group: "digital-human", name: "3D examiner render", scope: "browser", status: "degraded", required: false, message: "3D failed — the exam automatically falls back to the 2D examiner.", testedAt: nowIso() },
      ]);
      return;
    }
    const visemeOk = (info.visemesFound ?? 0) >= (info.visemesRequired ?? 15);
    const fps = info.fps;
    const download: DiagnosticItem = {
      id: DIAGNOSTIC_IDS.gpuModelDownload, group: "digital-human", name: "GLB model download", scope: "browser",
      status: "ready", required: false,
      message: `GLB downloaded and parsed in ${info.loadMs ?? 0} ms.`,
      detail: `Viseme morph targets: ${info.visemesFound ?? 0}/${info.visemesRequired ?? 15}${visemeOk ? "" : " — incomplete; lip-sync will be approximate."}${info.renderer ? ` · GPU (browser-reported): ${info.renderer}` : ""}${info.webgl2 ? " · WebGL2" : ""}`,
      latencyMs: info.loadMs,
      testedAt: nowIso(),
    };
    let render: DiagnosticItem;
    if (!visemeOk) {
      render = {
        id: DIAGNOSTIC_IDS.gpuModelRender, group: "digital-human", name: "3D examiner render", scope: "browser",
        status: "degraded", required: false,
        message: `Rendered, but only ${info.visemesFound}/${info.visemesRequired} viseme morph targets are present — mouth movement will be approximate.`,
        detail: `Three.js loaded dynamically and rendered${fps != null ? ` at ${fps} FPS` : ""}.`,
        testedAt: nowIso(),
        repairActions: [{ id: "model-switch", label: "Switch examiner look", description: "Choose another examiner in the Examiner section.", available: false }],
      };
    } else if (fps != null && fps < 20) {
      render = {
        id: DIAGNOSTIC_IDS.gpuModelRender, group: "digital-human", name: "3D examiner render", scope: "browser",
        status: "degraded", required: false,
        message: `Rendered at ${fps} FPS — performance is weak for this device.`,
        detail: `hardwareConcurrency: ${typeof navigator !== "undefined" ? navigator.hardwareConcurrency : "?"}${typeof navigator !== "undefined" && (navigator as { deviceMemory?: number }).deviceMemory ? ` · deviceMemory: ${(navigator as { deviceMemory?: number }).deviceMemory} GB (browser-reported)` : ""}. The 2D examiner is recommended; your preference is not changed automatically.`,
        testedAt: nowIso(),
        repairActions: [{ id: "use-2d", label: "Use 2D examiner", description: "Switch the examiner to the lightweight 2D avatar.", available: true }],
      };
    } else {
      render = {
        id: DIAGNOSTIC_IDS.gpuModelRender, group: "digital-human", name: "3D examiner render", scope: "browser",
        status: "ready", required: false,
        message: `Rendered at ${fps ?? "?"} FPS with all ${info.visemesFound}/${info.visemesRequired} visemes.`,
        detail: `Three.js loaded dynamically · load ${info.loadMs ?? 0} ms${info.renderer ? ` · GPU (browser-reported): ${info.renderer}` : ""}. GPU resources are released when the component unmounts (geometry/materials disposed, context lost).`,
        latencyMs: info.loadMs,
        testedAt: nowIso(),
      };
    }
    upsert([
      { id: DIAGNOSTIC_IDS.gpuThree, group: "digital-human", name: "Three.js dynamic import", scope: "browser", status: "ready", required: false, message: "three.js loaded on demand.", testedAt: nowIso() },
      download,
      render,
    ]);
  }, [upsert]);

  const onProbeLifecycle = useCallback((_state: string) => { /* detailed items arrive via onProbe */ }, []);

  // ---- managed service restart ------------------------------------------------
  async function restartService(id: string) {
    setRestartNote("Restarting…");
    try {
      const res = await fetch("/api/diagnostics/services", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
      });
      const j = await res.json() as { ok?: boolean; phase?: string; detail?: string; error?: string };
      setRestartNote(j.detail ?? j.error ?? "Restart attempt finished.");
      if (j.phase === "restarted" || j.phase === "warming-up") {
        const h = await fetch("/api/diagnostics/services", { cache: "no-store" });
        const hj = await h.json() as { services?: ManagedServiceStatus[] };
        if (hj.services) setServices(hj.services);
      }
    } catch (e) {
      setRestartNote(`Restart request failed: ${(e as Error).message}`);
    }
  }

  async function switchTo2d() {
    try {
      await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ digitalHuman3d: false }) });
    } catch { /* preference write is best-effort; the local switch still applies */ }
    setDigitalHuman3d(false);
    window.dispatchEvent(new CustomEvent("b9:digital-human", { detail: false }));
  }

  const list = useMemo(() => Object.values(items), [items]);
  const readiness: ReadinessSummary = useMemo(
    () => computeReadiness(list, { digitalHuman3d, deploymentTtsLocation: caps.serverTts ? "server" : "browser" }),
    [list, digitalHuman3d, caps.serverTts],
  );

  const kokoro = services[0];
  const failedCount = list.filter((i) => i.status === "failed" || i.status === "degraded").length;
  const paidConfigured = !!(caps.llm || caps.serverTts || caps.asr || caps.pronunciation);

  const fmtTime = (iso?: string) => iso ? new Date(iso).toLocaleTimeString() : null;
  const statusPill = (s: DiagnosticStatus) => {
    const st = STATUS_STYLE[s];
    return <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${st.cls}`}>{st.label}</span>;
  };

  const renderItem = (it: DiagnosticItem) => {
    const isRunning = running.has(it.id);
    const isServerCheck = SERVER_ALL.includes(it.id);
    const canRetry = isServerCheck || RETRYABLE_BROWSER.has(it.id);
    return (
      <li key={it.id} className="border-b border-zinc-100 py-3 last:border-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{it.name}</span>
          {statusPill(it.status)}
          {it.provider && <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-600">{it.provider}{it.model ? ` · ${it.model}` : ""}</span>}
          {it.latencyMs != null && <span className="text-[11px] tabular-nums text-zinc-400">{it.latencyMs} ms</span>}
          {fmtTime(it.testedAt) && <span className="text-[11px] text-zinc-300">at {fmtTime(it.testedAt)}</span>}
          <span className="ml-auto flex items-center gap-2">
            {isRunning && <span className="h-3 w-3 animate-spin rounded-full border border-zinc-300 border-t-zinc-600" aria-hidden />}
            {canRetry && !isRunning && (
              <button
                onClick={() => {
                  if (isServerCheck) void runServerChecks([it.id]);
                  else if (it.id === DIAGNOSTIC_IDS.browserEnvironment) void checkEnvironment().then((i) => upsert([i]));
                  else if (it.id === DIAGNOSTIC_IDS.browserWebSpeech) void checkWebSpeech().then((i) => upsert([i]));
                  else if (it.id === DIAGNOSTIC_IDS.gpuWebgl) void checkWebgl().then((i) => upsert([i]));
                  else { setProbeMounted(true); setProbeKey((k) => k + 1); }
                }}
                className="rounded border border-zinc-200 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-50"
              >
                Retry
              </button>
            )}
          </span>
        </div>
        <p className={`mt-1 text-xs leading-5 ${it.status === "failed" ? "text-red-700" : it.status === "degraded" ? "text-amber-700" : "text-zinc-500"}`}>{it.message}</p>
        {it.detail && <p className="mt-0.5 text-[11px] leading-4 text-zinc-400">{it.detail}</p>}
        {!!it.repairActions?.length && (
          <div className="mt-1.5 flex flex-wrap gap-2">
            {it.repairActions.map((a) => (
              <button
                key={a.id}
                onClick={() => {
                  if (a.id === "tts-restart") {
                    if (kokoro?.restartable) void restartService(kokoro.id);
                    else setRestartNote(kokoro?.detail || "No service manager is configured on this host — restart the engine manually (see the guide below).");
                  } else if (a.id === "use-2d") {
                    void switchTo2d();
                  } else if (a.id === "model-retry") {
                    setProbeMounted(true);
                    setProbeKey((k) => k + 1);
                  } else if (a.href) {
                    location.assign(a.href);
                  } else {
                    setRestartNote(a.description);
                  }
                }}
                className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-700 hover:bg-zinc-50"
                title={a.description}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
        {/* ASR / P probes live in their rows: they need the mic recording. */}
        {it.id === DIAGNOSTIC_IDS.asrTranscribe && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              onClick={() => void runAsrProbe()}
              disabled={(!testWav && !testBlob) || running.has(it.id)}
              className="rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            >
              {running.has(it.id) ? "Transcribing…" : "Run transcription probe"}
            </button>
            <span className="text-[11px] text-zinc-400">
              {testWav || testBlob ? "Uploads the 5 s test recording to the ASR provider. It is never stored in exam records." : "Record the microphone test above first."}
            </span>
          </div>
        )}
        {it.id === DIAGNOSTIC_IDS.pronAssess && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              onClick={() => void runPronProbe()}
              disabled={!testWav || running.has(it.id)}
              className="rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            >
              {running.has(it.id) ? "Assessing…" : "Run assessment probe"}
            </button>
            <span className="text-[11px] text-zinc-400">
              {testWav ? "Reuses the same 16 kHz mono WAV — provider 0–100 scores are availability evidence only, never IELTS bands, and the sample is not stored as a result." : "Record the microphone test above first."}
            </span>
          </div>
        )}
        {it.id === DIAGNOSTIC_IDS.ttsAudition && (
          <div className="mt-2">
            <button onClick={() => void runAudition()} disabled={auditioning} className="rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
              {auditioning ? "Speaking…" : "Play the test line"}
            </button>
          </div>
        )}
      </li>
    );
  };

  const micRow: DiagnosticItem = items[DIAGNOSTIC_IDS.browserRecordPlayback] ?? {
    id: DIAGNOSTIC_IDS.browserRecordPlayback, group: "speech", name: `Record & playback test (${RECORD_MS / 1000} s)`, scope: "browser",
    status: "not_tested", required: true,
    message: recording ? "Recording…" : "Record 5 s and play it back — the exact capture path the exam uses, and the source audio for the ASR / pronunciation probes.",
  };

  return (
    <Card className="space-y-5 p-6" id="diagnostics">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">System diagnostics</h2>
          <p className="mt-0.5 text-xs text-zinc-400">Verify the whole exam environment before a test — browser, server, providers, digital human.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {confirmCost ? (
            <>
              <span className="max-w-xs rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
                Full diagnostics calls the scoring LLM and the TTS engine (small paid usage{caps.asr ? ", ASR" : ""}{caps.pronunciation ? " + pronunciation" : ""} once you run their probes). Continue?
              </span>
              <button onClick={() => void runFull()} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white">Run now</button>
              <button onClick={() => setConfirmCost(false)} className="rounded-lg border border-zinc-200 px-3 py-2 text-sm">Cancel</button>
            </>
          ) : (
            <button onClick={() => paidConfigured ? setConfirmCost(true) : void runFull()} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700">
              Run Full Diagnostics
            </button>
          )}
          <button onClick={() => void retryFailed()} disabled={failedCount === 0} className="rounded-lg border border-zinc-200 px-4 py-2 text-sm disabled:opacity-40">
            Retry Failed Checks{failedCount ? ` (${failedCount})` : ""}
          </button>
        </div>
      </div>

      {/* ---- readiness summary ---------------------------------------------- */}
      <div className="grid gap-2 sm:grid-cols-4" aria-label="Capability readiness">
        {[
          { ok: readiness.examReady, label: "Exam environment", detail: "DB · bank · mic · examiner voice" },
          { ok: readiness.scoringReady, label: "Scoring", detail: "LLM · ASR · audio storage" },
          { ok: readiness.completeBandReady, label: "Complete band", detail: "FC/LR/GRA + P" },
          { ok: readiness.digitalHumanReady, label: "Digital human", detail: digitalHuman3d ? "3D enabled" : "3D is switched off" },
        ].map((c) => (
          <div key={c.label} className={`rounded-xl border p-3 ${c.ok ? "border-emerald-200 bg-emerald-50" : "border-zinc-200 bg-white"}`}>
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <span aria-hidden>{c.ok ? "✅" : "⚠️"}</span> {c.label}
            </div>
            <div className="mt-0.5 text-[11px] text-zinc-400">{c.detail}</div>
          </div>
        ))}
      </div>
      <p className="text-xs text-zinc-500">
        {readiness.recommendedMode === "fix-first"
          ? "Recommended: fix the failed checks below before starting an exam."
          : readiness.recommendedMode === "3d"
            ? "Recommended: start the exam with the 3D examiner."
            : "Recommended: use the lightweight 2D examiner (switch it in the Examiner section)."}
        {" "}Not everything must be green: without the LLM the exam still records and completes, but is marked unscored.
      </p>
      {!!readiness.notes.length && (
        <ul className="space-y-1 rounded-lg bg-zinc-50 p-3 text-[11px] leading-4 text-zinc-500">
          {readiness.notes.map((n, i) => <li key={i}>• {n}</li>)}
        </ul>
      )}
      {restartNote && (
        <p className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800">
          {restartNote}{" "}
          <button className="underline" onClick={() => setRestartNote(null)}>dismiss</button>
          {kokoro?.command && <span className="block text-[11px] text-amber-700">Managed command: <code>{kokoro.command}</code></span>}
        </p>
      )}

      {/* ---- groups ----------------------------------------------------------- */}
      <div className="space-y-4">
        {GROUPS.map((g) => {
          const groupItems = list.filter((i) => i.group === g.id);
          const isDh = g.id === "digital-human";
          return (
            <div key={g.id} className="rounded-xl border border-zinc-200">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-4 py-2.5">
                <div>
                  <h3 className="text-sm font-semibold">{g.title}</h3>
                  <p className="text-[11px] text-zinc-400">{g.hint}</p>
                </div>
                {isDh && (
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${digitalHuman3d ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-500"}`}>
                      {digitalHuman3d ? "3D on" : "3D off"}
                    </span>
                    <button onClick={() => void switchTo2d()} disabled={!digitalHuman3d} className="rounded border border-zinc-200 px-2 py-0.5 text-xs text-zinc-600 disabled:opacity-40">
                      Switch to 2D
                    </button>
                  </div>
                )}
              </div>
              {isDh && !digitalHuman3d ? (
                <p className="px-4 py-3 text-xs text-zinc-400">
                  The 3D digital human is switched off — the exam uses the lightweight 2D examiner and these GPU checks are skipped. Turn it on in the Examiner section to test it.
                </p>
              ) : (
                <ul className="px-4">
                  {/* Recording test row lives at the top of Speech & Recording */}
                  {g.id === "speech" && (
                    <li className="border-b border-zinc-100 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{micRow.name}</span>
                        {statusPill(micRow.status)}
                      </div>
                      <p className="mt-1 text-xs leading-5 text-zinc-500">{micRow.message}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <button
                          onClick={() => void runRecordTest()}
                          disabled={recording}
                          className="rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                        >
                          {recording ? `Recording ${RECORD_MS / 1000} s…` : `Record ${RECORD_MS / 1000} s test`}
                        </button>
                        <span className="text-[11px] text-zinc-400">
                          The browser asks for microphone permission only when you click. The audio stays on this device.
                        </span>
                      </div>
                      {testClipUrl && (
                        <div className="mt-2 max-w-sm">
                          <p className="mb-1 text-[11px] text-zinc-400">Playback — if you hear yourself, the capture path works:</p>
                          <AudioPlayer src={testClipUrl} className="w-full" />
                        </div>
                      )}
                    </li>
                  )}
                  {g.id === "digital-human" && !probeMounted && (
                    <li className="border-b border-zinc-100 py-3">
                      <button
                        onClick={() => { setProbeMounted(true); setProbeKey((k) => k + 1); }}
                        className="rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white"
                      >
                        Test the 3D examiner
                      </button>
                      <span className="ml-2 text-[11px] text-zinc-400">Loads the real GLB through the real ExaminerAvatar3D pipeline and measures FPS.</span>
                    </li>
                  )}
                  {groupItems.map(renderItem)}
                  {g.id === "speech" && !items[DIAGNOSTIC_IDS.ttsAudition] && (
                    <li className="py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">Speaker & playback audition</span>
                        {statusPill("not_tested")}
                      </div>
                      <p className="mt-1 text-xs text-zinc-500">Play the examiner&apos;s test line through the real playback path and confirm you hear it.</p>
                      <div className="mt-2">
                        <button onClick={() => void runAudition()} disabled={auditioning} className="rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">
                          {auditioning ? "Speaking…" : "Play the test line"}
                        </button>
                      </div>
                    </li>
                  )}
                  {!groupItems.length && g.id === "digital-human" && probeMounted && null}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {/* hidden offscreen mount of the REAL 3D examiner for the probe */}
      {probeMounted && digitalHuman3d && (
        <div className="pointer-events-none fixed -left-[9999px] top-0 h-40 w-40" aria-hidden>
          <ExaminerAvatar3D
            key={probeKey}
            gender={caps.examinerGender}
            modelId={caps.examinerModelId}
            speaking={false}
            listening={false}
            name="Probe"
            probe
            onLifecycle={onProbeLifecycle}
            onProbe={onProbe}
            className="h-40 w-40"
          />
        </div>
      )}

      <p className="border-t border-zinc-100 pt-3 text-[11px] leading-4 text-zinc-400">
        Provider checks use the registry configured on /admin (env vars or the AI panel). API keys never leave the server: this page only shows provider ids, models and masked state. Restart actions exist only for engines this deployment actually manages (see docs/tts-engine-deployment.md); cloud providers cannot be restarted from here.
      </p>
    </Card>
  );
}
