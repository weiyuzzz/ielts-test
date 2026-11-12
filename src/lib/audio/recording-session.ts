"use client";
/**
 * Session-wide microphone + AudioContext owner.
 *
 * The old DualRecorder called getUserMedia(), created an AudioContext and a
 * ScriptProcessorNode, then destroyed all three after EVERY question (11 times
 * in a full mock). That costs a permission/device round trip per turn and is a
 * common source of clicks, startup gaps and "microphone disconnected" events.
 *
 * RecordingSession acquires ONE stream, ONE AudioContext and ONE capture node
 * for the whole session. Each answer still gets its own MediaRecorder instance
 * and its own PCM buffer, so every answer produces an independent recording
 * file exactly as before.
 *
 * Capture strategy (Chrome / Edge / Safari):
 *   1. AudioWorkletNode ("b9-pcm-capture") — audio rendering thread, no main
 *      thread jitter. Chrome 66+, Edge 79+, Safari 14.1+ (secure context).
 *   2. ScriptProcessorNode — deprecated but universally available, used when
 *      audioWorklet is missing or addModule() rejects (older Safari, http).
 *   3. MediaRecorder only — when Web Audio is unavailable entirely.
 *
 * The environment is injectable so the reuse behaviour is unit-testable in
 * Node without a browser (see tests/audio-perf.test.ts).
 */
import { pickMimeType, resample, encodeWav, rms } from "./wav";
import { RecorderError, type Recording } from "./recorder";
import { audioMetrics } from "./metrics";

export type CaptureMode = "audio-worklet" | "script-processor" | "media-recorder-only";

export interface TrackLike {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  stop(): void;
}
export interface StreamLike {
  getAudioTracks(): TrackLike[];
  getTracks(): Array<{ stop(): void }>;
}
export interface NodeLike { connect(dest: unknown): unknown; disconnect(): void }
export interface ScriptProcessorLike extends NodeLike {
  onaudioprocess: ((e: { inputBuffer: { getChannelData(i: number): Float32Array } }) => void) | null;
}
export interface WorkletNodeLike extends NodeLike {
  port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage(msg: unknown): void };
}
export interface GainLike extends NodeLike { gain: { value: number } }
export interface ContextLike {
  sampleRate: number;
  resume(): Promise<void>;
  close(): Promise<void>;
  createMediaStreamSource(stream: unknown): NodeLike;
  createGain(): GainLike;
  createScriptProcessor(bufferSize: number, inputs: number, outputs: number): ScriptProcessorLike;
  audioWorklet?: { addModule(url: string): Promise<void> };
  destination: unknown;
}
export interface RecorderLike {
  state: string;
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

export interface RecordingEnvironment {
  openStream(deviceId?: string): Promise<StreamLike>;
  createContext(): ContextLike;
  createMediaRecorder(stream: unknown, options?: { mimeType?: string }): RecorderLike;
  isTypeSupported?: (t: string) => boolean;
  createWorkletNode?: (ctx: ContextLike, name: string) => WorkletNodeLike;
  workletModuleUrl?: string;
  now?: () => number;
}

/** Real browser environment. All vendor prefixes / capability checks live here. */
export function browserRecordingEnv(): RecordingEnvironment {
  return {
    async openStream(deviceId) {
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
    },
    createContext() {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) throw new RecorderError("unsupported", "Web Audio is unavailable in this browser.");
      return new AC() as unknown as ContextLike;
    },
    createMediaRecorder(stream, options) {
      if (typeof MediaRecorder === "undefined") throw new RecorderError("unsupported", "MediaRecorder is unavailable.");
      return (options?.mimeType ? new MediaRecorder(stream as MediaStream, options) : new MediaRecorder(stream as MediaStream)) as unknown as RecorderLike;
    },
    isTypeSupported: typeof MediaRecorder !== "undefined" ? MediaRecorder.isTypeSupported?.bind(MediaRecorder) : undefined,
    createWorkletNode: typeof AudioWorkletNode !== "undefined"
      ? (ctx, name) => new AudioWorkletNode(ctx as unknown as BaseAudioContext, name, {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      }) as unknown as WorkletNodeLike
      : undefined,
    workletModuleUrl: "/audio/pcm-worklet.js",
  };
}

class PcmBuffer {
  private chunks: Float32Array[] = [];
  push(c: Float32Array) { this.chunks.push(c); }
  flatten(): Float32Array {
    if (!this.chunks.length) return new Float32Array(0);
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Float32Array(total);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

export interface RecordingSessionOptions {
  env?: RecordingEnvironment;
  onLevel?: (level: number) => void;
  onError?: (e: RecorderError) => void;
}

export class RecordingSession {
  private readonly env: RecordingEnvironment;
  private readonly now: () => number;
  private stream: StreamLike | null = null;
  private ctx: ContextLike | null = null;
  private source: NodeLike | null = null;
  private capture: NodeLike | null = null;
  private mute: GainLike | null = null;
  private sink: PcmBuffer | null = null;
  private mr: RecorderLike | null = null;
  private chunks: Blob[] = [];
  private mime = "";
  private startedAt = 0;
  private endedHandler: (() => void) | null = null;
  private disposed = false;

  onLevel?: (level: number) => void;
  onError?: (e: RecorderError) => void;
  captureMode: CaptureMode = "media-recorder-only";

  constructor(opts: RecordingSessionOptions = {}) {
    this.env = opts.env ?? browserRecordingEnv();
    this.now = opts.env?.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.onLevel = opts.onLevel;
    this.onError = opts.onError;
  }

  get ready(): boolean { return !this.disposed && !!this.stream && !!this.ctx; }

  /** Acquire the microphone + context ONCE for the whole exam. */
  async acquire(deviceId?: string): Promise<CaptureMode> {
    if (this.ready) return this.captureMode;
    if (this.disposed) throw new RecorderError("recorder_failed", "Recording session has been disposed.");
    this.stream = await this.env.openStream(deviceId);
    const track = this.stream.getAudioTracks()[0];
    if (track) {
      this.endedHandler = () => this.onError?.(new RecorderError("device_disconnected", "The microphone was disconnected during recording."));
      track.addEventListener("ended", this.endedHandler);
    }
    try {
      this.ctx = this.env.createContext();
      await this.ctx.resume().catch(() => {});
      await this.setupCapture();
    } catch (e) {
      // Web Audio unavailable → still record via MediaRecorder (WAV may be null).
      if (this.captureMode === "media-recorder-only" && !this.mr) {
        this.ctx?.close().catch(() => {});
        this.ctx = null;
      } else throw e;
    }
    return this.captureMode;
  }

  private async setupCapture(): Promise<void> {
    const ctx = this.ctx!;
    this.source = ctx.createMediaStreamSource(this.stream);
    this.mute = ctx.createGain();
    this.mute.gain.value = 0;

    // Preferred: AudioWorklet (audio rendering thread).
    if (ctx.audioWorklet && this.env.createWorkletNode && this.env.workletModuleUrl) {
      try {
        await ctx.audioWorklet.addModule(this.env.workletModuleUrl);
        const node = this.env.createWorkletNode(ctx, "b9-pcm-capture");
        node.port.onmessage = (e) => this.onPcm(toFloat32(e.data));
        this.source.connect(node);
        node.connect(this.mute);
        this.mute.connect(ctx.destination);
        this.capture = node;
        this.captureMode = "audio-worklet";
        return;
      } catch {
        // Safari < 14.1 / insecure context / module 404 → fall through.
      }
    }

    // Fallback: ScriptProcessorNode (deprecated, but works in every browser).
    if (ctx.createScriptProcessor) {
      try {
        const proc = ctx.createScriptProcessor(4096, 1, 1);
        proc.onaudioprocess = (ev) => this.onPcm(new Float32Array(ev.inputBuffer.getChannelData(0)));
        this.source.connect(proc);
        proc.connect(this.mute);
        this.mute.connect(ctx.destination);
        this.capture = proc;
        this.captureMode = "script-processor";
        return;
      } catch {
        // fall through
      }
    }
    this.captureMode = "media-recorder-only";
  }

  private onPcm(chunk: Float32Array): void {
    if (!chunk.length) return;
    this.sink?.push(chunk);
    const level = Math.min(1, rms(chunk) * 4);
    this.onLevel?.(level);
  }

  /** Begin a NEW answer: fresh MediaRecorder + fresh PCM buffer, same stream. */
  startAnswer(): void {
    if (this.disposed || !this.stream) throw new RecorderError("recorder_failed", "Recording session is not ready.");
    this.sink = new PcmBuffer();
    this.chunks = [];
    this.mr = null;
    try {
      this.mime = pickMimeType(this.env.isTypeSupported);
      this.mr = this.mime
        ? this.env.createMediaRecorder(this.stream, { mimeType: this.mime })
        : this.env.createMediaRecorder(this.stream);
      this.mime = this.mr.mimeType || this.mime;
      this.mr.ondataavailable = (e) => { if (e.data?.size) this.chunks.push(e.data); };
      this.mr.start(1000);
    } catch {
      this.mr = null; // WAV-only path
    }
    if (!this.mr && this.captureMode === "media-recorder-only") {
      throw new RecorderError("unsupported", "Neither MediaRecorder nor Web Audio is available.");
    }
    this.startedAt = this.now();
  }

  /** Finalise ONE answer. The stream/context stay alive for the next question. */
  async stopAnswer(): Promise<Recording> {
    if (!this.sink && !this.mr) return { blob: null, mimeType: "", wav: null, durationMs: 0 };
    const durationMs = Math.max(0, Math.round(this.now() - this.startedAt));
    audioMetrics.record("recording_duration_ms", durationMs, "none");
    let blob: Blob | null = null;
    if (this.mr && this.mr.state !== "inactive") {
      const mr = this.mr;
      await new Promise<void>((res) => {
        mr.onstop = () => res();
        try { mr.stop(); } catch { res(); }
      });
      if (this.chunks.length) blob = new Blob(this.chunks, { type: this.mime || this.chunks[0].type || "audio/webm" });
    }

    const encStart = this.now();
    let wav: Blob | null = null;
    const pcm = this.sink?.flatten() ?? new Float32Array(0);
    if (pcm.length && this.ctx) {
      const bytes = encodeWav(resample(pcm, this.ctx.sampleRate, 16000), 16000);
      wav = new Blob([bytes.buffer as ArrayBuffer], { type: "audio/wav" });
    }
    audioMetrics.record("audio_encoding_ms", this.now() - encStart, "none");

    this.sink = null;
    this.mr = null;
    this.chunks = [];
    return { blob, mimeType: blob?.type || (wav ? "audio/wav" : ""), wav, durationMs };
  }

  /** Re-acquire after a device change / disconnection (dispose + acquire). */
  async reopen(deviceId?: string): Promise<CaptureMode> {
    this.dispose();
    this.disposed = false;
    this.captureMode = "media-recorder-only";
    return this.acquire(deviceId);
  }

  /** Release the shared resources ONCE, when the exam ends or the page unmounts. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      const proc = this.capture as ScriptProcessorLike | null;
      if (proc) proc.onaudioprocess = null;
    } catch { /* ignore */ }
    try { (this.capture as WorkletNodeLike | null)?.port.postMessage("stop"); } catch { /* ignore */ }
    try { this.capture?.disconnect(); } catch { /* ignore */ }
    try { this.source?.disconnect(); } catch { /* ignore */ }
    try { this.mute?.disconnect(); } catch { /* ignore */ }
    this.ctx?.close().catch(() => {});
    const track = this.stream?.getAudioTracks()[0];
    if (track && this.endedHandler) {
      try { track.removeEventListener("ended", this.endedHandler); } catch { /* ignore */ }
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.ctx = null;
    this.source = null;
    this.capture = null;
    this.mute = null;
    this.sink = null;
    this.mr = null;
    this.chunks = [];
  }
}

function toFloat32(data: unknown): Float32Array {
  if (data instanceof Float32Array) return data;
  if (data instanceof ArrayBuffer) return new Float32Array(data);
  if (ArrayBuffer.isView(data)) return new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
  if (typeof data === "object" && data && "type" in data) return new Float32Array(0); // worklet control message
  return new Float32Array(0);
}
