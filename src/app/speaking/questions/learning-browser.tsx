"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Card, Badge } from "@/components/ui";
import type { VoiceProfile } from "@/lib/speaking/voice-profile";
import type { Coverage } from "@/lib/content/store";
import type { IdeaStage, KeyPhrase, LearningQuestion, QuestionLearningContent, VocabGroup } from "@/lib/content/types";
import { playStoredAudio, speakStudyText, stopPlayback } from "@/lib/content/playback";

export interface LibraryItem extends LearningQuestion {
  cuePoints: string[];
  /** Counts only — the full material is fetched when a row is opened. */
  summary: { hasAnswer: boolean; ideas: number; phrases: number; vocab: number };
  follow: { playable: boolean; url?: string; reason?: string };
}

/** 考试人数 — shown only when the source document prints a figure. */
function Examinees({ value }: { value: number | null | undefined }) {
  if (typeof value !== "number") return null;
  return (
    <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] tabular-nums text-zinc-500" title="腾讯文档统计的考试人数（考频参考，不是评分依据）">
      {value.toLocaleString("zh-CN")} 人考过
    </span>
  );
}

function VocabGroupCard({ g }: { g: VocabGroup }) {
  return (
    <div className="rounded-xl border border-zinc-100 bg-white p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">{g.title}</div>
      {!!g.items.length && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1.5">
          {g.items.map((it, i) => (
            <span key={i} className="text-xs text-zinc-700">
              <span className="font-medium">{it.en}</span>
              {it.zh && <span className="ml-1 text-zinc-400">{it.zh}</span>}
            </span>
          ))}
        </div>
      )}
      {g.note && <p className="mt-2 whitespace-pre-wrap text-xs leading-6 text-zinc-500">{g.note}</p>}
    </div>
  );
}

const STAGE_LABEL: Record<IdeaStage, string> = {
  "main-idea": "Main idea",
  reason: "Reason",
  example: "Example",
  result: "Result",
  contrast: "Contrast",
};

const PART_LABEL: Record<number, string> = { 1: "Part 1", 2: "Part 2", 3: "Part 3" };

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
      className="shrink-0 rounded-md border border-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-50"
    >
      {done ? "已复制" : label}
    </button>
  );
}

function KeyPhraseCard({ k }: { k: KeyPhrase }) {
  return (
    <div className="rounded-xl border border-zinc-100 bg-zinc-50/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-zinc-900">{k.phrase}</span>
        <CopyButton text={k.phrase} label="复制" />
      </div>
      {k.zh && <div className="mt-1 text-xs text-zinc-500">{k.zh}</div>}
      {k.example && <div className="mt-2 text-xs italic text-zinc-600">“{k.example}”</div>}
      {k.usage && <div className="mt-1.5 text-[11px] leading-5 text-zinc-400">用法：{k.usage}</div>}
    </div>
  );
}

export function LearningBrowser({
  items,
  coverage,
  season,
  region,
  profile,
  serverTts,
}: {
  items: LibraryItem[];
  coverage: Coverage;
  season: string | null;
  region: string | null;
  profile: VoiceProfile;
  serverTts: boolean;
}) {
  const [part, setPart] = useState<"all" | 1 | 2 | 3>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [limit, setLimit] = useState(40);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<"server" | "browser" | null>(null);
  /** Chinese reference is on by default; the toggle is for people who want English only. */
  const [showZh, setShowZh] = useState(true);
  /** Full study material, fetched per topic the first time a row is opened. */
  const [loaded, setLoaded] = useState<Record<number, QuestionLearningContent>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  async function ensureContent(it: LibraryItem) {
    if (loaded[it.id]) return;
    const key = `${it.topicKey}:${it.part}`;
    if (loading[key]) return;
    setLoading((m) => ({ ...m, [key]: true }));
    try {
      const res = await fetch(`/api/learning/questions?topicKey=${encodeURIComponent(it.topicKey)}&part=${it.part}`);
      if (!res.ok) throw new Error("无法加载学习素材");
      const j = (await res.json()) as { questions: Array<{ id: number; learning: QuestionLearningContent }> };
      setLoaded((m) => {
        const next = { ...m };
        for (const q of j.questions) next[q.id] = q.learning;
        return next;
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading((m) => ({ ...m, [key]: false }));
    }
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (part !== "all" && it.part !== part) return false;
      if (!q) return true;
      return [it.text, it.textZh, it.topic, it.topicZh].some((s) => (s || "").toLowerCase().includes(q));
    });
  }, [items, part, query]);

  const shown = visible.slice(0, limit);
  const topics = useMemo(() => {
    const map = new Map<string, { key: string; name: string; nameZh: string | null; items: LibraryItem[] }>();
    for (const it of shown) {
      const t = map.get(it.topicKey) ?? { key: it.topicKey, name: it.topic, nameZh: it.topicZh, items: [] };
      t.items.push(it);
      map.set(it.topicKey, t);
    }
    return [...map.values()];
  }, [shown]);

  async function play(key: string, run: () => Promise<{ engine?: "server" | "browser" } | void>) {
    setError(null);
    if (playingKey === key) {
      stopPlayback();
      setPlayingKey(null);
      return;
    }
    setPlayingKey(key);
    try {
      const r = await run();
      if (r && "engine" in r && r.engine) setEngine(r.engine);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPlayingKey(null);
    }
  }

  return (
    <div className="space-y-5">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          {(["all", 1, 2, 3] as const).map((p) => (
            <button
              key={String(p)}
              onClick={() => { setPart(p); setLimit(40); }}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ${part === p ? "bg-zinc-900 text-white" : "border border-zinc-200 text-zinc-600 hover:bg-zinc-50"}`}
            >
              {p === "all" ? "全部" : PART_LABEL[p]}
            </button>
          ))}
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setLimit(40); }}
            placeholder="搜索主题或题目关键词"
            className="ml-auto w-full max-w-xs rounded-lg border border-zinc-200 px-3 py-1.5 text-xs"
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-400">
          <span>{season ? `${season} · ${region ?? ""}` : "尚未导入题库"}</span>
          <span>{visible.length} / {items.length} 题</span>
          <span>示范答案覆盖 {coverage.withSampleAnswer} 题（{coverage.sampleAnswerPercent}%）</span>
          <span>已人工审核 {coverage.reviewed} 题</span>
          <button
            type="button"
            onClick={() => setShowZh((v) => !v)}
            className={`rounded-md border px-2 py-0.5 ${showZh ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 text-zinc-500"}`}
          >
            {showZh ? "中文对照：开" : "中文对照：关"}
          </button>
          {!serverTts && <span className="text-amber-600">当前无服务端语音引擎，试听将使用浏览器语音</span>}
          {engine === "browser" && <span className="text-amber-600">本次试听使用浏览器语音</span>}
        </div>
        <p className="mt-2 text-[11px] leading-5 text-zinc-400">
          示范答案与学习素材仅供练习，不是考试内容，也不是官方 Band 8/9 范文；考试只朗读题目本身。
        </p>
      </Card>

      {error && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {topics.map((t) => (
        <Card key={t.key} className="p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{t.name}</span>
            {t.nameZh && <span className="text-xs text-zinc-400">{t.nameZh}</span>}
            <Badge>{t.items.length} 题</Badge>
          </div>
          <ul className="divide-y divide-zinc-50">
            {t.items.map((it) => {
              const open = openId === it.id;
              const learning = loaded[it.id] ?? it.learning;
              const sa = learning.sampleAnswer;
              const ideas = learning.ideaNotes ?? [];
              const phrases = learning.keyPhrases ?? [];
              const vocabGroups = learning.vocabGroups ?? [];
              const alignedZh = !!sa?.paragraphsZh && sa.paragraphsZh.length === sa.paragraphs.length;
              const pending = !loaded[it.id] && (loading[`${it.topicKey}:${it.part}`] || it.summary.hasAnswer);
              return (
                <li key={it.id} className="py-2">
                  <button
                    onClick={() => {
                      setOpenId(open ? null : it.id);
                      stopPlayback();
                      if (!open) void ensureContent(it);
                    }}
                    className="flex w-full items-start gap-3 text-left"
                  >
                    <span className="mt-0.5 shrink-0"><Badge tone={it.part === 2 ? "indigo" : "zinc"}>{PART_LABEL[it.part]}</Badge></span>
                    <span className="flex-1">
                      <span className="text-sm text-zinc-800">{it.text}</span>
                      {it.textZh && <span className="mt-0.5 block text-xs text-zinc-400">{it.textZh}</span>}
                    </span>
                    <Examinees value={it.examinees} />
                    <span className="shrink-0 text-xs text-zinc-400">
                      {it.summary.hasAnswer ? (sa?.reviewStatus === "reviewed" ? "已审核" : "草稿") : "仅题目"}
                      <span className="ml-2">{open ? "收起" : "展开"}</span>
                    </span>
                  </button>

                  {open && (
                    <div className="mt-3 space-y-4 rounded-xl bg-zinc-50/70 p-4">
                      {!!it.cuePoints.length && (
                        <div>
                          <div className="text-xs font-medium text-zinc-500">You should say</div>
                          <ul className="mt-1 list-disc pl-5 text-sm text-zinc-700">
                            {it.cuePoints.map((c, i) => <li key={i}>{c}</li>)}
                          </ul>
                        </div>
                      )}

                      {pending && !sa ? (
                        <p className="text-xs text-zinc-400">正在加载学习素材…</p>
                      ) : sa ? (
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-medium text-zinc-500">Sample answer</span>
                            <Badge tone={sa.reviewStatus === "reviewed" ? "green" : "amber"}>
                              {sa.reviewStatus === "reviewed" ? "已人工审核" : "未审核草稿"}
                            </Badge>
                            <span className="text-[11px] text-zinc-400">{sa.source.label}</span>
                            {sa.source.url && <a href={sa.source.url} target="_blank" rel="noreferrer" className="text-[11px] text-indigo-600 underline">来源</a>}
                          </div>
                          {sa.variantLabel && (
                            <div className="mt-1 text-[11px] text-zinc-400">{sa.variantLabel}</div>
                          )}
                          <div className="mt-2 space-y-2">
                            {sa.paragraphs.map((p, i) => {
                              const key = `${it.id}:p${i}`;
                              return (
                                <div key={i} className="flex items-start gap-2 rounded-lg bg-white p-2.5">
                                  <button
                                    onClick={() => void play(key, () => speakStudyText(p, profile, serverTts))}
                                    className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border border-zinc-200 text-[11px] text-zinc-600 hover:bg-zinc-50"
                                    aria-label="播放这一段"
                                  >
                                    {playingKey === key ? "■" : "▶"}
                                  </button>
                                  <p className="flex-1 text-sm leading-6 text-zinc-700">
                                    {p}
                                    {showZh && alignedZh && sa.paragraphsZh?.[i] && (
                                      <span className="mt-1 block text-xs leading-5 text-zinc-400">{sa.paragraphsZh[i]}</span>
                                    )}
                                  </p>
                                  <CopyButton text={p} label="复制" />
                                </div>
                              );
                            })}
                          </div>
                          {showZh && !alignedZh && !!sa.paragraphsZh?.length && (
                            <div className="mt-2 rounded-lg bg-white p-3 text-xs leading-6 text-zinc-500">
                              <div className="mb-1 text-[11px] text-zinc-400">中文翻译</div>
                              {sa.paragraphsZh.join(" ")}
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="text-xs text-zinc-400">这道题还没有示范答案。</p>
                      )}

                      {!!ideas.length && (
                        <div>
                          <div className="text-xs font-medium text-zinc-500">思路速记</div>
                          <ol className="mt-2 space-y-2">
                            {ideas.map((n, i) => (
                              <li key={i} className="rounded-lg bg-white p-2.5">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-[11px] font-medium text-zinc-400">{i + 1}</span>
                                  <span className="text-xs font-medium text-zinc-700">{n.label || STAGE_LABEL[n.stage] || n.stage}</span>
                                </div>
                                {!!n.phrases?.length ? (
                                  <div className="mt-1.5 flex flex-wrap gap-1">
                                    {n.phrases.map((ph, k) => (
                                      <span key={k} className="rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] text-indigo-700">{ph}</span>
                                    ))}
                                  </div>
                                ) : (
                                  n.text && <div className="mt-1 text-sm text-zinc-700">{n.text}</div>
                                )}
                                {showZh && n.textZh && <div className="mt-1 text-xs leading-5 text-zinc-500">{n.textZh}</div>}
                                {n.note && <div className="mt-1 text-[11px] leading-5 text-zinc-400">{n.note}</div>}
                              </li>
                            ))}
                          </ol>
                        </div>
                      )}

                      {!!phrases.length && (
                        <div>
                          <div className="text-xs font-medium text-zinc-500">关键词组</div>
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            {phrases.map((k, i) => <KeyPhraseCard key={i} k={k} />)}
                          </div>
                        </div>
                      )}

                      {!!vocabGroups.length && (
                        <div>
                          <div className="text-xs font-medium text-zinc-500">语料扩展</div>
                          <div className="mt-2 space-y-2">
                            {vocabGroups.map((g, i) => <VocabGroupCard key={i} g={g} />)}
                          </div>
                        </div>
                      )}

                      <div className="rounded-xl border border-zinc-100 bg-white p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-medium text-zinc-500">跟读音频（学习素材，非考官音频）</span>
                          {it.follow.playable ? <Badge tone="green">已有录音</Badge> : <Badge tone="zinc">暂无录音</Badge>}
                        </div>
                        {it.follow.playable && it.follow.url ? (
                          <div className="mt-2 flex items-center gap-2">
                            <button
                              onClick={() => void play(`${it.id}:follow`, () => playStoredAudio(it.follow.url!))}
                              className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs hover:bg-zinc-50"
                            >
                              {playingKey === `${it.id}:follow` ? "停止" : "播放示范录音"}
                            </button>
                            <span className="break-all text-[11px] text-zinc-400">{it.follow.url}</span>
                          </div>
                        ) : (
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className="text-[11px] text-zinc-400">
                              {it.follow.reason ?? "这份题库没有授权录音"}，可用语音合成试听。
                            </span>
                            {sa && (
                              <button
                                onClick={() => void play(`${it.id}:tts`, () => speakStudyText(sa.paragraphs[0], profile, serverTts))}
                                className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs hover:bg-zinc-50"
                              >
                                {playingKey === `${it.id}:tts` ? "停止" : "TTS 试听首段"}
                              </button>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/speaking/practice?topicKey=${encodeURIComponent(it.topicKey)}&part=${it.part}&q=${it.id}`}
                          className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700"
                        >
                          进入 Shadowing 跟读
                        </Link>
                        <span className="text-[11px] text-zinc-400">录音只保存在当前页面，不会进入考试成绩。</span>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      ))}

      {!topics.length && <p className="rounded-xl bg-white p-6 text-center text-sm text-zinc-400">没有匹配的题目。</p>}

      {visible.length > shown.length && (
        <button onClick={() => setLimit((n) => n + 40)} className="w-full rounded-xl border border-zinc-200 bg-white py-2.5 text-sm text-zinc-600 hover:bg-zinc-50">
          显示更多（还有 {visible.length - shown.length} 题）
        </button>
      )}
    </div>
  );
}
