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
 *  - Observability: optional `onLifecycle` reports idle → loading → ready |
 *    fallback (auto-recovered) | error, and `probe` + `onProbe` measure real
 *    load time, real FPS and the viseme morph-target set while rendering the
 *    REAL pipeline (used by the Settings diagnostics centre).
 */
import { useEffect, useRef, useState } from "react";
import { ExaminerAvatar } from "@/app/speaking/exam/[id]/examiner-avatar";
import { examinerEnvelope } from "@/lib/audio/examiner-envelope";
import { lipSync } from "@/lib/lipsync/controller";
import { visemeIndex, VISEME_CHANNELS } from "@/lib/lipsync/types";
import { DEFAULT_MODEL_BY_GENDER, examinerModelById, normalizeModelId, OCULUS_TO_VISEME, type ExaminerGender } from "@/lib/avatar/models";

/** Lifecycle of the 3D pipeline, observable by parents (diagnostics, exam). */
export type AvatarLifecycleState = "idle" | "loading" | "ready" | "fallback" | "error";

export interface AvatarProbeInfo {
  /** GLB fetch + GLTF parse duration (ms), measured on the real loader. */
  loadMs?: number;
  /** Average FPS over a ~1.5 s sample of the real render loop. */
  fps?: number;
  /** How many of the 15 viseme morph targets the model actually carries. */
  visemesFound?: number;
  visemesRequired?: number;
  /** GPU string reported by the BROWSER (may be masked — not a hardware audit). */
  renderer?: string | null;
  webgl2?: boolean;
  /** Set when the pipeline failed and the 2D avatar took over. */
  error?: string;
}

interface Props {
  gender: ExaminerGender;
  /** Which examiner look ("f1"…"f5"/"m1"…"m5"); falls back to the gender default. */
  modelId?: string;
  speaking: boolean;
  listening: boolean;
  preparing?: boolean;
  name: string;
  className?: string;
  /** Lifecycle notifications (state changes only; safe to re-render on). */
  onLifecycle?: (state: AvatarLifecycleState) => void;
  /** Diagnostics: sample one real render run and report the numbers above. */
  probe?: boolean;
  onProbe?: (info: AvatarProbeInfo) => void;
}

/**
 * Browser-visible GPU capability. Everything here comes from the WebGL context
 * itself — no plugin/native bridge, so the renderer string is what the BROWSER
 * chooses to disclose (often masked to "ANGLE (…)" and never a full hardware
 * inventory: VRAM / real GPU model / machine specs are NOT available).
 */
export function webglSupport(): { supported: boolean; webgl2: boolean; renderer: string | null } {
  if (typeof document === "undefined") return { supported: false, webgl2: false, renderer: null };
  try {
    const c = document.createElement("canvas");
    const gl2 = c.getContext("webgl2") as WebGL2RenderingContext | null;
    const gl = gl2 ?? (c.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) return { supported: false, webgl2: false, renderer: null };
    let renderer: string | null = null;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    if (dbg) {
      try { renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string; } catch { /* masked */ }
    }
    // Free the probe context immediately.
    const lose = gl.getExtension("WEBGL_lose_context");
    lose?.loseContext();
    return { supported: true, webgl2: !!gl2, renderer };
  } catch {
    return { supported: false, webgl2: false, renderer: null };
  }
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
  const refs = useRef({ speaking: props.speaking, listening: props.listening, preparing: !!props.preparing, probe: !!props.probe });
  useEffect(() => {
    refs.current = { speaking: props.speaking, listening: props.listening, preparing: !!props.preparing, probe: !!props.probe };
  }, [props.speaking, props.listening, props.preparing, props.probe]);

  // Cleanup handles for the probe's rAF-throttling fallback timer.
  const probeFallbackStopRef = useRef<(() => void)[]>([]);

  // Callbacks live in refs so a parent's inline handler never restarts the
  // pipeline effect (which would re-download the model).
  const lifecycleCb = useRef(props.onLifecycle);
  const probeCb = useRef(props.onProbe);
  useEffect(() => { lifecycleCb.current = props.onLifecycle; probeCb.current = props.onProbe; }, [props.onLifecycle, props.onProbe]);
  const setLifecycle = (s: AvatarLifecycleState) => lifecycleCb.current?.(s);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;
    const loadStart = performance.now();
    setFailed(false); // a model switch retries the 3D pipeline from scratch
    setLifecycle("loading");

    const failOver = (why: string) => {
      if (disposed) return;
      setFailed(true); // re-renders with the 2D SVG avatar below
      setLifecycle("fallback");
      probeCb.current?.({ error: why });
    };

    (async () => {
      let THREE: typeof import("three");
      let GLTFLoaderCtor: typeof import("three/examples/jsm/loaders/GLTFLoader.js").GLTFLoader;
      try {
        THREE = await import("three");
        ({ GLTFLoader: GLTFLoaderCtor } = await import("three/examples/jsm/loaders/GLTFLoader.js"));
      } catch {
        failOver("three.js failed to load");
        return;
      }
      if (disposed) return;

      // --- renderer / scene -------------------------------------------------
      let renderer: import("three").WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
      } catch (e) {
        failOver(`WebGL context unavailable (${(e as Error).message})`);
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
      const modelId = normalizeModelId(props.modelId ?? DEFAULT_MODEL_BY_GENDER[props.gender], props.gender);
      const model = examinerModelById(modelId) ?? examinerModelById(DEFAULT_MODEL_BY_GENDER[props.gender])!;
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

        // Frame a tight HEAD-AND-NECK portrait. The camera targets the Head
        // BONE's world position (robust across model rigs — bbox proportions
        // break on half-body or differently-proportioned models). The frame is
        // deliberately narrow: arms stay out of view entirely — GLB humanoids
        // arrive in T-pose, and arm pose fixes that work on one skeleton
        // produce broken-looking arms on another (different bone axes).
        const headBone = bones.Head;
        let headPos = new THREE.Vector3(0, 1.62, 0);
        let frameScale = 0.68;
        if (headBone) {
          headBone.updateWorldMatrix(true, false);
          headBone.getWorldPosition(headPos);
        } else {
          const box = new THREE.Box3().setFromObject(root);
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          headPos = new THREE.Vector3(center.x, box.max.y - size.y * 0.05, center.z);
          frameScale = 0.68;
        }
        camera.position.set(headPos.x, headPos.y + 0.02, frameScale);
        camera.lookAt(headPos.x, headPos.y - 0.03, headPos.z);

        rig = { renderer, scene, camera, meshes, bones, baseRotations };
      } catch (e) {
        failOver(`model failed to load (${(e as Error).message})`);
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
      // Human speech is subtle: full blendshape weights read as cartoonish
      // gaping on camera, so every viseme is applied well below 1.
      const applyVisemes = (jawBoost: number) => {
        for (const [vis, oculus] of Object.entries(visemeMorphs)) {
          if (!visemeAvailable[vis]) continue;
          setMorph(oculus, channels[visemeIndex(vis as never)] * 0.45);
        }
        if (can.jaw) {
          const vowelOpen = Math.max(channels[visemeIndex("aa")], channels[visemeIndex("E")], channels[visemeIndex("oh")], channels[visemeIndex("ih")], channels[visemeIndex("ou")]);
          setMorph("jawOpen", Math.min(0.55, vowelOpen * 0.32 + jawBoost * 0.18));
        }
      };

      // --- diagnostics probe -------------------------------------------------
      // Reports the REAL pipeline's numbers: load duration, (probe mode only)
      // FPS over a ~1.5 s window, and the viseme morph-target coverage. Every
      // mount reports its load once — the exam records avatar_model_load_ms
      // from it; only `probe` adds the FPS sampling cost.
      let fpsFrames = 0;
      let fpsStart = 0;
      let probeReported = false;
      const reportProbeInfo = (fps?: number) => {
        if (probeReported || disposed) return;
        probeReported = true;
        const ctx = rig!.renderer.getContext();
        const dbg = ctx.getExtension("WEBGL_debug_renderer_info");
        let rendererName: string | null = null;
        if (dbg) {
          try { rendererName = ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string; } catch { /* masked */ }
        }
        probeCb.current?.({
          loadMs: Math.round(performance.now() - loadStart),
          ...(fps != null ? { fps: Math.round(fps * 10) / 10 } : {}),
          visemesFound: VISEME_CHANNELS.filter((v) => visemeAvailable[v]).length,
          visemesRequired: VISEME_CHANNELS.length,
          renderer: rendererName,
          webgl2: typeof WebGL2RenderingContext !== "undefined" && ctx instanceof WebGL2RenderingContext,
        });
      };
      const maybeReportProbe = () => {
        if (probeReported || disposed) return;
        reportProbeInfo(fpsFrames > 3 ? fpsFrames / ((performance.now() - fpsStart) / 1000) : undefined);
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
        // Offscreen or hidden tab → skip ALL work, not just the render call:
        // morphs, bone math and viseme sampling are pure CPU and nobody sees
        // them. `last` only advances while visible, so resume never jumps
        // (dt is recomputed from the real clock and capped anyway).
        if (document.hidden || !visible) return;
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        const t = (now - start) / 1000;
        const st = refs.current;

        // 1) Lip sync — audio-clock driven; RMS adds organic jitter.
        const rms = Math.max(0, examinerEnvelope());
        const s = lipSync.sample(rms, now);
        channels.set(s.channels);
        const jawBoost = st.speaking ? Math.min(0.18, rms * 0.25) : 0;
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
        if (emphasis > 0.55 && prevEmphasis <= 0.55 && now - lastEmphasisPulse > 500) {
          browPulse = 1;
          lastEmphasisPulse = now;
        }
        prevEmphasis = emphasis;
        browPulse = Math.max(0, browPulse - dt * 3.2);
        const browBase = st.preparing ? 0.18 : 0.06;
        const browTarget = browBase + browPulse * 0.25 + (st.listening ? 0.08 : 0);
        if (can.browIn) setMorph("browInnerUp", browTarget);
        if (can.browOutL) setMorph("browOuterUpLeft", browTarget * 0.7);
        if (can.browOutR) setMorph("browOuterUpRight", browTarget * 0.7);

        // 5) Friendly professional rest pose.
        if (can.smileL) setMorph("mouthSmileLeft", st.speaking ? 0.04 : 0.08);
        if (can.smileR) setMorph("mouthSmileRight", st.speaking ? 0.04 : 0.08);

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

        // 8) Render (paused when offscreen — the early return above skips the
        //    whole frame body, so this always runs when reached).
        rig.renderer.render(rig.scene, rig.camera);

        // 9) FPS sampling for the diagnostics probe (uses the real loop).
        if (refs.current.probe && !probeReported) {
          if (fpsFrames === 0) fpsStart = now;
          fpsFrames++;
          if (now - fpsStart >= 1500) maybeReportProbe();
        }
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

      // WebGL context loss: the GPU driver can reclaim the context (tab
      // backgrounding, driver reset). The exam must keep running — fall back
      // to the 2D avatar instead of rendering a dead canvas.
      const onContextLost = (e: Event) => {
        e.preventDefault();
        failOver("WebGL context was lost (GPU/driver reset)");
      };
      canvas.addEventListener("webglcontextlost", onContextLost);

      raf = requestAnimationFrame(frame);
      setLifecycle("ready"); // real pipeline (loader + renderer + loop) is live
      // Non-probe mounts report the load once too (no FPS sampling cost).
      if (!refs.current.probe) setTimeout(() => reportProbeInfo(undefined), 0);
      // FPS sampling relies on requestAnimationFrame, which browsers suspend
      // entirely for throttled/occluded pages (embedded panes, background
      // tabs). A fallback timer guarantees the probe ALWAYS reports — with
      // fps when rAF ran, without it otherwise.
      const probeFallback = setTimeout(() => maybeReportProbe(), 6000);
      const stopProbeFallback = () => clearTimeout(probeFallback);
      if (refs.current.probe) probeFallbackStopRef.current.push(stopProbeFallback);
      else stopProbeFallback();
      cleanup = () => {
        cancelAnimationFrame(raf);
        for (const stop of probeFallbackStopRef.current.splice(0)) stop();
        ro.disconnect();
        io.disconnect();
        canvas.removeEventListener("webglcontextlost", onContextLost);
        scene.traverse((obj) => {
          const m = obj as import("three").Mesh;
          if (m.isMesh) {
            m.geometry?.dispose();
            const mats = Array.isArray(m.material) ? m.material : [m.material];
            for (const mat of mats) {
              // Materials do NOT own their textures: dispose every map
              // explicitly, or GLB textures stay on the GPU after unmount.
              const anyMat = mat as import("three").Material & { map?: { dispose(): void } | null };
              anyMat?.map?.dispose();
              mat?.dispose();
            }
          }
        });
        renderer.dispose();
        // NOTE: deliberately NO forceContextLoss() here — it permanently kills
        // the canvas' context, which breaks model/gender switches (the SAME
        // canvas element is reused for the next pipeline run and could never
        // create a WebGL context again → instant 2D fallback). dispose()
        // releases all GL resources; the context itself is freed when the
        // canvas element leaves the DOM on unmount.
      };
    })().catch((e) => { failOver(`pipeline error (${(e as Error).message})`); });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [props.gender, props.modelId]);

  if (failed) {
    return <ExaminerAvatar speaking={props.speaking} listening={props.listening} preparing={props.preparing} name={props.name} />;
  }
  return (
    <div className={`relative select-none ${props.className ?? "h-40 w-40 sm:h-48 sm:w-48"}`} aria-label={`${props.name}, your examiner`} role="img">
      <canvas ref={canvasRef} className="h-full w-full" aria-hidden />
    </div>
  );
}