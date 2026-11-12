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
export function MicCheck({ deviceId, onDeviceChange, onConfirm, confirmLabel = "一切正常，开始考试", title = "麦克风检查", hint }: Props) {
  const rsRef = useRef<RecordingSession | null>(null);
  const handedOver = useRef(false);
  const deviceRef = useRef(deviceId ?? "");
  // Keep the latest device id without writing a ref during render.
  useEffect(() => { deviceRef.current = deviceId ?? ""; }, [deviceId]);

  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<"init" | "ready" | "error">("init");
  const [level, setLevel] = useState(0);
  const [peak, setPeak] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [clip, setClip] = useState<string | null>(null);
  const [tested, setTested] = useState(false);
  const levelTs = useRef(0);

  // Own the session: acquire on mount, release on unmount unless handed over.
  useEffect(() => {
    const rs = new RecordingSession({});
    rsRef.current = rs;
    let cancelled = false;
    void (async () => {
      try {
        await rs.acquire(deviceRef.current || undefined);
        if (cancelled) return;
        setReady(true);
        setStatus("ready");
      } catch (e) {
        if (!cancelled) { setStatus("error"); setMsg((e as Error).message); }
      }
    })();
    return () => {
      cancelled = true;
      if (!handedOver.current) rs.dispose();
      rsRef.current = null;
      setReady(false);
    };
  }, []);

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
      if (!blob || blob.size === 0) throw new Error("没有录到音频，请检查麦克风权限或换一个设备。");
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
            {hint ?? "对着麦克风随便说一句话，确认下方音量条会跳动。这里用的就是正式考试时的录音通道。"}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${status === "ready" ? "bg-emerald-50 text-emerald-700" : status === "error" ? "bg-red-50 text-red-700" : "bg-zinc-100 text-zinc-500"}`}>
          {status === "ready" ? "已连接" : status === "error" ? "不可用" : "连接中…"}
        </span>
      </div>

      <div className="mt-5 flex flex-col items-center">
        <div className="flex h-16 items-end gap-1.5" aria-label="麦克风音量">
          {Array.from({ length: bars }).map((_, i) => (
            <span
              key={i}
              className={`w-2 rounded-full transition-all ${heard ? "bg-emerald-500" : "bg-zinc-300"}`}
              style={{ height: `${Math.max(6, Math.min(56, level * 56 * (0.55 + 0.45 * Math.sin(i * 1.7 + level * 12))))}px`, opacity: level > i / bars ? 1 : 0.3 }}
            />
          ))}
        </div>
        <p className={`mt-3 text-xs ${heard ? "text-emerald-700" : "text-zinc-500"}`}>
          {status !== "ready" ? "等待麦克风…" : heard ? "已检测到声音 ✓" : "还没有检测到声音，请说话或换一个麦克风"}
        </p>
      </div>

      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <select
          className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
          value={deviceId ?? ""}
          onChange={(e) => onDeviceChange?.(e.target.value)}
        >
          <option value="">系统默认麦克风</option>
          {devices.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `麦克风 ${i + 1}`}</option>)}
        </select>
        <button onClick={reopen} className="shrink-0 rounded-lg border border-zinc-200 px-3 py-2 text-sm">换设备 / 重新检测</button>
        <button onClick={runTest} disabled={status !== "ready" || testing} className="shrink-0 rounded-lg border border-zinc-200 px-3 py-2 text-sm disabled:opacity-50">
          {testing ? "录音中…" : `试录 ${TEST_MS / 1000} 秒`}
        </button>
      </div>

      {msg && <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{msg}</p>}
      {clip && (
        <div className="mt-3">
          <p className="mb-1 text-xs text-zinc-500">回放（听到自己的声音就说明通道正常）：</p>
          <AudioPlayer src={clip} className="w-full" />
        </div>
      )}

      {onConfirm && (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button onClick={confirm} disabled={status !== "ready"} className="rounded-xl bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50">
            {confirmLabel}
          </button>
          <span className="text-xs text-zinc-400">
            {heard || tested ? "确认后开始计时。" : "建议先试录一次，确认能听到自己的声音。"}
          </span>
        </div>
      )}
    </div>
  );
}
