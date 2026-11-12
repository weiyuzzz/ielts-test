"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, Badge, Band, modeLabel, statusTone, fmtDate } from "@/components/ui";
import { AudioPlayer } from "@/components/audio-player";
import { DIMENSION_LABELS, type Dimension } from "@/lib/speaking/bands";
import { CRITERIA, DESCRIPTOR_SOURCE, findDescriptor } from "@/lib/speaking/band-descriptors";
import type { SessionAudioAnalysis } from "@/lib/speaking/audio-analysis";

interface Dim { dimension: Dimension; band: number | null; status: string; source: string; rationale: string; descriptorRefs?: string[]; confidence?: number | null; strengths?: string[] | null; weaknesses?: string[] | null }
interface FindingRow { id: string; dimension: string; answerId: string | null; kind: string; category: string; originalText: string; suggestion: string | null; explanation: string; possibleAsrError: boolean; descriptorRefs?: string[]; evidenceType?: string; startMs?: number | null; endMs?: number | null }

/** Small, reusable rubric citation. Unknown ids are simply not rendered. */
function DescriptorChips({ ids, tone = "zinc" }: { ids?: string[]; tone?: "zinc" | "indigo" }) {
  const valid = (ids ?? []).map((id) => findDescriptor(id)).filter((d): d is NonNullable<typeof d> => !!d);
  if (!valid.length) return null;
  return (
    <ul className="mt-2 space-y-1">
      {valid.map((d) => (
        <li key={d.id} className="text-[11px] leading-4 text-zinc-500">
          <code className={`mr-1 rounded px-1 py-0.5 ${tone === "indigo" ? "bg-indigo-50 text-indigo-700" : "bg-zinc-100 text-zinc-600"}`}>{d.id}</code>
          <span className="text-zinc-400">B{d.band} · {d.focus}</span> {d.text}
        </li>
      ))}
    </ul>
  );
}
interface ReportData {
  assessment: { id: string; status: string; stage: string | null; overallBand: number | null; isComplete: boolean; scorer: string | null; llmProvider: string | null; llmModel: string | null; promptVersion: string | null; rubricVersion: string | null; asrProvider: string | null; pronunciationProvider: string | null; metrics: Record<string, unknown> | null; audioAnalysis: SessionAudioAnalysis | null; limitations: string[] | null; notes: string[] | null; error: string | null; startedAt: string; completedAt: string | null };
  dimensions: Dim[];
  findings: FindingRow[];
  report: { summary: string; nextSteps: string[] } | null;
}
interface SessionData {
  session: { id: string; mode: string; status: string; startedAt: string; completedAt: string | null };
  steps: { id: string; part: number; kind: string; promptText: string; topic: string; generator: string; answer: { id: string; status: string; durationMs: number; audioAssetId: string | null; transcript: { status: string; text: string; provider: string } | null } | null }[];
}

const STAGES: Record<string, string> = { queued: "Queued", transcribing: "Transcribing answers", "audio-analysis": "Analysing audio (VAD, pauses, rates)", pronunciation: "Assessing pronunciation", scoring: "Analysing language", done: "Done" };

function CovBadge({ ok, label }: { ok: boolean; label: string }) {
  return <Badge tone={ok ? "green" : "zinc"}>{ok ? `✓ ${label}` : `– ${label}`}</Badge>;
}

/** Honest rendering: absent features show "–", never fabricated zeros. */
function AudioEvidenceCard({ sa }: { sa: SessionAudioAnalysis }) {
  const f = sa.fluency;
  const p = sa.pauseStats;
  const pr = sa.prosody;
  const s = (v: number | null | undefined, suffix = "", digits = 0) => (typeof v === "number" ? `${v.toFixed(digits)}${suffix}` : "–");
  return (
    <Card className="mt-6 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">声学证据 · Audio evidence</h2>
        <div className="flex flex-wrap gap-1.5">
          <CovBadge ok={sa.coverage.transcriptAvailable} label="transcript" />
          <CovBadge ok={sa.coverage.wordTimingAvailable} label="word timings" />
          <CovBadge ok={sa.coverage.vadAvailable} label="VAD" />
          <CovBadge ok={sa.coverage.prosodyAvailable} label="prosody" />
        </div>
      </div>
      <p className="mt-1 text-xs leading-5 text-zinc-400">由完整录音（16 kHz WAV）、ASR 词级时间戳与能量 VAD 自动提取，作为评分模型的证据输入；声学指标不直接决定任何 Band。标记「–」表示该特征本次不可用，而非 0。</p>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
        <div><dt className="text-zinc-400">总时长 / 录音</dt><dd className="font-medium tabular-nums">{s(sa.durationMs / 1000, "s", 1)}</dd></div>
        <div><dt className="text-zinc-400">有效语音</dt><dd className="font-medium tabular-nums">{s(sa.speechDurationMs !== null ? (sa.speechDurationMs as number) / 1000 : null, "s", 1)}</dd></div>
        <div><dt className="text-zinc-400">静音</dt><dd className="font-medium tabular-nums">{s(sa.silenceDurationMs !== null ? (sa.silenceDurationMs as number) / 1000 : null, "s", 1)}</dd></div>
        <div><dt className="text-zinc-400">语速（含停顿）</dt><dd className="font-medium tabular-nums">{s(sa.speechRateWpm, " wpm")}</dd></div>
        <div><dt className="text-zinc-400">发音速率（去停顿）</dt><dd className="font-medium tabular-nums">{s(sa.articulationRateWpm, " wpm")}</dd></div>
        <div><dt className="text-zinc-400">停顿总数 / 长停顿≥2s</dt><dd className="font-medium tabular-nums">{p.count} / {p.longPauseCount}</dd></div>
        <div><dt className="text-zinc-400">平均 / 中位停顿</dt><dd className="font-medium tabular-nums">{s(p.meanDurationMs / 1000, "s", 1)} / {s(p.medianDurationMs / 1000, "s", 1)}</dd></div>
        <div><dt className="text-zinc-400">短 / 中 / 长停顿</dt><dd className="font-medium tabular-nums">{p.byLength.short} / {p.byLength.medium} / {p.byLength.long}</dd></div>
        <div><dt className="text-zinc-400">平均连续表达（MLR）</dt><dd className="font-medium tabular-nums">{s(f.meanLengthOfRun, " 词", 1)}</dd></div>
        <div><dt className="text-zinc-400">最长连续表达</dt><dd className="font-medium tabular-nums">{s(f.longestRun, " 词")}</dd></div>
        <div><dt className="text-zinc-400">填充词</dt><dd className="font-medium tabular-nums">{f.fillerCount}{f.fillers.length ? ` (${f.fillers.join(", ")})` : ""}</dd></div>
        <div><dt className="text-zinc-400">重复 / 自我修正</dt><dd className="font-medium tabular-nums">{f.repetitionCount} / {f.selfCorrectionCount ?? "–"}</dd></div>
        {pr && (
          <>
            <div><dt className="text-zinc-400">音高变化</dt><dd className="font-medium tabular-nums">{s(pr.pitchVariationHz, " Hz", 0)}</dd></div>
            <div><dt className="text-zinc-400">能量变化</dt><dd className="font-medium tabular-nums">{s(pr.energyVariationDb, " dB", 1)}</dd></div>
          </>
        )}
      </dl>
      {sa.perPart.length > 1 && (
        <table className="mt-4 w-full text-xs">
          <thead><tr className="text-left text-zinc-400"><th className="py-1">Part</th><th>语速</th><th>MLR</th><th>停顿</th><th>长停顿</th><th>填充词</th><th>自我修正</th></tr></thead>
          <tbody className="tabular-nums">
            {sa.perPart.map((r) => (
              <tr key={r.part} className="border-t border-zinc-100">
                <td className="py-1 font-medium">Part {r.part}</td>
                <td>{s(r.speechRateWpm, " wpm")}</td>
                <td>{s(r.meanLengthOfRun, "", 1)}</td>
                <td>{r.pauseCount}</td>
                <td>{r.longPauseCount}</td>
                <td>{r.fillerCount}</td>
                <td>{r.selfCorrectionCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sa.warnings.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 pl-4 text-xs text-amber-800">{sa.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
      )}
    </Card>
  );
}

export function ReportView({ sessionId }: { sessionId: string }) {
  const [rep, setRep] = useState<ReportData | null>(null);
  const [ses, setSes] = useState<SessionData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    const [r1, r2] = await Promise.all([fetch(`/api/speaking/sessions/${sessionId}/report`, { cache: "no-store" }), fetch(`/api/speaking/sessions/${sessionId}`, { cache: "no-store" })]);
    const s = await r2.json();
    if (!r2.ok) throw new Error(s.error || "Not found");
    setSes(s);
    let status: string | null = null;
    if (r1.ok) {
      const r = (await r1.json()) as ReportData;
      setRep(r);
      status = r.assessment.status;
    } else setRep(null);
    // keep polling while scoring runs (or while a completed exam has no assessment row yet)
    return s.session.status === "completed" && !["completed", "partial", "failed", "unscored"].includes(status ?? "");
  }, [sessionId]);

  const [pollKey, setPollKey] = useState(0);
  useEffect(() => {
    let stop = false;
    let t: ReturnType<typeof setTimeout>;
    let n = 0;
    const tick = async () => {
      let again = false;
      try {
        again = await load();
      } catch (e) {
        setErr((e as Error).message);
        return;
      }
      if (!stop && again && n++ < 240) t = setTimeout(tick, 2500);
    };
    tick();
    return () => { stop = true; clearTimeout(t); };
  }, [load, pollKey]);

  async function retry() {
    setRetrying(true);
    await fetch(`/api/speaking/sessions/${sessionId}/report`, { method: "POST" });
    setRetrying(false);
    setPollKey((k) => k + 1);
  }

  if (err) return <Card className="p-8 text-center text-sm text-zinc-500">{err}</Card>;
  if (!ses) return <div className="py-20 text-center text-sm text-zinc-400">Loading report…</div>;
  if (ses.session.status === "abandoned") return <Card className="p-8 text-center"><h1 className="font-semibold">Exam ended early</h1><p className="mt-2 text-sm text-zinc-500">Abandoned exams are not scored.</p><Link href="/speaking" className="mt-4 inline-block text-sm underline">Start a new one</Link></Card>;
  if (ses.session.status === "in_progress") return <Card className="p-8 text-center"><h1 className="font-semibold">Exam still in progress</h1><Link href={`/speaking/exam/${sessionId}`} className="mt-4 inline-block text-sm underline">Resume</Link></Card>;

  const a = rep?.assessment;
  const running = !a || a.status === "pending" || a.status === "running";
  const answerIndex = new Map<string, number>();
  const audioByAnswerId = new Map<string, string>();
  ses.steps.forEach((s, i) => {
    if (s.answer) {
      answerIndex.set(s.answer.id, i + 1);
      if (s.answer.audioAssetId) audioByAnswerId.set(s.answer.id, s.answer.audioAssetId);
    }
  });
  const m = (a?.metrics ?? {}) as { totalWords?: number; wpm?: number | null; speakingSeconds?: number; fillerRate?: number; mattr?: number; connectiveVariety?: number };

  return (
    <div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link href="/history" className="text-xs text-zinc-400 hover:text-zinc-700">← History</Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Score report</h1>
          <p className="mt-1 text-sm text-zinc-500">{modeLabel(ses.session.mode)} · {fmtDate(ses.session.startedAt)}</p>
        </div>
        <div className="flex gap-2">
          {a && ["failed", "partial", "completed"].includes(a.status) && <button onClick={retry} disabled={retrying} className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm disabled:opacity-50">{retrying ? "Re-scoring…" : "Re-run scoring"}</button>}
          <Link href="/speaking" className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white">New session</Link>
        </div>
      </div>

      {running && (
        <Card className="mb-6 p-6">
          <div className="flex items-center gap-3">
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
            <span className="text-sm font-medium">{STAGES[a?.stage ?? "queued"] ?? "Processing"}…</span>
          </div>
          <p className="mt-2 text-xs text-zinc-500">Scoring usually takes from a few seconds up to about a minute, depending on the configured AI services. This page updates automatically.</p>
        </Card>
      )}

      {a?.status === "failed" && (
        <Card className="mb-6 border-red-200 p-6">
          <h2 className="font-semibold text-red-700">Scoring could not be completed</h2>
          <p className="mt-1 text-sm text-zinc-600">{a.error}</p>
        </Card>
      )}

      {a?.status === "unscored" && (
        <Card className="mb-6 border-zinc-200 bg-zinc-50 p-6">
          <h2 className="font-semibold">This mock test is unscored</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-600">The exam ran through the full IELTS Speaking flow. No AI scoring service is connected, so no scores are generated and no heuristic estimates are used.</p>
          <p className="mt-2 text-sm leading-6 text-zinc-600">You can still review each question below — prompt, recording playback and transcript. Configure <code className="rounded bg-white px-1">LLM_PROVIDER</code> / <code className="rounded bg-white px-1">OPENAI_API_KEY</code> (or Anthropic) to re-score this session.</p>
          {a.notes && a.notes.length > 0 && <p className="mt-3 text-xs text-zinc-500">{a.notes[a.notes.length - 1]}</p>}
          <button onClick={retry} disabled={retrying} className="mt-4 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm disabled:opacity-50">{retrying ? "Re-checking…" : "Re-score"}</button>
        </Card>
      )}

      {a && !running && a.status !== "failed" && a.status !== "unscored" && rep && (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="p-6">
              <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">Overall band (estimate)</div>
              <div className="mt-2 flex items-baseline gap-3">
                {a.isComplete ? <Band value={a.overallBand} size="lg" /> : <span className="text-2xl font-semibold text-zinc-400">—</span>}
                {!a.isComplete && <Badge tone="amber">No overall band</Badge>}
              </div>
              <p className="mt-3 text-sm leading-6 text-zinc-600">{rep.report?.summary}</p>
              {!a.isComplete && <p className="mt-3 text-xs leading-5 text-amber-700">The four criteria each count for 25%. Pronunciation (P) was not assessed, so no official overall band is shown; only the assessed dimensions appear below.</p>}
              <dl className="mt-5 grid grid-cols-2 gap-3 text-xs">
                <div><dt className="text-zinc-400">Words spoken</dt><dd className="font-medium tabular-nums">{m.totalWords ?? "–"}</dd></div>
                <div><dt className="text-zinc-400">Speech rate</dt><dd className="font-medium tabular-nums">{m.wpm ? `${m.wpm} wpm` : "–"}</dd></div>
                <div><dt className="text-zinc-400">Lexical diversity</dt><dd className="font-medium tabular-nums">{m.mattr?.toFixed(2) ?? "–"}</dd></div>
                <div><dt className="text-zinc-400">Fillers / 100 words</dt><dd className="font-medium tabular-nums">{m.fillerRate?.toFixed(1) ?? "–"}</dd></div>
              </dl>
              <p className="mt-3 text-[11px] leading-4 text-zinc-400">以上为学习诊断指标（Diagnostic Metrics），用于定位练习方向，不等同于 IELTS Band。</p>
            </Card>
            <div className="grid gap-4 sm:grid-cols-2 lg:col-span-2">
              {(["FC", "LR", "GRA", "P"] as Dimension[]).map((d) => {
                const dim = rep.dimensions.find((x) => x.dimension === d);
                return (
                  <Card key={d} className="p-5">
                    <div className="flex items-start justify-between">
                      <div className="text-sm font-medium">{DIMENSION_LABELS[d]}</div>
                      <Band value={dim?.band ?? null} />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Badge tone={dim?.status === "scored" ? (dim.source === "llm" || dim.source === "audio-llm" || dim.source === "audio-model" ? "green" : "indigo") : "zinc"}>{dim?.status === "scored" ? dim.source : "not assessed"}</Badge>
                      {typeof dim?.confidence === "number" && (
                        <Badge tone={dim.confidence >= 0.7 ? "green" : dim.confidence >= 0.4 ? "amber" : "zinc"}>证据充分度 {(dim.confidence * 100).toFixed(0)}%</Badge>
                      )}
                    </div>
                    <p className="mt-3 text-xs leading-5 text-zinc-600">{dim?.rationale}</p>
                    <DescriptorChips ids={dim?.descriptorRefs} />
                    {!!dim?.strengths?.length && (
                      <div className="mt-2">
                        <div className="text-[11px] font-medium text-emerald-700">做得好的</div>
                        <ul className="list-disc space-y-0.5 pl-4 text-[11px] leading-4 text-zinc-600">{dim.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
                      </div>
                    )}
                    {!!dim?.weaknesses?.length && (
                      <div className="mt-2">
                        <div className="text-[11px] font-medium text-amber-700">压低分数的</div>
                        <ul className="list-disc space-y-0.5 pl-4 text-[11px] leading-4 text-zinc-600">{dim.weaknesses.map((s, i) => <li key={i}>{s}</li>)}</ul>
                      </div>
                    )}
                    {dim?.status === "scored" && !(dim.descriptorRefs?.length) && dim.source === "heuristic" && (
                      <p className="mt-2 text-[11px] leading-4 text-zinc-400">Heuristic scoring cannot cite rubric descriptors.</p>
                    )}
                  </Card>
                );
              })}
            </div>
          </div>

          {a.audioAnalysis && <AudioEvidenceCard sa={a.audioAnalysis} />}

          <div className="mt-6 grid gap-4 lg:grid-cols-3">
            <Card className="p-5 lg:col-span-2">
              <h2 className="mb-4 font-semibold">Detailed feedback</h2>              {(["FC", "LR", "GRA", "P"] as Dimension[]).map((d) => {
                const list = rep.findings.filter((f) => f.dimension === d);
                if (!list.length) return null;
                const crit = CRITERIA.find((c) => c.key === d);
                return (
                  <div key={d} className="mb-6 last:mb-0">
                    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">{DIMENSION_LABELS[d]}</h3>
                    <p className="mb-2 text-xs leading-5 text-zinc-400">Criteria: {crit?.indicators.join(" / ")}</p>
                    <ul className="space-y-3">
                      {list.map((f) => (
                        <li key={f.id} className="rounded-xl bg-zinc-50 p-3.5 text-sm">
                          <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                            <Badge tone={f.kind === "strength" ? "green" : "indigo"}>{f.kind === "strength" ? "Strength" : f.kind === "error" ? "Error" : "To improve"}</Badge><Badge>{f.category}</Badge>
                            {f.answerId && answerIndex.has(f.answerId) && <span className="text-zinc-400">Answer #{answerIndex.get(f.answerId)}</span>}
                            {f.possibleAsrError && <Badge tone="amber">may be a recognition error</Badge>}
                          </div>
                          <div className={f.kind === "error" ? "text-red-700 line-through decoration-red-300" : "text-zinc-800"}>“{f.originalText}”</div>
                          {f.suggestion && <div className="mt-1 text-emerald-700">→ {f.suggestion}</div>}
                          <div className="mt-1 text-xs leading-5 text-zinc-500">{f.explanation}</div>
                          <DescriptorChips ids={f.descriptorRefs} tone="indigo" />
                          {f.startMs != null && f.endMs != null && f.answerId && audioByAnswerId.has(f.answerId) && (
                            <div className="mt-2">
                              <audio controls preload="none" src={`/api/audio/${audioByAnswerId.get(f.answerId)}#t=${(f.startMs / 1000).toFixed(2)},${(f.endMs / 1000).toFixed(2)}`} className="h-8 w-full max-w-xs" />
                              <div className="mt-0.5 text-[11px] text-zinc-400">
                                音频证据片段（{f.evidenceType === "audio" ? "由词级时间戳定位" : "指标定位"}）· {(f.startMs / 1000).toFixed(1)}s – {(f.endMs / 1000).toFixed(1)}s
                              </div>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
              {!rep.findings.length && <p className="text-sm text-zinc-500">No specific findings.</p>}
            </Card>
            <div className="space-y-4">
              <Card className="p-5">
                <h2 className="mb-3 font-semibold">Next steps</h2>
                <ol className="list-decimal space-y-2 pl-5 text-sm text-zinc-700">{rep.report?.nextSteps.map((s, i) => <li key={i}>{s}</li>)}</ol>
              </Card>
              <Card className="p-5 text-xs leading-5 text-zinc-500">
                <h2 className="mb-2 text-sm font-semibold text-zinc-900">How this was scored</h2>
                <ul className="space-y-1">
                  <li>Language scorer: <b>{a.scorer === "llm" ? `${a.llmProvider} · ${a.llmModel}` : "diagnostic only (no LLM)"}</b></li>
                  <li>Prompt version: <b>{a.promptVersion ?? "–"}</b></li>
                  <li>Rubric revision: <b>{a.rubricVersion ?? DESCRIPTOR_SOURCE.revision}</b></li>
                  <li>ASR: <b>{a.asrProvider ?? "–"}</b></li>
                  <li>Pronunciation: <b>{a.pronunciationProvider ?? "not assessed"}</b></li>
                </ul>
                {!!a.limitations?.length && (
                  <div className="mt-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">评分局限（证据缺口）</div>
                    <ul className="list-disc space-y-1 pl-4 text-amber-800">{a.limitations.map((n, i) => <li key={i}>{n}</li>)}</ul>
                  </div>
                )}
                {a.notes && a.notes.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-4 text-amber-800">{a.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
                <p className="mt-3">
                  Band descriptors are a structured <b>paraphrase</b> of the IELTS Speaking public version
                  (not the official wording). This is AI practice feedback, not an official IELTS score and
                  not a guarantee of any band in a real test.
                </p>
                <p className="mt-1">
                  Reference: <a className="underline" href={DESCRIPTOR_SOURCE.url} target="_blank" rel="noreferrer noopener">{DESCRIPTOR_SOURCE.publisher}</a>
                </p>
              </Card>
            </div>
          </div>
        </>
      )}

      <Card className="mt-6 p-5">
        <h2 className="mb-4 font-semibold">Your answers</h2>
        <ol className="space-y-5">
          {ses.steps.map((s, i) => (
            <li key={s.id} className="border-b border-zinc-100 pb-5 last:border-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                <span className="font-medium text-zinc-600">#{i + 1}</span><span>Part {s.part}</span>
                {s.kind === "follow_up" && <Badge tone="indigo">follow-up · {s.generator}</Badge>}
                {s.answer && <span>{(s.answer.durationMs / 1000).toFixed(0)}s</span>}
                {s.answer?.status === "no_response" && <Badge tone="red">no response</Badge>}
                {s.answer?.transcript && <Badge tone={statusTone(s.answer.transcript.status === "completed" ? "completed" : "failed")}>transcript: {s.answer.transcript.status}</Badge>}
              </div>
              <div className="mt-1 text-sm font-medium">{s.promptText}</div>
              {s.answer?.audioAssetId && <AudioPlayer src={`/api/audio/${s.answer.audioAssetId}`} className="mt-2 h-9 w-full max-w-md" />}
              <p className="mt-2 text-sm leading-6 text-zinc-600">{s.answer?.transcript?.text || <span className="italic text-zinc-400">{s.answer ? (s.answer.status === "no_response" ? "No answer was given." : "No transcript available.") : "Not answered."}</span>}</p>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
