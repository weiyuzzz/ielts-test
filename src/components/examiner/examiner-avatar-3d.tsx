"use client";
/**
 * 3D digital examiner — Three.js + GLB with Oculus 15-viseme morph targets.
 *
 * Rendering rules (spec: the digital human must never disturb the exam):
 *  - ONE requestAnimationFrame loop, everything written to GPU objects
 *    directly; zero React state per frame.
 *  - Mouth: viseme channels sampled from the shared lip-sync controller
 *    (audio-clock driven) + the real RMS envelope as an organic modifier.
 *  - Idle life: randomized blinking, gaze saccades, breath, brow emphasis and
 *    non-repeating head motion (irrational-frequency sine mix — no fixed loops).
 *  - Performance: pixelRatio capped, `low-power` GPU hint, rendering pauses
 *    when the tab is hidden or the canvas is offscreen; full dispose on
 *    unmount (geometry/textures are owned by the model, renderer context
 *    released).
 *  - Degradation: any failure (no WebGL, model missing, three failed to load)
 *    falls back to the existing 2D SVG avatar — the exam keeps working.
 */
import { useEffect, useRef, useState } from "react";
import { ExaminerAvatar } from "@/app/speaking/exam/[id]/examiner-avatar";
import { examinerEnvelope } from "@/lib/audio/examiner-envelope";
import { lipSync } from "@/lib/lipsync/controller";
import { visemeIndex } from "@/lib/lipsync/types";
import { EXAMINER_MODELS, OCULUS_TO_VISEME, type ExaminerGender } from "@/lib/avatar/models";

interface Props {
  gender: ExaminerGender;
  speaking: boolean;
  listening: boolean;
  preparing?: boolean;
  name: string;
  className?: string;
}

/** Everything the animation loop needs, built once per mount. */
interface Rig {
  renderer: import("three").WebGLRenderer;
  scene: import("three").Scene;
  camera: import("three").PerspectiveCamera;
  meshes: { mesh: import("three").Mesh; index: Record<string, number> }[];
  bones: Partial<Record<string, import("three").Object3D>>;
  baseRotations: Map<import("three").Object3D, { x: number; y: number; z: number }>;
}

const MORPH_ALIAS: Record<string, string> = {
  jawOpen: "jawOpen",
  eyeBlinkLeft: "eyeBlinkLeft",
  eyeBlinkRight: "eyeBlinkRight",
  browInnerUp: "browInnerUp",
  browOuterUpLeft: "browOuterUpLeft",
  browOuterUpRight: "browOuterUpRight",
  mouthSmileLeft: "mouthSmileLeft",
  mouthSmileRight: "mouthSmileRight",
  eyeLookInLeft: "eyeLookInLeft",
  eyeLookOutLeft: "eyeLookOutLeft",
  eyeLookInRight: "eyeLookInRight",
  eyeLookOutRight: "eyeLookOutRight",
  eyeLookUpLeft: "eyeLookUpLeft",
  eyeLookUpRight: "eyeLookUpRight",
  eyeLookDownLeft: "eyeLookDownLeft",
  eyeLookDownRight: "eyeLookDownRight",
};

export function ExaminerAvatar3D(props: Props) {
  const [failed, setFailed] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Mode mirrors live in a ref so the animation loop never restarts; they are
  // written in an effect, never during render.
  const refs = useRef({ speaking: props.speaking, listening: props.listening, preparing: !!props.preparing });
  useEffect(() => {
    refs.current = { speaking: props.speaking, listening: props.listening, preparing: !!props.preparing };
  }, [props.speaking, props.listening, props.preparing]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      let THREE: typeof import("three");
      let GLTFLoaderCtor: typeof import("three/examples/jsm/loaders/GLTFLoader.js").GLTFLoader;
      try {
        THREE = await import("three");
        ({ GLTFLoader: GLTFLoaderCtor } = await import("three/examples/jsm/loaders/GLTFLoader.js"));
      } catch {
        setFailed(true);
        return;
      }
      if (disposed) return;

      // --- renderer / scene -------------------------------------------------
      let renderer: import("three").WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
      } catch {
        setFailed(true);
        return;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 20);

      // Soft three-point studio lighting (matches the reference portraits).
      const hemi = new THREE.HemisphereLight(0xffffff, 0x9ca3af, 1.05);
      scene.add(hemi);
      const key = new THREE.DirectionalLight(0xffffff, 1.5);
      key.position.set(0.8, 1.4, 1.6);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0xdbeafe, 0.7);
      rim.position.set(-1.2, 0.8, -1.4);
      scene.add(rim);

      // --- model ------------------------------------------------------------
      const model = EXAMINER_MODELS[props.gender];
      let rig: Rig | null = null;
      try {
        const loader = new GLTFLoaderCtor();
        const gltf = await loader.loadAsync(model.modelUrl);
        if (disposed) return;
        const root = gltf.scene;
        root.traverse((obj) => {
          const m = obj as import("three").Mesh;
          if (m.isMesh) {
            m.frustumCulled = false;
            if (m.material) {
              const mats = Array.isArray(m.material) ? m.material : [m.material];
              for (const mat of mats) {
                mat.side = THREE.FrontSide;
              }
            }
          }
        });
        scene.add(root);

        // Collect morph targets + bones.
        const meshes: Rig["meshes"] = [];
        const index: Record<string, number> = {};
        root.traverse((obj) => {
          const m = obj as import("three").Mesh;
          if (m.isMesh && m.morphTargetDictionary && m.morphTargetInfluences) {
            meshes.push({ mesh: m, index: m.morphTargetDictionary });
            for (const [name, idx] of Object.entries(m.morphTargetDictionary)) {
              if (!(name in index)) index[name] = idx;
            }
          }
        });
        const bones: Rig["bones"] = {};
        const baseRotations = new Map<import("three").Object3D, { x: number; y: number; z: number }>();
        const wanted = ["Head", "Neck", "Spine", "Spine1", "Spine2", "LeftEye", "RightEye"];
        root.traverse((obj) => {
          if (wanted.includes(obj.name) && !bones[obj.name]) {
            bones[obj.name] = obj;
            baseRotations.set(obj, { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z });
          }
        });

        // T-pose → relaxed A-pose: bring the upper arms (and forearms) down
        // beside the torso so the exam framing shows natural shoulders.
        const restArms: [string, number][] = [
          ["LeftArm", -1.15], ["RightArm", 1.15],
          ["LeftForeArm", -0.12], ["RightForeArm", 0.12],
        ];
        for (const [name, rz] of restArms) {
          const found: import("three").Object3D[] = [];
          root.traverse((obj) => { if (obj.name === name) found.push(obj); });
          for (const arm of found) arm.rotation.z += rz;
        }

        // Frame head-and-shoulders like the reference portraits. GLB humanoids
        // arrive in T-pose, so the upper arms are also rotated down into an
        // A-pose and the camera sits close enough that shoulders fill the frame.
        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const headY = box.max.y - size.y * 0.075; // head centre
        const dist = Math.max(0.45, size.y * 0.42);
        camera.position.set(center.x, headY + size.y * 0.015, dist);
        camera.lookAt(center.x, headY - size.y * 0.02, center.z);

        rig = { renderer, scene, camera, meshes, bones, baseRotations };
      } catch {
        setFailed(true);
        return;
      }
      if (disposed || !rig) return;

      // --- helpers ----------------------------------------------------------
      const has = (name: string) => rig!.meshes.some((m) => m.index[name] !== undefined);
      const setMorph = (name: string, value: number) => {
        for (const { mesh, index } of rig!.meshes) {
          const idx = index[name];
          if (idx !== undefined) mesh.morphTargetInfluences![idx] = value;
        }
      };

      const visemeMorphs: Record<string, string> = {};
      for (const [oculus, vis] of Object.entries(OCULUS_TO_VISEME)) visemeMorphs[vis] = oculus;
      const visemeAvailable: Record<string, boolean> = {};
      for (const vis of Object.values(OCULUS_TO_VISEME)) visemeAvailable[vis] = has(visemeMorphs[vis] ?? "");
      const can = {
        jaw: has("jawOpen"),
        blinkL: has("eyeBlinkLeft"),
        blinkR: has("eyeBlinkRight"),
        browIn: has("browInnerUp"),
        browOutL: has("browOuterUpLeft"),
        browOutR: has("browOuterUpRight"),
        smileL: has("mouthSmileLeft"),
        smileR: has("mouthSmileRight"),
        gaze: has("eyeLookInLeft") || has("eyeLookOutLeft"),
        head: !!(rig.bones.Head || rig.bones.Neck),
        breath: !!(rig.bones.Spine || rig.bones.Spine1 || rig.bones.Spine2),
      };

      const channels = new Float32Array(15);
      const applyVisemes = (jawBoost: number) => {
        for (const [vis, oculus] of Object.entries(visemeMorphs)) {
          if (!visemeAvailable[vis]) continue;
          setMorph(oculus, channels[visemeIndex(vis as never)] * 0.92);
        }
        if (can.jaw) {
          const vowelOpen = Math.max(channels[visemeIndex("aa")], channels[visemeIndex("E")], channels[visemeIndex("oh")], channels[visemeIndex("ih")], channels[visemeIndex("ou")]);
          setMorph("jawOpen", Math.min(1, vowelOpen * 0.65 + jawBoost * 0.35));
        }
      };

      // --- idle life --------------------------------------------------------
      let raf = 0;
      let last = performance.now();
      const start = last;
      let nextBlink = start + 1200 + Math.random() * 2600;
      let blinkPhase = -1; // -1 idle; else ms into blink
      let nextSaccade = start + 900 + Math.random() * 2200;
      let gaze = { x: 0, y: 0 };
      let gazeTarget = { x: 0, y: 0 };
      let browPulse = 0;
      let lastEmphasisPulse = 0;
      let prevEmphasis = 0;
      let headNod = 0;

      const frame = (now: number) => {
        raf = requestAnimationFrame(frame);
        if (document.hidden) return;
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        const t = (now - start) / 1000;
        const st = refs.current;

        // 1) Lip sync — audio-clock driven; RMS adds organic jitter.
        const rms = Math.max(0, examinerEnvelope());
        const s = lipSync.sample(rms, now);
        channels.set(s.channels);
        const jawBoost = st.speaking ? Math.min(0.3, rms * 0.45) : 0;
        applyVisemes(jawBoost);

        // 2) Blink (randomized; occasional double blink).
        if (blinkPhase < 0 && now > nextBlink) {
          blinkPhase = 0;
          nextBlink = now + 2400 + Math.random() * 3800 + (Math.random() < 0.08 ? -2200 : 0);
        }
        if (blinkPhase >= 0) {
          blinkPhase += dt * 1000;
          const closed = blinkPhase < 90 ? blinkPhase / 90 : Math.max(0, 1 - (blinkPhase - 90) / 110);
          if (can.blinkL) setMorph("eyeBlinkLeft", closed);
          if (can.blinkR) setMorph("eyeBlinkRight", closed);
          if (blinkPhase > 210) {
            blinkPhase = -1;
            if (can.blinkL) setMorph("eyeBlinkLeft", 0);
            if (can.blinkR) setMorph("eyeBlinkRight", 0);
          }
        }

        // 3) Gaze saccades (micro look-arounds; gaze returns to camera).
        if (now > nextSaccade) {
          gazeTarget = { x: (Math.random() - 0.5) * 0.5, y: (Math.random() - 0.5) * 0.25 };
          nextSaccade = now + 1800 + Math.random() * 3200;
          if (Math.random() < 0.4) gazeTarget = { x: 0, y: 0 };
        }
        gaze.x += (gazeTarget.x - gaze.x) * Math.min(1, dt * 9);
        gaze.y += (gazeTarget.y - gaze.y) * Math.min(1, dt * 9);
        if (can.gaze) {
          setMorph("eyeLookInLeft", Math.max(0, -gaze.x));
          setMorph("eyeLookOutLeft", Math.max(0, gaze.x));
          setMorph("eyeLookInRight", Math.max(0, gaze.x));
          setMorph("eyeLookOutRight", Math.max(0, -gaze.x));
          setMorph("eyeLookUpLeft", Math.max(0, -gaze.y));
          setMorph("eyeLookUpRight", Math.max(0, -gaze.y));
          setMorph("eyeLookDownLeft", Math.max(0, gaze.y));
          setMorph("eyeLookDownRight", Math.max(0, gaze.y));
        }

        // 4) Brow emphasis follows the strongest viseme channel (speech), a
        //    gentle raise while preparing, rest otherwise.
        const emphasis = st.speaking ? s.emphasis : 0;
        if (emphasis > 0.55 && prevEmphasis <= 0.55 && now - lastEmphasisPulse > 350) {
          browPulse = 1;
          lastEmphasisPulse = now;
        }
        prevEmphasis = emphasis;
        browPulse = Math.max(0, browPulse - dt * 3.2);
        const browBase = st.preparing ? 0.28 : 0.10;
        const browTarget = browBase + browPulse * 0.45 + (st.listening ? 0.12 : 0);
        if (can.browIn) setMorph("browInnerUp", browTarget);
        if (can.browOutL) setMorph("browOuterUpLeft", browTarget * 0.7);
        if (can.browOutR) setMorph("browOuterUpRight", browTarget * 0.7);

        // 5) Friendly professional rest pose.
        if (can.smileL) setMorph("mouthSmileLeft", st.speaking ? 0.06 : 0.14);
        if (can.smileR) setMorph("mouthSmileRight", st.speaking ? 0.06 : 0.14);

        // 6) Head: irrational-frequency mix (never visibly loops) + a nod
        //    envelope while listening + a slight follow of one's own speech.
        const head = rig.bones.Head;
        const neck = rig.bones.Neck;
        const drift = Math.sin(t * 0.71 + 1.3) * 0.35 + Math.sin(t * 1.93 + 0.4) * 0.18;
        const sway = Math.sin(t * 0.53) * 0.5 + Math.sin(t * 1.37 + 2.1) * 0.22;
        const nodTarget = st.listening ? 0.6 : st.speaking ? 0.25 : 0;
        headNod += (nodTarget - headNod) * Math.min(1, dt * 2.5);
        const nod = Math.sin(t * 2.1) * 0.018 * headNod;
        const speakTilt = st.speaking ? s.emphasis * 0.02 : 0;
        if (head) {
          const base = rig.baseRotations.get(head)!;
          head.rotation.x = base.x + drift * 0.03 + nod + speakTilt;
          head.rotation.y = base.y + sway * 0.045 + gaze.x * 0.05;
          head.rotation.z = base.z + sway * 0.012;
        }
        if (neck) {
          const base = rig.baseRotations.get(neck)!;
          neck.rotation.x = base.x + drift * 0.012;
          neck.rotation.y = base.y + sway * 0.018;
        }

        // 7) Breath: chest bone scale at resting respiratory rate.
        if (can.breath) {
          const breath = 1 + Math.sin(t * (2 * Math.PI * 0.22)) * 0.006;
          for (const name of ["Spine2", "Spine1"] as const) {
            const b = rig.bones[name];
            if (b) b.scale.set(1, breath, breath);
          }
        }

        // 8) Render (paused when offscreen — see IntersectionObserver below).
        if (visible) rig.renderer.render(rig.scene, rig.camera);
      };

      // --- resize / visibility ----------------------------------------------
      const resize = () => {
        const parent = canvas.parentElement;
        if (!parent) return;
        const w = parent.clientWidth || 160;
        const h = parent.clientHeight || 160;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      resize();
      const ro = new ResizeObserver(resize);
      if (canvas.parentElement) ro.observe(canvas.parentElement);
      let visible = true;
      const io = new IntersectionObserver((entries) => { visible = entries[0]?.isIntersecting ?? true; }, { threshold: 0.05 });
      io.observe(canvas);

      raf = requestAnimationFrame(frame);
      cleanup = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        io.disconnect();
        scene.traverse((obj) => {
          const m = obj as import("three").Mesh;
          if (m.isMesh) {
            m.geometry?.dispose();
            const mats = Array.isArray(m.material) ? m.material : [m.material];
            for (const mat of mats) mat?.dispose();
          }
        });
        renderer.dispose();
      };
    })().catch(() => { if (!disposed) setFailed(true); });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [props.gender]);

  if (failed) {
    return <ExaminerAvatar speaking={props.speaking} listening={props.listening} preparing={props.preparing} name={props.name} />;
  }
  return (
    <div className={`relative select-none ${props.className ?? "h-40 w-40 sm:h-48 sm:w-48"}`} aria-label={`${props.name}, your examiner`} role="img">
      <canvas ref={canvasRef} className="h-full w-full" aria-hidden />
      <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-zinc-500 ring-1 ring-zinc-200">
        {props.speaking ? "Speaking" : props.listening ? "Listening" : props.preparing ? "Waiting" : "Ready"}
      </span>
    </div>
  );
}
