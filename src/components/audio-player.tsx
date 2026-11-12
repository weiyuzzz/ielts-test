"use client";
import { useEffect, useRef } from "react";

/**
 * `<audio>` wrapper that fixes a MediaRecorder quirk.
 *
 * Chrome/Edge record `audio/webm;codecs=opus`, and MediaRecorder never writes a
 * Duration element into the WebM Segment Info. The file is perfectly playable,
 * but `HTMLMediaElement.duration` is `Infinity` until the whole file is
 * buffered, so the native controls render `0:00 / 0:00` and the progress bar
 * cannot be dragged. Safari records mp4, which carries a duration, so it is
 * unaffected.
 *
 * Fix: seek far past the end once metadata is available. The browser then
 * resolves the real duration and we immediately seek back to 0. This keeps the
 * native controls (no custom player to maintain) while showing the true length.
 */
export function AudioPlayer({
  src,
  className,
  preload = "metadata",
}: {
  src: string;
  className?: string;
  preload?: "none" | "metadata" | "auto";
}) {
  const ref = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !src) return;
    let cancelled = false;

    const repair = () => {
      if (cancelled) return;
      if (Number.isFinite(el.duration) && el.duration > 0) return; // already fine (mp4 / fully buffered)
      const onSeeked = () => {
        el.removeEventListener("seeked", onSeeked);
        if (cancelled) return;
        try { el.currentTime = 0; } catch { /* ignore */ }
      };
      el.addEventListener("seeked", onSeeked);
      try {
        el.currentTime = 1e101; // forces duration resolution
      } catch {
        el.removeEventListener("seeked", onSeeked);
      }
    };

    if (el.readyState >= 1) repair();
    else el.addEventListener("loadedmetadata", repair, { once: true });

    return () => {
      cancelled = true;
      el.removeEventListener("loadedmetadata", repair);
    };
  }, [src]);

  return <audio ref={ref} controls preload={preload} src={src} className={className} />;
}
