"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { RecordingSession } from "@/lib/audio/recording-session";
import type { VoiceProfile } from "@/lib/speaking/voice-profile";
import type { LearningQuestion } from "@/lib/content/types";
import type { TopicOption } from "@/lib/server/queries";
import { diffWords, practiceHints, speechStats } from "@/lib/content/diff";
import {
  INITIAL_SHADOWING, canTranscribe, reduceShadowing, type ShadowingState,
} from "@/lib/content/shadowing";
import { playStoredAudio, speakStudyText, stopPlayback } from "@/lib/content/playback";

interface PracticeQuestion extends LearningQuestion {
  cuePoints: string[];
  followAudio: { playable: boolean; url?: string; reason?: string };
}

const PART_LABEL: Record<number, string> = { 1: "Part 1", 2: "Part 2", 3: "Part 3" };

/** Split prose into single sentences — one sentence is the unit of practice. */
function sentencesOf(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function fmt(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function ShadowingStudio({
  topics,
  season,
  profile,
  serverTts,
  initial,
}: {
  topics: TopicOption[];
  season: string | null;
  profile: VoiceProfile;
  serverTts: boolean;
  initial: { topicKey?: string; part?: number; questionId?: number };
}) {
  const [topicKey, setTopicKey] = useState(initial.topicKey || topics[0]?.topicKey || "");
  const [part, setPart] = useState<number>(initial.part || 0);
  const [questions, setQuestions] = useState<PracticeQuestion[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(initial.questionId ?? null);
  const [asrAvailable, setAsrAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<ShadowingState>(INITIAL_SHADOWING);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [sentence, setSentence] = useState(-1); // -1 = 整段
  const [engine, setEngine] = useState<"server" | "browser" | null>(null);
  const [done, setDone] = useState(false);

  const sessionRef = useRef<RecordingSession | null>(null);
  const wavRef = useRef<Blob | null>(null);
  const takeUrlRef = useRef<string | null>(null);
  const startedAtRef = useRef(0);

  // Load the questions of the selected topic (and part filter).
  useEffect(() => {
    if (!topicKey) return;
    let cancelled = false;
    const t = setTimeout(() => {
      setLoading(true);
      void (async () => {
        try {
          const qs = new URLSearchParams({ topicKey });
          if (part) qs.set("part", String(part));
          const res = await fetch(`/api/learning/questions?${qs.toString()}`, { cache: "no-store" });
          const json = await res.json();
          if (cancelled) return;
          const list = (json.questions ?? []) as PracticeQuestion[];
          setQuestions(list);
          setAsrAvailable(!!json.asr?.available);
          setSelectedId((cur) => (cur && list.some((q) => q.id === cur) ? cur : list[0]?.id ?? null));
          setState(INITIAL_SHADOWING);
          setSentence(-1);
        } catch (e) {
          if (!cancelled) setError((e as Error).message);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [topicKey, part]);

  // Release the microphone / audio context when leaving the page.
  useEffect(() => {
    return () => {
      sessionRef.current?.dispose();
      sessionRef.current = null;
      stopPlayback();
      if (takeUrlRef.current) URL.revokeObjectURL(takeUrlRef.current);
    };
  }, []);

  // Recording clock.
  useEffect(() => {
    if (state.takeStatus !== "recording") return;
    const id = setInterval(() => setElapsed(Date.now() - startedAtRef.current), 200);
    return () => clearInterval(id);
  }, [state.takeStatus]);

  const current = questions.find((q) => q.id === selectedId) ?? null;
  const sample = current?.learning.sampleAnswer ?? null;
  const fullText = sample?.paragraphs.join(" ") ?? "";
  const sentences = useMemo(() => sentencesOf(fullText), [fullText]);
  const reference = sentence >= 0 ? sentences[sentence] ?? fullText : fullText;

  useEffect(() => {
    if (current) setDone(localStorage.getItem(`shadowing:done:${current.id}`) === "1");
  }, [current]);

  const diff = state.transcript.status === "ok" && reference
    ? diffWords(reference, state.transcript.text ?? "")
    : null;
  const stats = state.transcript.status === "ok"
    ? speechStats(state.transcript.text ?? "", state.take?.durationMs ?? 0)
    : null;

  async function play(key: string, fn: () => Promise<{ engine?: "server" | "browser" } | void>) {
    setError(null);
    if (playingKey === key) { stopPlayback(); setPlayingKey(null); return; }
    setPlayingKey(key);
    try {
      const r = await fn();
      if (r && "engine" in r && r.engine) setEngine(r.engine);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPlayingKey(null);
    }
  }

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      stopPlayback();
      if (!sessionRef.current) {
        sessionRef.current = new RecordingSession({
          onLevel: (l) => setLevel(l),
          onError: (e) => setError(e.message),
        });
      }
      await sessionRef.current.acquire();
      sessionRef.current.startAnswer();
      startedAtRef.current = Date.now();
      setElapsed(0);
      setState((s) => reduceShadowing(s, { type: "start-recording" }));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const stopRecording = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    try {
      const rec = await session.stopAnswer();
      const blob = rec.blob ?? rec.wav;
      if (!blob) { setError("没有捕获到音频，请检查麦克风后重试。"); return; }
      if (takeUrlRef.current) URL.revokeObjectURL(takeUrlRef.current);
      takeUrlRef.current = URL.createObjectURL(blob);
      wavRef.current = rec.wav ?? null;
      setState((s) => reduceShadowing(s, {
        type: "take-ready",
        take: {
          id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now()),
          durationMs: rec.durationMs,
          mimeType: rec.mimeType || blob.type,
          objectUrl: takeUrlRef.current!,
          hasWav: !!rec.wav,
        },
      }));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const transcribe = useCallback(async () => {
    const wav = wavRef.current;
    if (!wav) { setError("这段录音没有可用的 WAV 数据，无法转写（浏览器不支持时只能回放）。"); return; }
    setError(null);
    setState((s) => reduceShadowing(s, { type: "transcribe" }));
    const form = new FormData();
    form.append("audio", wav, "take.wav");
    if (reference) form.append("hint", reference.slice(0, 600));
    try {
      const res = await fetch("/api/learning/asr", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) {
        setState((s) => reduceShadowing(s, { type: "asr-failed", error: json.error || `ASR ${res.status}` }));
        return;
      }
      if (json.status === "ok") setState((s) => reduceShadowing(s, { type: "transcribed", text: json.text, provider: json.provider }));
      else if (json.status === "unavailable") setState((s) => reduceShadowing(s, { type: "asr-unavailable", reason: json.reason }));
      else setState((s) => reduceShadowing(s, { type: "asr-failed", error: json.error || "转写失败" }));
    } catch (e) {
      setState((s) => reduceShadowing(s, { type: "asr-failed", error: (e as Error).message }));
    }
  }, [reference]);

  function markDone() {
    setState((s) => reduceShadowing(s, { type: "complete" }));
    if (current) localStorage.setItem(`shadowing:done:${current.id}`, "1");
    setDone(true);
  }

  const recording = state.takeStatus === "recording";
  const activeTopic = topics.find((t) => t.topicKey === topicKey);

  return (
    <div className="space-y-5">
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-zinc-500">
            主题
            <select
              value={topicKey}
              onChange={(e) => { setTopicKey(e.target.value); setPart(0); }}
              className="mt-1 block w-full min-w-[220px] rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-800"
            >
              {topics.map((t) => (
                <option key={t.topicKey} value={t.topicKey}>
                  {t.topic}{t.topicZh ? ` · ${t.topicZh}` : ""}（{t.counts.part1 + t.counts.part2 + t.counts.part3}）
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-1">
            {[0, 1, 2, 3].map((p) => (
              <button
                key={p}
                onClick={() => setPart(p)}
                className={`rounded-lg px-2.5 py-1.5 text-xs ${part === p ? "bg-zinc-900 text-white" : "border border-zinc-200 text-zinc-600"}`}
              >
                {p === 0 ? "全部" : PART_LABEL[p]}
              </button>
            ))}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
            <span>{season ?? "无题库"}</span>
            {activeTopic && <span>示范答案 {activeTopic.withSampleAnswer} 题</span>}
            {asrAvailable === false && <span className="text-amber-600">无服务端 ASR：可录音回放，不能转写</span>}
            {asrAvailable && <span className="text-emerald-600">ASR 可用</span>}
          </div>
        </div>
      </Card>

      {error && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-[300px,1fr]">
        <Card className="p-3">
          <div className="mb-2 text-xs font-medium text-zinc-500">选一道题（{questions.length}）</div>
          {loading && <p className="p-2 text-xs text-zinc-400">加载中…</p>}
          <ul className="max-h-[520px] space-y-1 overflow-y-auto">
            {questions.map((q) => (
              <li key={q.id}>
                <button
                  onClick={() => { setSelectedId(q.id); setState(INITIAL_SHADOWING); setSentence(-1); setError(null); }}
                  className={`w-full rounded-lg px-2.5 py-2 text-left text-xs ${selectedId === q.id ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-50"}`}
                >
                  <span className="mr-1 opacity-60">{PART_LABEL[q.part]}</span>
                  {q.text}
                  {q.learning.sampleAnswer && <span className="ml-1 opacity-60">· 示范</span>}
                </button>
              </li>
            ))}
            {!questions.length && !loading && <li className="p-2 text-xs text-zinc-400">这个主题下没有题目。</li>}
          </ul>
        </Card>

        <div className="space-y-4">
          {!current ? (
            <Card className="p-6 text-sm text-zinc-400">选择左侧任意一道题开始练习。</Card>
          ) : (
            <>
              <Card className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <Badge tone={current.part === 2 ? "indigo" : "zinc"}>{PART_LABEL[current.part]}</Badge>
                      <span className="text-xs text-zinc-400">{current.topic}</span>
                      {done && <Badge tone="green">已标记完成</Badge>}
                    </div>
                    <h2 className="mt-2 text-lg font-semibold leading-7">{current.text}</h2>
                    {!!current.cuePoints.length && (
                      <ul className="mt-2 list-disc pl-5 text-xs text-zinc-500">
                        {current.cuePoints.map((c, i) => <li key={i}>{c}</li>)}
                      </ul>
                    )}
                  </div>
                  <Link href={`/speaking/questions`} className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs">返回题库</Link>
                </div>

                {sample ? (
                  <div className="mt-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium text-zinc-500">示范答案</span>
                      <Badge tone={sample.reviewStatus === "reviewed" ? "green" : "amber"}>
                        {sample.reviewStatus === "reviewed" ? "已人工审核" : "未审核草稿"}
                      </Badge>
                      <span className="text-[11px] text-zinc-400">{sample.source.label}</span>
                    </div>
                    <div className="mt-2 space-y-1">
                      {sentences.map((s, i) => (
                        <button
                          key={i}
                          onClick={() => { setSentence(sentence === i ? -1 : i); setState(INITIAL_SHADOWING); }}
                          className={`block w-full rounded-lg px-2 py-1 text-left text-sm leading-6 ${sentence === i ? "bg-indigo-50 text-indigo-900" : "text-zinc-700 hover:bg-zinc-50"}`}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
                      <span>{sentence >= 0 ? `逐句模式：第 ${sentence + 1} 句` : "整段模式"}</span>
                      {sentence >= 0 && <button onClick={() => setSentence(-1)} className="underline">切回整段</button>}
                    </div>
                  </div>
                ) : (
                  <p className="mt-4 rounded-xl bg-zinc-50 p-3 text-xs text-zinc-500">
                    这道题没有示范答案，可以先自己说一遍，再用转写结果复盘表达与流畅度；没有参考文本时不做差异对比。
                  </p>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => void play("follow", () => (current.followAudio.playable && current.followAudio.url
                      ? playStoredAudio(current.followAudio.url)
                      : speakStudyText(reference || current.text, profile, serverTts)))}
                    className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs hover:bg-zinc-50"
                  >
                    {playingKey === "follow" ? "停止原音" : "播放原音"}
                  </button>
                  <button
                    disabled={!state.take}
                    onClick={() => void play("take", () => playStoredAudio(state.take!.objectUrl))}
                    className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-40"
                  >
                    {playingKey === "take" ? "停止回放" : "播放我的录音"}
                  </button>
                  {!recording ? (
                    <button onClick={() => void startRecording()} className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700">
                      {state.take ? "重新录制" : "开始录音"}
                    </button>
                  ) : (
                    <button onClick={() => void stopRecording()} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500">
                      停止录音 {fmt(elapsed)}
                    </button>
                  )}
                  <button
                    disabled={!canTranscribe(state, asrAvailable === true)}
                    onClick={() => void transcribe()}
                    className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-40"
                  >
                    {state.transcript.status === "pending" ? "转写中…" : "转写对比"}
                  </button>
                  <button
                    disabled={!state.take || done}
                    onClick={markDone}
                    className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs hover:bg-zinc-50 disabled:opacity-40"
                  >
                    {done ? "已完成" : "标记完成"}
                  </button>
                  {engine === "browser" && <span className="text-[11px] text-amber-600">原音使用浏览器语音</span>}
                  <span className="text-[11px] text-zinc-400">
                    {current.followAudio.playable ? "原音=题库录音" : "原音=语音合成（无授权录音）"}
                  </span>
                </div>

                {/* Level meter: the same envelope idea as the exam recorder, but local. */}
                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
                  <div
                    className={`h-full rounded-full transition-[width] duration-100 ${recording ? "bg-emerald-500" : "bg-zinc-300"}`}
                    style={{ width: `${Math.round((recording ? level : 0) * 100)}%` }}
                  />
                </div>
                <p className="mt-1 text-[11px] text-zinc-400">
                  录音只存在当前页面，不上传、不写入考试成绩；离开页面即释放麦克风。
                </p>
              </Card>

              {(state.transcript.status !== "idle" || state.take) && (
                <Card className="p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold">转写与对比</h3>
                    {state.take && <Badge>{fmt(state.take.durationMs)}</Badge>}
                    {state.transcript.status === "ok" && <Badge tone="green">{state.transcript.provider ?? "ASR"}</Badge>}
                    {state.transcript.status === "unavailable" && <Badge tone="amber">无法转写</Badge>}
                    {state.transcript.status === "failed" && <Badge tone="red">转写失败</Badge>}
                  </div>

                  {state.transcript.status === "unavailable" && (
                    <p className="mt-2 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-800">{state.transcript.reason}</p>
                  )}
                  {state.transcript.status === "failed" && (
                    <p className="mt-2 rounded-lg bg-red-50 p-3 text-xs leading-5 text-red-700">{state.transcript.reason}</p>
                  )}
                  {state.transcript.status === "pending" && <p className="mt-2 text-xs text-zinc-400">正在识别录音…</p>}

                  {state.transcript.status === "ok" && diff && stats && (
                    <>
                      <div className="mt-3 grid gap-2 sm:grid-cols-3">
                        <div className="rounded-xl border border-zinc-100 p-3">
                          <div className="text-[11px] text-zinc-400">时长</div>
                          <div className="text-lg font-semibold tabular-nums">{fmt(stats.durationMs)}</div>
                        </div>
                        <div className="rounded-xl border border-zinc-100 p-3">
                          <div className="text-[11px] text-zinc-400">语速</div>
                          <div className="text-lg font-semibold tabular-nums">{stats.wpm} <span className="text-xs font-normal text-zinc-400">wpm</span></div>
                        </div>
                        <div className="rounded-xl border border-zinc-100 p-3">
                          <div className="text-[11px] text-zinc-400">参考词覆盖</div>
                          <div className="text-lg font-semibold tabular-nums">{Math.round(diff.matchRate * 100)}%</div>
                        </div>
                      </div>

                      <div className="mt-3 rounded-xl bg-zinc-50 p-3 text-sm leading-7">
                        {diff.tokens.map((t, i) => {
                          if (t.kind === "match") return <span key={i} className="text-zinc-800">{t.ref} </span>;
                          if (t.kind === "missing") return <span key={i} className="rounded bg-amber-100 px-1 text-amber-800 line-through">{t.ref} </span>;
                          if (t.kind === "extra") return <span key={i} className="rounded bg-rose-100 px-1 text-rose-800">{t.got} </span>;
                          return (
                            <span key={i} className="rounded bg-indigo-100 px-1 text-indigo-800">
                              {t.got}
                              <span className="ml-1 text-[10px] text-indigo-500">(原：{t.ref})</span>{" "}
                            </span>
                          );
                        })}
                      </div>

                      <p className="mt-2 text-[11px] leading-5 text-zinc-400">
                        高亮为<b>参考信息</b>：橙色是转写中没有出现的参考词，红色是转写里多出来的词，紫色是表达不同。
                        识别引擎自身可能听错，因此这些差异不能作为发音错误结论，也不作为 IELTS 评分。
                      </p>

                      <ul className="mt-2 space-y-1 text-xs text-zinc-600">
                        {practiceHints(diff, stats).map((h, i) => <li key={i}>· {h}</li>)}
                      </ul>

                      <details className="mt-3">
                        <summary className="cursor-pointer text-xs text-zinc-500">查看转写全文</summary>
                        <p className="mt-1 rounded-lg bg-white p-2 text-xs leading-6 text-zinc-600">{state.transcript.text}</p>
                      </details>
                    </>
                  )}
                </Card>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
