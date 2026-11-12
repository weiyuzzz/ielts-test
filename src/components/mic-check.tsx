"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { RecordingSession } from "@/lib/audio/recording-session";
import { listInputDevices } from "@/lib/audio/recorder";
import { AudioPlayer } from "@/components/audio-player";

const TEST_MS = 3000;
/** Anything above this is treated as "we can hear something". */
const SIGNAL_THRESHOLD = 0.02;

interface Props {
  deviceId?: string;
  onDeviceChange?: (id: string) => void;
  /**
   * Exam mode: called when the candidate confirms. The component hands its
   * acquired session over and stops owning it (the exam disposes it instead).
   * Omit it on the settings page — the component then disposes on unmount.
   */
  onConfirm?: (session: RecordingSession) => void;
  confirmLabel?: string;
  title?: string;
  hint?: string;
}

/**
 * Microphone check with a live level meter and a short record-and-playback test.
 *
 * The exam shows this before the first question and only starts after the
 * candidate confirms; the settings page uses the same component, so both places
 * exercise the exact same capture path (RecordingSession → AudioWorklet /
 * ScriptProcessor) that records the real answers.
 */
export function MicCheck({ deviceId, onDeviceChange, onConfirm, confirmLabel = "All good, start the exam", title = "Microphone check", hint }: Props) {
  const rsRef = useRef<RecordingSession | null>(null);
  const handedOver = useRef(false);
  /** Set when 关闭 is pressed while an acquire is still pending. */
  const disposedRef = useRef(false);
  const deviceRef = useRef(deviceId ?? "");
  // Keep the latest device id without writing a ref during render.
  useEffect(() => { deviceRef.current = deviceId ?? ""; }, [deviceId]);

  const [ready, setReady] = useState(false);
  const [acquiring, setAcquiring] = useState(false);
  const [status, setStatus] = useState<"off" | "init" | "ready" | "error">("off");
  const [level, setLevel] = useState(0);
  const [peak, setPeak] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [clip, setClip] = useState<string | null>(null);
  const [tested, setTested] = useState(false);
  const levelTs = useRef(0);

  /**
   * The microphone is ONLY acquired by an explicit user click (browsers ask
   * for permission then, and the user asked not to be prompted on page load).
   * 关闭 releases the capture (tracks stop → the browser's recording light goes out).
   */
  async function enable() {
    if (rsRef.current || acquiring) return;
    disposedRef.current = false;
    setAcquiring(true);
    setMsg(null);
    setStatus("init");
    const rs = new RecordingSession({});
    rsRef.current = rs;
    try {
      await rs.acquire(deviceRef.current || undefined);
      // 关闭 was clicked while the permission prompt was still pending.
      if (disposedRef.current) { rs.dispose(); return; }
      setReady(true);
      setStatus("ready");
    } catch (e) {
      if (!disposedRef.current) {
        rs.dispose();
        rsRef.current = null;
        setStatus("error");
        setMsg((e as Error).message);
      }
    } finally {
      setAcquiring(false);
    }
  }

  /** Release the microphone completely (tracks stop; re-enable asks again). */
  function disable() {
    disposedRef.current = true;
    const rs = rsRef.current;
    if (rs && !handedOver.current) rs.dispose();
    rsRef.current = null;
    setReady(false);
    setAcquiring(false);
    setStatus("off");
    setLevel(0);
    setPeak(0);
    setTested(false);
    setMsg(null);
    setClip((old) => { if (old) URL.revokeObjectURL(old); return null; });
  }

  // Live level meter (throttled like the exam UI).
  useEffect(() => {
    if (!ready) return;
    const rs = rsRef.current;
    if (!rs) return;
    rs.onLevel = (l) => {
      const now = performance.now();
      if (now - levelTs.current < 80) return;
      levelTs.current = now;
      setLevel(l);
      setPeak((p) => Math.max(p, l));
    };
    rs.onError = (e) => setMsg(e.message);
    return () => { rs.onLevel = undefined; rs.onError = undefined; };
  }, [ready]);

  const refreshDevices = useCallback(async () => {
    try { setDevices(await listInputDevices()); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => { void refreshDevices(); }, 0);
    return () => clearTimeout(t);
  }, [ready, refreshDevices]);

  useEffect(() => () => { setClip((old) => { if (old) URL.revokeObjectURL(old); return null; }); }, []);

  async function runTest() {
    const rs = rsRef.current;
    if (!rs) return;
    setTesting(true); setMsg(null);
    try {
      rs.startAnswer();
      await new Promise((r) => setTimeout(r, TEST_MS));
      const rec = await rs.stopAnswer();
      const blob = rec.blob ?? rec.wav;
      if (!blob || blob.size === 0) throw new Error("No audio was recorded. Check the microphone permission or try another device.");
      setClip((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
      setTested(true);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setTesting(false);
    }
  }

  async function reopen() {
    const rs = rsRef.current;
    if (!rs) return;
    setMsg(null); setStatus("init"); setPeak(0); setTested(false);
    setClip((old) => { if (old) URL.revokeObjectURL(old); return null; });
    try {
      await rs.reopen(deviceRef.current || undefined);
      setStatus("ready");
      await refreshDevices();
    } catch (e) {
      setStatus("error");
      setMsg((e as Error).message);
    }
  }

  function confirm() {
    const rs = rsRef.current;
    if (!rs || !onConfirm) return;
    handedOver.current = true; // the exam now owns the session
    onConfirm(rs);
  }

  const bars = 16;
  const heard = peak >= SIGNAL_THRESHOLD;

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{title}</h2>
          <p className="mt-1 text-xs leading-5 text-zinc-500">
            {hint ?? "Say anything into the microphone and confirm the level meter below moves. This is the exact same recording path the real exam uses."}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${status === "ready" ? "bg-emerald-50 text-emerald-700" : status === "error" ? "bg-red-50 text-red-700" : "bg-zinc-100 text-zinc-500"}`}>
          {status === "ready" ? "Connected" : status === "error" ? "Unavailable" : status === "init" ? "Connecting…" : "Off"}
        </span>
      </div>

      {status === "off" ? (
        // Permission is only requested after this explicit click.
        <div className="mt-5 flex flex-col items-start gap-3">
          <button
            onClick={() => void enable()}
            disabled={acquiring}
            className="rounded-xl bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
          >
            {acquiring ? "Requesting microphone…" : "Enable microphone test"}
          </button>
          <p className="text-xs text-zinc-400">The browser asks for microphone permission after you click; turning it off fully releases the microphone.</p>
          {msg && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{msg}</p>}
        </div>
      ) : (
        <>
          <div className="mt-5 flex flex-col items-center">
            <div className="flex h-16 items-end gap-1.5" aria-label="Microphone level">
              {Array.from({ length: bars }).map((_, i) => (
                <span
                  key={i}
                  className={`w-2 rounded-full transition-all ${heard ? "bg-emerald-500" : "bg-zinc-300"}`}
                  style={{ height: `${Math.max(6, Math.min(56, level * 56 * (0.55 + 0.45 * Math.sin(i * 1.7 + level * 12))))}px`, opacity: level > i / bars ? 1 : 0.3 }}
                />
              ))}
            </div>
            <p className={`mt-3 text-xs ${heard ? "text-emerald-700" : "text-zinc-500"}`}>
              {status !== "ready" ? "Waiting for microphone…" : heard ? "Sound detected ✓" : "No sound detected yet — speak, or try another microphone"}
            </p>
          </div>

          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <select
              className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
              value={deviceId ?? ""}
              onChange={(e) => onDeviceChange?.(e.target.value)}
            >
              <option value="">System default microphone</option>
              {devices.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}
            </select>
            <button onClick={reopen} className="shrink-0 rounded-lg border border-zinc-200 px-3 py-2 text-sm">Change device / re-check</button>
            <button onClick={runTest} disabled={status !== "ready" || testing} className="shrink-0 rounded-lg border border-zinc-200 px-3 py-2 text-sm disabled:opacity-50">
              {testing ? "Recording…" : `Test record ${TEST_MS / 1000} s`}
            </button>
            <button onClick={disable} className="shrink-0 rounded-lg border border-zinc-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50">Turn off microphone</button>
          </div>
        </>
      )}

      {msg && <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{msg}</p>}
      {clip && (
        <div className="mt-3">
          <p className="mb-1 text-xs text-zinc-500">Playback (if you hear yourself, the path works):</p>
          <AudioPlayer src={clip} className="w-full" />
        </div>
      )}

      {onConfirm && (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button onClick={confirm} disabled={status !== "ready"} className="rounded-xl bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50">
            {confirmLabel}
          </button>
          <span className="text-xs text-zinc-400">
            {heard || tested ? "Timing starts after you confirm." : "Record a test first to confirm you can hear yourself."}
          </span>
        </div>
      )}
    </div>
  );
}
