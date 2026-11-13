"use client";
import { useEffect, useRef } from "react";
import { examinerEnvelope } from "@/lib/audio/examiner-envelope";
import type { ExaminerGender } from "@/lib/avatar/models";

/**
 * A small animated examiner. The mouth is driven by the loudness of the audio
 * that is playing right now (AnalyserNode RMS), so it opens on stressed
 * syllables and closes between sentences — it follows the content, it is not a
 * decorative loop. When no audio element exists (browser speech synthesis) the
 * mouth falls back to a syllable-paced envelope so it still moves with the line.
 *
 * Everything is written straight to the DOM inside one requestAnimationFrame
 * loop: 60fps animation must not re-render React on every frame.
 *
 * Design: the examiner is a MIDDLE-AGED professional — mature hairline with
 * grey at the temples, subtle nasolabial lines, thin-frame glasses and a
 * formal suit. Serious, IELTS-examiner authority; not a cartoon student.
 */
interface Props {
  speaking: boolean;
  listening: boolean;
  preparing?: boolean;
  name: string;
  gender?: ExaminerGender;
}

export function ExaminerAvatar({ speaking, listening, preparing = false, name, gender = "female" }: Props) {
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
      const rx = 6.2 + amp * 2.4;
      const ry = 0.8 + amp * 5.0;
      mouthRef.current?.setAttribute("rx", rx.toFixed(2));
      mouthRef.current?.setAttribute("ry", ry.toFixed(2));
      mouthOpenRef.current?.setAttribute("rx", (rx * 0.7).toFixed(2));
      mouthOpenRef.current?.setAttribute("ry", Math.max(0, ry - 1.9).toFixed(2));
      tongueRef.current?.setAttribute("opacity", (amp > 0.35 ? Math.min(0.8, (amp - 0.3) * 1.8) : 0).toFixed(2));

      // 3) Head: gentle breathing sway; a small nod while listening.
      const bob = Math.sin(t * 1.15) * 0.7;
      const nod = listeningRef.current ? Math.sin(t * 2.4) * 1.5 : 0;
      const tilt = talking ? Math.sin(t * 1.7) * 1.2 : 0;
      headRef.current?.setAttribute("transform", `translate(0 ${(bob + nod).toFixed(2)}) rotate(${tilt.toFixed(2)} 60 60)`);

      // 4) Brows lift a little on loud syllables / when preparing a question.
      const browTarget = talking ? Math.min(1, amp * 1.2) : preparingRef.current ? 0.5 : 0;
      brow += (browTarget - brow) * 0.15;
      const dy = -brow * 1.4;
      browLRef.current?.setAttribute("transform", `translate(0 ${dy.toFixed(2)})`);
      browRRef.current?.setAttribute("transform", `translate(0 ${dy.toFixed(2)})`);

      // 5) Blink.
      if (now > nextBlink) {
        blinkUntil = now + 130;
        nextBlink = now + 2800 + Math.random() * 3400;
      }
      const closed = now < blinkUntil;
      const eyeRy = closed ? 0.4 : 2.4;
      eyeLRef.current?.setAttribute("ry", String(eyeRy));
      eyeRRef.current?.setAttribute("ry", String(eyeRy));
      const pupilOpacity = closed ? "0" : "1";
      pupilLRef.current?.setAttribute("opacity", pupilOpacity);
      pupilRRef.current?.setAttribute("opacity", pupilOpacity);

      // 6) Speaking halo.
      haloRef.current?.setAttribute("opacity", (talking ? 0.16 + amp * 0.45 : 0).toFixed(2));
      haloRef.current?.setAttribute("r", (34 + amp * 5).toFixed(1));

      // 7) Shoulders breathe.
      const breath = 1 + Math.sin(t * 1.15) * 0.006;
      torsoRef.current?.setAttribute("transform", `translate(60 124) scale(1 ${breath.toFixed(4)}) translate(-60 -124)`);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const female = gender === "female";
  return (
    <div className="relative select-none" aria-label={`${name}, your examiner`} role="img">
      <svg viewBox="0 0 120 132" className="h-32 w-32 sm:h-36 sm:w-36" aria-hidden>
        <defs>
          <linearGradient id="ex-skin" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f3cfab" />
            <stop offset="100%" stopColor="#e7ab85" />
          </linearGradient>
          <linearGradient id="ex-suit" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#313e4e" />
            <stop offset="100%" stopColor="#141b26" />
          </linearGradient>
          <linearGradient id="ex-hair" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#55483c" />
            <stop offset="100%" stopColor="#38302a" />
          </linearGradient>
          <radialGradient id="ex-bg" cx="0.5" cy="0.42" r="0.7">
            <stop offset="0%" stopColor="#eef1f6" />
            <stop offset="100%" stopColor="#e3e8ef" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* soft backdrop */}
        <circle cx="60" cy="58" r="46" fill="url(#ex-bg)" />

        {/* speaking halo */}
        <circle ref={haloRef} cx="60" cy="58" r="34" fill="#6366f1" opacity="0" />

        {/* ---- torso: formal suit, lapels, tie/blouse (breathes) ---- */}
        <g ref={torsoRef}>
          <path d="M22 132 C24 106 40 95 60 95 C80 95 96 106 98 132 Z" fill="url(#ex-suit)" />
          {/* shirt V */}
          <path d="M49 95 L60 113 L71 95 Z" fill="#f8fafc" />
          {/* lapels */}
          <path d="M49 95 L60 113 L51.5 117 L41.5 99 Z" fill="#1c2530" />
          <path d="M71 95 L60 113 L68.5 117 L78.5 99 Z" fill="#1c2530" />
          {!female && (
            <>
              <path d="M59.4 99 L60.6 99 L60.2 103 L61.6 116 L60 120 L58.4 116 L59.8 103 Z" fill="#5b2333" />
              <path d="M58.9 99.5 h2.2 v2.2 h-2.2 Z" fill="#8c2b3f" />
            </>
          )}
          {female && (
            <>
              {/* blouse collar line + small pearl */}
              <path d="M53 96 L57 106 M67 96 L63 106" stroke="#d7dde8" strokeWidth="1.4" fill="none" />
              <circle cx="60" cy="111" r="1.5" fill="#c7cfdd" />
            </>
          )}
        </g>

        {/* ---- hair BACK layer ---- */}
        {female && (
          <>
            {/* chin-length bob behind the head */}
            <path d="M31 52 C29 72 33 84 40 88 C38 78 37 66 38 58 C40 46 48 40 60 39 C72 40 80 46 82 58 C83 66 82 78 80 88 C87 84 91 72 89 52 C87 32 75 24 60 24 C45 24 33 32 31 52 Z" fill="url(#ex-hair)" />
            {/* grey streaks */}
            <path d="M34 46 C33 58 34 70 37 80" stroke="#8c8578" strokeWidth="1.4" fill="none" opacity="0.7" />
            <path d="M86 46 C87 58 86 70 83 80" stroke="#8c8578" strokeWidth="1.4" fill="none" opacity="0.7" />
          </>
        )}
        {!female && (
          <>
            {/* short sides + back (receding top) */}
            <path d="M34 50 C34 40 38 33 44 30 C42 36 41 44 41 52 C41 62 43 70 46 76 C40 70 34 62 34 50 Z" fill="url(#ex-hair)" />
            <path d="M86 50 C86 40 82 33 76 30 C78 36 79 44 79 52 C79 62 77 70 74 76 C80 70 86 62 86 50 Z" fill="url(#ex-hair)" />
            {/* grey temples */}
            <path d="M36 44 C35.5 50 36 56 37.5 61" stroke="#8c8578" strokeWidth="1.6" fill="none" opacity="0.75" />
            <path d="M84 44 C84.5 50 84 56 82.5 61" stroke="#8c8578" strokeWidth="1.6" fill="none" opacity="0.75" />
          </>
        )}

        {/* ---- head group (animated) ---- */}
        <g ref={headRef}>
          {/* neck */}
          <rect x="53" y="80" width="14" height="18" rx="6" fill="#e2a87f" />
          {/* ears */}
          <circle cx="33" cy="60" r="5" fill="#eec099" />
          <circle cx="87" cy="60" r="5" fill="#eec099" />
          <circle cx="33" cy="60" r="2" fill="#dc9f76" />
          <circle cx="87" cy="60" r="2" fill="#dc9f76" />
          {/* head — slightly narrower/jawed for age */}
          <ellipse cx="60" cy="56" rx="25" ry="27.5" fill="url(#ex-skin)" />

          {/* male: thin comb-over top, high forehead */}
          {!female && (
            <path d="M36 46 C36 34 46 28 60 28 C74 28 84 34 84 46 C84 41 78 36.5 70 35.6 C58 34.2 44 36 38 41 C36.5 43 36 44.5 36 46 Z" fill="url(#ex-hair)" />
          )}
          {/* female: swept-back front hair */}
          {female && (
            <path d="M33 48 C33 30 44 23 60 23 C76 23 87 30 87 48 C87 40 83 33 75 30 C67 34 54 37.5 45 36.5 C38 39 34 43 33 48 Z" fill="url(#ex-hair)" />
          )}

          {/* forehead crease (subtle age mark) */}
          <path d="M50 36 q10 -2.4 20 0" stroke="#d69d74" strokeWidth="0.9" fill="none" opacity="0.6" />

          {/* brows — firmer, straighter */}
          <path ref={browLRef} d="M45.5 45.5 q6 -2.2 11.5 -0.8" stroke="#4a3d31" strokeWidth="2.3" strokeLinecap="round" fill="none" />
          <path ref={browRRef} d="M63 44.7 q6 -1.6 11.5 0.8" stroke="#4a3d31" strokeWidth="2.3" strokeLinecap="round" fill="none" />

          {/* eyes */}
          <ellipse ref={eyeLRef} cx="51" cy="55" rx="4.2" ry="2.4" fill="#ffffff" stroke="#92765a" strokeWidth="0.8" />
          <ellipse ref={eyeRRef} cx="69" cy="55" rx="4.2" ry="2.4" fill="#ffffff" stroke="#92765a" strokeWidth="0.8" />
          <circle ref={pupilLRef} cx="51.5" cy="55" r="1.7" fill="#39322c" />
          <circle ref={pupilRRef} cx="68.5" cy="55" r="1.7" fill="#39322c" />
          <circle cx="50.8" cy="54.4" r="0.55" fill="#ffffff" />
          <circle cx="67.8" cy="54.4" r="0.55" fill="#ffffff" />

          {/* thin examiner glasses */}
          <ellipse cx="51" cy="55" rx="6" ry="4.5" fill="none" stroke="#3c4655" strokeWidth="1" opacity="0.9" />
          <ellipse cx="69" cy="55" rx="6" ry="4.5" fill="none" stroke="#3c4655" strokeWidth="1" opacity="0.9" />
          <path d="M57 54.4 q3 -1.5 6 0" stroke="#3c4655" strokeWidth="1" fill="none" opacity="0.9" />

          {/* nose */}
          <path d="M60 58.5 q-2 5 1 6.5" stroke="#cf9a72" strokeWidth="1.4" strokeLinecap="round" fill="none" />

          {/* mouth: outer lips + inner cavity + tongue */}
          <ellipse ref={mouthRef} cx="60" cy="72.5" rx="6.2" ry="0.8" fill="#a44e5c" />
          <ellipse ref={mouthOpenRef} cx="60" cy="72.5" rx="4.4" ry="0.8" fill="#571c29" />
          <ellipse ref={tongueRef} cx="60" cy="74.4" rx="2.8" ry="1.3" fill="#d8758a" opacity="0" />
          {/* nasolabial lines (subtle age mark) */}
          <path d="M53.5 69.5 q-2.4 3.2 -1.4 6.2" stroke="#c6946e" strokeWidth="0.9" fill="none" opacity="0.55" />
          <path d="M66.5 69.5 q2.4 3.2 1.4 6.2" stroke="#c6946e" strokeWidth="0.9" fill="none" opacity="0.55" />
          {/* resting professional line */}
          <path d="M54.5 71.5 q5.5 1.2 11 0" stroke="#8c4a56" strokeWidth="1" strokeLinecap="round" fill="none" opacity="0.6" />
        </g>

        {/* collar */}
        <path d="M48 98 q12 9 24 0" stroke="#dbe3f2" strokeWidth="1.6" fill="none" />
      </svg>
    </div>
  );
}
