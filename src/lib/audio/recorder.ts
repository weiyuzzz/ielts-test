"use client";
/**
 * Dual-path recorder (pattern learned from the reverse-engineering study):
 *  1. MediaRecorder with negotiated MIME (webm/opus on Chrome, mp4/aac on Safari) → playback + server ASR
 *  2. Web Audio PCM capture → 16 kHz mono WAV → audio-based pronunciation assessment
 * Also exposes a live input level and detects device disconnection.
 */
import { pickMimeType, resample, encodeWav, rms } from "./wav";

export type RecorderErrorCode = "insecure" | "unsupported" | "permission_denied" | "no_device" | "device_disconnected" | "recorder_failed";
export class RecorderError extends Error {
  constructor(public code: RecorderErrorCode, message: string) {
    super(message);
  }
}

export interface Recording {
  blob: Blob | null;
  mimeType: string;
  wav: Blob | null;
  durationMs: number;
}

export async function listInputDevices(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
}

/** Request permission once (and release the stream). */
export async function requestMicPermission(deviceId?: string): Promise<void> {
  const s = await openStream(deviceId);
  s.getTracks().forEach((t) => t.stop());
}

/** Shared by the legacy DualRecorder and the session-wide RecordingSession. */
export async function openStream(deviceId?: string): Promise<MediaStream> {
  if (typeof window !== "undefined" && !window.isSecureContext) throw new RecorderError("insecure", "Recording needs HTTPS or localhost.");
  if (!navigator.mediaDevices?.getUserMedia) throw new RecorderError("unsupported", "This browser does not support microphone recording.");
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    const name = (e as DOMException).name;
    if (name === "NotAllowedError" || name === "SecurityError") throw new RecorderError("permission_denied", "Microphone permission was denied. Allow microphone access in your browser settings.");
    if (name === "NotFoundError" || name === "OverconstrainedError") throw new RecorderError("no_device", "No microphone found (or the selected device is unavailable).");
    throw new RecorderError("recorder_failed", (e as Error).message);
  }
}

export class DualRecorder {
  private stream: MediaStream | null = null;
  private mr: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private ctx: AudioContext | null = null;
  private proc: ScriptProcessorNode | null = null;
  private pcm: Float32Array[] = [];
  private startedAt = 0;
  private mime = "";
  level = 0;
  onLevel?: (l: number) => void;
  onError?: (e: RecorderError) => void;

  async start(deviceId?: string) {
    this.stream = await openStream(deviceId);
    const track = this.stream.getAudioTracks()[0];
    track.addEventListener("ended", () => this.onError?.(new RecorderError("device_disconnected", "The microphone was disconnected during recording.")));

    if (typeof MediaRecorder !== "undefined") {
      this.mime = pickMimeType(MediaRecorder.isTypeSupported?.bind(MediaRecorder));
      try {
        this.mr = this.mime ? new MediaRecorder(this.stream, { mimeType: this.mime }) : new MediaRecorder(this.stream);
        this.mime = this.mr.mimeType || this.mime;
        this.chunks = [];
        this.mr.ondataavailable = (e) => e.data?.size && this.chunks.push(e.data);
        this.mr.start(1000);
      } catch {
        this.mr = null; // fall back to WAV only
      }
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AC) {
      this.ctx = new AC();
      await this.ctx.resume().catch(() => {});
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      this.pcm = [];
      this.proc.onaudioprocess = (ev) => {
        const d = new Float32Array(ev.inputBuffer.getChannelData(0));
        this.pcm.push(d);
        this.level = Math.min(1, rms(d) * 4);
        this.onLevel?.(this.level);
      };
      src.connect(this.proc);
      this.proc.connect(mute);
      mute.connect(this.ctx.destination);
    }
    if (!this.mr && !this.ctx) throw new RecorderError("unsupported", "Neither MediaRecorder nor Web Audio is available.");
    this.startedAt = performance.now();
  }

  async stop(): Promise<Recording> {
    const durationMs = Math.round(performance.now() - this.startedAt);
    let blob: Blob | null = null;
    if (this.mr && this.mr.state !== "inactive") {
      const mr = this.mr;
      await new Promise<void>((res) => {
        mr.onstop = () => res();
        try {
          mr.stop();
        } catch {
          res();
        }
      });
      if (this.chunks.length) blob = new Blob(this.chunks, { type: this.mime || this.chunks[0].type || "audio/webm" });
    }
    let wav: Blob | null = null;
    if (this.ctx && this.pcm.length) {
      const total = this.pcm.reduce((n, c) => n + c.length, 0);
      const all = new Float32Array(total);
      let o = 0;
      for (const c of this.pcm) {
        all.set(c, o);
        o += c.length;
      }
      const bytes = encodeWav(resample(all, this.ctx.sampleRate, 16000), 16000);
      wav = new Blob([bytes.buffer as ArrayBuffer], { type: "audio/wav" });
    }
    this.cleanup();
    return { blob, mimeType: blob?.type || (wav ? "audio/wav" : ""), wav, durationMs };
  }

  cleanup() {
    try {
      this.proc?.disconnect();
    } catch {}
    if (this.proc) this.proc.onaudioprocess = null;
    this.ctx?.close().catch(() => {});
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.mr = null;
    this.ctx = null;
    this.proc = null;
    this.pcm = [];
    this.chunks = [];
  }
}
