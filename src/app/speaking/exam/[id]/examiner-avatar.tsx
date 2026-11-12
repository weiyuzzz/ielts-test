"use client";
import { useEffect, useRef } from "react";
import { examinerEnvelope } from "@/lib/audio/examiner-envelope";

/**
 * A small animated examiner. The mouth is driven by the loudness of the audio
 * that is playing right now (AnalyserNode RMS), so it opens on stressed
 * syllables and closes between sentences — it follows the content, it is not a
 * decorative loop. When no audio element exists (browser speech synthesis) the
 * mouth falls back to a syllable-paced envelope so it still moves with the line.
 *
 * Everything is written straight to the DOM inside one requestAnimationFrame
 * loop: 60fps animation must not re-render React on every frame.
 */
interface Props {
  speaking: boolean;
  listening: boolean;
  preparing?: boolean;
  name: string;
}

export function ExaminerAvatar({ speaking, listening, preparing = false, name }: Props) {
  const headRef = useRef<SVGGElement | null>(null);
  const mouthRef = useRef<SVGEllipseElement | null>(null);
  const mouthOpenRef = useRef<SVGEllipseElement | null>(null);
  const tongueRef = useRef<SVGEllipseElement | null>(null);
  const eyeLRef = useRef<SVGEllipseElement | null>(null);
  const eyeRRef = useRef<SVGEllipseElement | null>(null);
  const pupilLRef = useRef<SVGCircleElement | null>(null);
  const pupilRRef = useRef<SVGCircleElement | null>(null);
  const browLRef = useRef<SVGPathElement | null>(null);
  const browRRef = useRef<SVGPathElement | null>(null);
  const haloRef = useRef<SVGCircleElement | null>(null);
  const torsoRef = useRef<SVGGElement | null>(null);

  // Mode lives in a ref so the animation loop never has to restart.
  // Mode mirrors live in refs so the animation loop never restarts; they are
  // written in effects (never during render).
  const speakingRef = useRef(speaking);
  const listeningRef = useRef(listening);
  const preparingRef = useRef(preparing);
  useEffect(() => { speakingRef.current = speaking; }, [speaking]);
  useEffect(() => { listeningRef.current = listening; }, [listening]);
  useEffect(() => { preparingRef.current = preparing; }, [preparing]);

  useEffect(() => {
    let raf = 0;
    let amp = 0;
    let brow = 0;
    let nextBlink = 1200;
    let blinkUntil = 0;
    const start = performance.now();

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const t = (now - start) / 1000;
      const talking = speakingRef.current;

      // 1) Target mouth opening.
      let target = 0;
      if (talking) {
        const measured = examinerEnvelope();
        if (measured >= 0) {
          target = measured;
        } else {
          // No analyser: pace the mouth at ~3.4 syllables/second with a phrase
          // envelope on top, so it still starts and stops with the utterance.
          const syl = Math.abs(Math.sin(t * Math.PI * 3.4));
          const phrase = 0.72 + 0.28 * Math.sin(t * 2.2);
          target = Math.pow(syl, 0.7) * phrase;
        }
      }
      // Fast attack, slower release — the way a jaw actually moves.
      amp += (target - amp) * (target > amp ? 0.5 : 0.22);

      // 2) Mouth geometry.
      const rx = 6.4 + amp * 2.6;
      const ry = 0.9 + amp * 6.2;
      mouthRef.current?.setAttribute("rx", rx.toFixed(2));
      mouthRef.current?.setAttribute("ry", ry.toFixed(2));
      mouthOpenRef.current?.setAttribute("rx", (rx * 0.72).toFixed(2));
      mouthOpenRef.current?.setAttribute("ry", Math.max(0, ry - 2.1).toFixed(2));
      tongueRef.current?.setAttribute("opacity", (amp > 0.35 ? Math.min(0.9, (amp - 0.3) * 1.8) : 0).toFixed(2));

      // 3) Head: gentle breathing sway; a small nod while listening.
      const bob = Math.sin(t * 1.15) * 0.7;
      const nod = listeningRef.current ? Math.sin(t * 2.4) * 1.5 : 0;
      const tilt = talking ? Math.sin(t * 1.7) * 1.2 : 0;
      headRef.current?.setAttribute("transform", `translate(0 ${(bob + nod).toFixed(2)}) rotate(${tilt.toFixed(2)} 60 60)`);

      // 4) Brows lift a little on loud syllables / when preparing a question.
      const browTarget = talking ? Math.min(1, amp * 1.2) : preparingRef.current ? 0.55 : 0;
      brow += (browTarget - brow) * 0.15;
      const dy = -brow * 1.6;
      browLRef.current?.setAttribute("transform", `translate(0 ${dy.toFixed(2)})`);
      browRRef.current?.setAttribute("transform", `translate(0 ${dy.toFixed(2)})`);

      // 5) Blink.
      if (now > nextBlink) {
        blinkUntil = now + 120;
        nextBlink = now + 2600 + Math.random() * 3200;
      }
      const closed = now < blinkUntil;
      const eyeRy = closed ? 0.35 : 2.7;
      eyeLRef.current?.setAttribute("ry", String(eyeRy));
      eyeRRef.current?.setAttribute("ry", String(eyeRy));
      const pupilOpacity = closed ? "0" : "1";
      pupilLRef.current?.setAttribute("opacity", pupilOpacity);
      pupilRRef.current?.setAttribute("opacity", pupilOpacity);

      // 6) Speaking halo.
      haloRef.current?.setAttribute("opacity", (talking ? 0.18 + amp * 0.5 : 0).toFixed(2));
      haloRef.current?.setAttribute("r", (34 + amp * 6).toFixed(1));

      // 7) Shoulders breathe.
      const breath = 1 + Math.sin(t * 1.15) * 0.006;
      torsoRef.current?.setAttribute("transform", `translate(60 124) scale(1 ${breath.toFixed(4)}) translate(-60 -124)`);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="relative select-none" aria-label={`${name}, your examiner`} role="img">
      <svg viewBox="0 0 120 132" className="h-32 w-32 sm:h-36 sm:w-36" aria-hidden>
        <defs>
          <linearGradient id="ex-shirt" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6366f1" />
            <stop offset="100%" stopColor="#4f46e5" />
          </linearGradient>
        </defs>

        {/* speaking halo */}
        <circle ref={haloRef} cx="60" cy="58" r="34" fill="#6366f1" opacity="0" />

        {/* torso + shoulders */}
        <g ref={torsoRef}>
          <path d="M28 132 C30 108 42 98 60 98 C78 98 90 108 92 132 Z" fill="url(#ex-shirt)" />
          <path d="M52 98 L60 110 L68 98 L60 95 Z" fill="#f8fafc" />
        </g>

        <g ref={headRef}>
          {/* neck */}
          <rect x="53" y="84" width="14" height="16" rx="6" fill="#e8b48c" />
          {/* ears */}
          <circle cx="34" cy="60" r="5" fill="#f0c09a" />
          <circle cx="86" cy="60" r="5" fill="#f0c09a" />
          {/* head */}
          <ellipse cx="60" cy="56" rx="26" ry="29" fill="#f7c9a3" />
          {/* hair */}
          <path d="M34 48 C36 24 84 24 86 48 C84 40 74 34 60 34 C46 34 36 40 34 48 Z" fill="#3f3f46" />
          <path d="M33 47 C33 60 32 64 33 66 C30 60 30 50 33 44 Z" fill="#3f3f46" />
          <path d="M87 47 C87 60 88 64 87 66 C90 60 90 50 87 44 Z" fill="#3f3f46" />

          {/* brows */}
          <path ref={browLRef} d="M46 48 q6 -4 12 -1" stroke="#3f3f46" strokeWidth="2.2" strokeLinecap="round" fill="none" />
          <path ref={browRRef} d="M62 47 q6 -3 12 1" stroke="#3f3f46" strokeWidth="2.2" strokeLinecap="round" fill="none" />

          {/* eyes */}
          <ellipse ref={eyeLRef} cx="52" cy="56" rx="4.2" ry="2.7" fill="#ffffff" stroke="#3f3f46" strokeWidth="1" />
          <ellipse ref={eyeRRef} cx="68" cy="56" rx="4.2" ry="2.7" fill="#ffffff" stroke="#3f3f46" strokeWidth="1" />
          <circle ref={pupilLRef} cx="52" cy="56" r="1.7" fill="#27272a" />
          <circle ref={pupilRRef} cx="68" cy="56" r="1.7" fill="#27272a" />

          {/* nose */}
          <path d="M60 60 q-2 6 1 7" stroke="#dda07c" strokeWidth="1.6" strokeLinecap="round" fill="none" />

          {/* mouth: outer opening + inner cavity + tongue */}
          <ellipse ref={mouthRef} cx="60" cy="74" rx="6.4" ry="0.9" fill="#9f1239" />
          <ellipse ref={mouthOpenRef} cx="60" cy="74" rx="4.6" ry="0.9" fill="#450a0a" />
          <ellipse ref={tongueRef} cx="60" cy="76.4" rx="3" ry="1.6" fill="#fb7185" opacity="0" />
        </g>

        {/* collar */}
        <path d="M50 100 q10 8 20 0" stroke="#e0e7ff" strokeWidth="1.4" fill="none" />
      </svg>
    </div>
  );
}
