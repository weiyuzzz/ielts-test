/**
 * Study-page playback. Deliberately separate from `lib/audio/speech.ts`.
 *
 * The examiner pipeline owns a global scheduler, a prefetch queue and a
 * playback state machine, and is tuned for a mock test where a line must start
 * within milliseconds. Study material has the opposite requirements: it is
 * played on demand, often paused, often replayed, and it must NEVER touch the
 * examiner's queue. So this module uses a plain <audio> element and (when the
 * deployment has no server engine) the browser's own speech synthesis.
 *
 * Everything here stays inside one page; object URLs are revoked when replaced
 * so a long study session does not leak blobs.
 */
import type { VoiceProfile } from "@/lib/speaking/voice-profile";

let element: HTMLAudioElement | null = null;
const urlCache = new Map<string, string>();
const CACHE_LIMIT = 24;

function audioEl(): HTMLAudioElement {
  if (!element) {
    element = new Audio();
    element.preload = "auto";
  }
  return element;
}

/** Stop whatever is playing. Safe to call on unmount. */
export function stopPlayback(): void {
  if (element) {
    element.onended = null;
    element.onerror = null;
    try { element.pause(); } catch { /* ignore */ }
    element.removeAttribute("src");
  }
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
  }
}

function playSource(src: string): Promise<void> {
  const el = audioEl();
  stopPlayback();
  el.src = src;
  return new Promise<void>((resolve, reject) => {
    el.onended = () => resolve();
    el.onerror = () => reject(new Error("audio playback failed"));
    el.play().then(() => undefined).catch(reject);
  });
}

/** Pause/resume the study player — used when a take starts recording. */
export function pausePlayback(): void {
  if (element) { try { element.pause(); } catch { /* ignore */ } }
}

export function resumePlayback(): void {
  if (element?.src) { void element.play().catch(() => {}); }
}

function cacheKey(text: string, profile: VoiceProfile): string {
  return `${profile.id}|${profile.speed}|${profile.voice}|${text}`;
}

async function ttsUrl(text: string, profile: VoiceProfile): Promise<string> {
  const key = cacheKey(text, profile);
  const hit = urlCache.get(key);
  if (hit) return hit;
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, act: "question", profile }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new Error(body.code === "browser_tts" ? "browser" : body.error || `TTS ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  if (urlCache.size >= CACHE_LIMIT) {
    const [oldKey, oldUrl] = urlCache.entries().next().value as [string, string];
    URL.revokeObjectURL(oldUrl);
    urlCache.delete(oldKey);
  }
  urlCache.set(key, url);
  return url;
}

function browserSpeak(text: string, rate: number): Promise<void> {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return Promise.reject(new Error("Browser speech synthesis is unavailable."));
  }
  window.speechSynthesis.cancel();
  return new Promise<void>((resolve, reject) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-GB";
    u.rate = Math.min(1.4, Math.max(0.6, rate));
    u.onend = () => resolve();
    u.onerror = () => reject(new Error("Browser speech synthesis failed."));
    window.speechSynthesis.speak(u);
  });
}

export interface SpeakResult {
  engine: "server" | "browser";
}

/**
 * Read a study line aloud. Prefers the deployment's neural engine and falls
 * back to the browser voice only when the server has none — the caller shows
 * which engine was used, so a mechanical fallback is never mistaken for the
 * real examiner voice.
 */
export async function speakStudyText(text: string, profile: VoiceProfile, serverTts: boolean): Promise<SpeakResult> {
  if (serverTts) {
    try {
      await playSource(await ttsUrl(text, profile));
      return { engine: "server" };
    } catch {
      // fall through to the browser voice
    }
  }
  await browserSpeak(text, profile.speed);
  return { engine: "browser" };
}

/** Play a stored audio file (a follow recording, or the learner's own take). */
export function playStoredAudio(src: string): Promise<void> {
  return playSource(src);
}
