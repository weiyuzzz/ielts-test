"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, Badge, Band, modeLabel, statusTone, fmtDate } from "@/components/ui";
import { DIMENSION_LABELS, type Dimension } from "@/lib/speaking/bands";
import { CRITERIA } from "@/lib/speaking/band-descriptors";

interface Dim { dimension: Dimension; band: number | null; status: string; source: string; rationale: string }
interface FindingRow { id: string; dimension: string; answerId: string | null; kind: string; category: string; originalText: string; suggestion: string | null; explanation: string; possibleAsrError: boolean }
interface ReportData {
  assessment: { id: string; status: string; stage: string | null; overallBand: number | null; isComplete: boolean; scorer: string | null; llmProvider: string | null; llmModel: string | null; promptVersion: string | null; asrProvider: string | null; pronunciationProvider: string | null; metrics: Record<string, unknown> | null; notes: string[] | null; error: string | null; startedAt: string; completedAt: string | null };
  dimensions: Dim[];
  findings: FindingRow[];
  report: { summary: string; nextSteps: string[] } | null;
}
interface SessionData {
  session: { id: string; mode: string; status: string; startedAt: string; completedAt: string | null };
  steps: { id: string; part: number; kind: string; promptText: string; topic: string; generator: string; answer: { id: string; status: string; durationMs: number; audioAssetId: string | null; transcript: { status: string; text: string; provider: string } | null } | null }[];
}

const STAGES: Record<string, string> = { queued: "Queued", transcribing: "Transcribing answers", pronunciation: "Assessing pronunciation", scoring: "Analysing language", done: "Done" };

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
  ses.steps.forEach((s, i) => s.answer && answerIndex.set(s.answer.id, i + 1));
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
          <h2 className="font-semibold">本次模考未评分</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-600">考试流程已按 IELTS 口语规范完整走完。当前没有接入 AI 评分服务，因此不生成任何分数也不会用启发式估算分数。</p>
          <p className="mt-2 text-sm leading-6 text-zinc-600">你仍可在下方逐题查看题目、录音回放与转写文本。配置 <code className="rounded bg-white px-1">LLM_PROVIDER</code> / <code className="rounded bg-white px-1">OPENAI_API_KEY</code>（或 Anthropic）后，可对本次考试重新评分。</p>
          {a.notes && a.notes.length > 0 && <p className="mt-3 text-xs text-zinc-500">{a.notes[a.notes.length - 1]}</p>}
          <button onClick={retry} disabled={retrying} className="mt-4 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm disabled:opacity-50">{retrying ? "Re-checking…" : "重新评分"}</button>
        </Card>
      )}

      {a && !running && a.status !== "failed" && a.status !== "unscored" && rep && (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="p-6">
              <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">Overall band (estimate)</div>
              <div className="mt-2 flex items-baseline gap-3">
                {a.isComplete ? <Band value={a.overallBand} size="lg" /> : <span className="text-2xl font-semibold text-zinc-400">—</span>}
                {!a.isComplete && <Badge tone="amber">未出总分</Badge>}
              </div>
              <p className="mt-3 text-sm leading-6 text-zinc-600">{rep.report?.summary}</p>
              {!a.isComplete && <p className="mt-3 text-xs leading-5 text-amber-700">四个评分标准各占 25%。发音（P）未评估，因此不显示正式总分；下方仅展示已评估的维度。</p>}
              <dl className="mt-5 grid grid-cols-2 gap-3 text-xs">
                <div><dt className="text-zinc-400">Words spoken</dt><dd className="font-medium tabular-nums">{m.totalWords ?? "–"}</dd></div>
                <div><dt className="text-zinc-400">Speech rate</dt><dd className="font-medium tabular-nums">{m.wpm ? `${m.wpm} wpm` : "–"}</dd></div>
                <div><dt className="text-zinc-400">Lexical diversity</dt><dd className="font-medium tabular-nums">{m.mattr?.toFixed(2) ?? "–"}</dd></div>
                <div><dt className="text-zinc-400">Fillers / 100 words</dt><dd className="font-medium tabular-nums">{m.fillerRate?.toFixed(1) ?? "–"}</dd></div>
              </dl>
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
                    <div className="mt-1"><Badge tone={dim?.status === "scored" ? (dim.source === "llm" || dim.source === "audio-model" ? "green" : "indigo") : "zinc"}>{dim?.status === "scored" ? dim.source : "not assessed"}</Badge></div>
                    <p className="mt-3 text-xs leading-5 text-zinc-600">{dim?.rationale}</p>
                  </Card>
                );
              })}
            </div>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-3">
            <Card className="p-5 lg:col-span-2">
              <h2 className="mb-4 font-semibold">Detailed feedback</h2>
              {(["FC", "LR", "GRA", "P"] as Dimension[]).map((d) => {
                const list = rep.findings.filter((f) => f.dimension === d);
                if (!list.length) return null;
                const crit = CRITERIA.find((c) => c.key === d);
                return (
                  <div key={d} className="mb-6 last:mb-0">
                    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">{DIMENSION_LABELS[d]} · {crit?.labelZh}</h3>
                    <p className="mb-2 text-xs leading-5 text-zinc-400">评分依据：{crit?.indicators.join(" / ")}</p>
                    <ul className="space-y-3">
                      {list.map((f) => (
                        <li key={f.id} className="rounded-xl bg-zinc-50 p-3.5 text-sm">
                          <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                            <Badge tone={f.kind === "strength" ? "green" : "indigo"}>{f.kind === "strength" ? "亮点" : f.kind === "error" ? "错误" : "待改进"}</Badge><Badge>{f.category}</Badge>
                            {f.answerId && answerIndex.has(f.answerId) && <span className="text-zinc-400">Answer #{answerIndex.get(f.answerId)}</span>}
                            {f.possibleAsrError && <Badge tone="amber">may be a recognition error</Badge>}
                          </div>
                          <div className={f.kind === "error" ? "text-red-700 line-through decoration-red-300" : "text-zinc-800"}>“{f.originalText}”</div>
                          {f.suggestion && <div className="mt-1 text-emerald-700">→ {f.suggestion}</div>}
                          <div className="mt-1 text-xs leading-5 text-zinc-500">{f.explanation}</div>
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
                  <li>Language scorer: <b>{a.scorer === "llm" ? `${a.llmProvider} · ${a.llmModel}` : "heuristic"}</b></li>
                  <li>Prompt/rules version: <b>{a.promptVersion}</b></li>
                  <li>ASR: <b>{a.asrProvider ?? "–"}</b></li>
                  <li>Pronunciation: <b>{a.pronunciationProvider ?? "not assessed"}</b></li>
                </ul>
                {a.notes && a.notes.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-4 text-amber-800">{a.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
                <p className="mt-3">This is AI practice feedback, not an official IELTS score.</p>
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
              {s.answer?.audioAssetId && <audio controls preload="none" src={`/api/audio/${s.answer.audioAssetId}`} className="mt-2 h-9 w-full max-w-md" />}
              <p className="mt-2 text-sm leading-6 text-zinc-600">{s.answer?.transcript?.text || <span className="italic text-zinc-400">{s.answer ? (s.answer.status === "no_response" ? "No answer was given." : "No transcript available.") : "Not answered."}</span>}</p>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
