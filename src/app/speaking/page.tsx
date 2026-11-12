import Link from "next/link";
import { getCurrentUser } from "@/lib/server/user";
import { speakingProgress } from "@/lib/server/queries";
import { capabilities } from "@/lib/ai/registry";
import { SPEAKING_MODES, resolveConfig } from "@/lib/speaking/config";
import { Card, PageHeader, Band, Badge, modeLabel, statusTone, fmtDate } from "@/components/ui";
import { StartExamButton } from "@/components/start-exam-button";

export const dynamic = "force-dynamic";

export default async function SpeakingHome() {
  const user = await getCurrentUser();
  const p = user ? await speakingProgress(user) : null;
  const caps = capabilities();
  const full = resolveConfig("full");
  return (
    <>
      <PageHeader title="Speaking" subtitle="Practise under real exam conditions. Your answers are recorded, transcribed and analysed against the four IELTS speaking criteria." action={<Link href="/speaking/questions" className="text-sm text-zinc-500 hover:text-zinc-900">Question bank →</Link>} />

      <div className="grid gap-4 md:grid-cols-2">
        {SPEAKING_MODES.map((m) => (
          <Card key={m.mode} className={`flex flex-col p-6 ${m.mode === "full" ? "md:col-span-2 border-zinc-900" : ""}`}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold">{m.title}</h2>
                  <Badge>{m.minutes}</Badge>
                </div>
                <p className="mt-1.5 text-sm text-zinc-500">{m.description}</p>
                {m.mode === "full" && (
                  <div className="mt-4 grid grid-cols-3 gap-3 text-xs text-zinc-500 sm:max-w-md">
                    <div className="rounded-lg bg-zinc-50 p-3"><div className="font-semibold text-zinc-800">Part 1</div>{full.part1.topics * full.part1.questionsPerTopic} questions · {full.part1.answerSeconds}s each</div>
                    <div className="rounded-lg bg-zinc-50 p-3"><div className="font-semibold text-zinc-800">Part 2</div>{full.part2.prepSeconds}s prep · {full.part2.answerSeconds}s talk</div>
                    <div className="rounded-lg bg-zinc-50 p-3"><div className="font-semibold text-zinc-800">Part 3</div>{full.part3.questions} questions + follow-ups</div>
                  </div>
                )}
              </div>
              <StartExamButton mode={m.mode} label={m.mode === "full" ? "Start mock test" : "Practise"} primary={m.mode === "full"} />
            </div>
          </Card>
        ))}
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">Recent results</h2>
            <Link href="/history" className="text-sm text-zinc-500 hover:text-zinc-900">History</Link>
          </div>
          {p?.sessions.length ? (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-zinc-400">
                <tr><th className="py-2 font-medium">Session</th><th className="hidden font-medium sm:table-cell">FC</th><th className="hidden font-medium sm:table-cell">LR</th><th className="hidden font-medium sm:table-cell">GRA</th><th className="hidden font-medium sm:table-cell">P</th><th className="text-right font-medium">Overall</th></tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {p.sessions.slice(0, 8).map((s) => (
                  <tr key={s.id}>
                    <td className="py-3">
                      <Link href={s.status === "in_progress" ? `/speaking/exam/${s.id}` : `/speaking/report/${s.id}`} className="font-medium hover:underline">{modeLabel(s.mode)}</Link>
                      <div className="text-xs text-zinc-400">{fmtDate(s.startedAt)} {s.status !== "completed" && <Badge tone={statusTone(s.status)}>{s.status.replace("_", " ")}</Badge>}</div>
                    </td>
                    {(["FC", "LR", "GRA", "P"] as const).map((d) => <td key={d} className="hidden tabular-nums text-zinc-600 sm:table-cell">{s.dims[d]?.toFixed(1) ?? "–"}</td>)}
                    <td className="text-right"><Band value={s.assessment?.overallBand ?? null} size="sm" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="py-8 text-center text-sm text-zinc-500">Your results will appear here.</p>
          )}
        </Card>
        <Card className="p-5">
          <h2 className="mb-3 font-semibold">Progress</h2>
          <div className="flex h-28 items-end gap-1.5">
            {(p?.trend.length ? p.trend : []).map((t) => (
              <Link key={t.id} href={`/speaking/report/${t.id}`} title={`${t.band}`} className="flex-1 rounded-t bg-zinc-900/80 hover:bg-zinc-900" style={{ height: `${(t.band / 9) * 100}%` }} />
            ))}
            {!p?.trend.length && <div className="w-full self-center text-center text-sm text-zinc-400">No scored sessions</div>}
          </div>
          <h3 className="mb-2 mt-6 text-xs font-semibold uppercase tracking-wide text-zinc-400">AI services in use</h3>
          <ul className="space-y-1.5 text-xs text-zinc-600">
            <li>Speech recognition: <b>{caps.asr ? caps.asr.id : "none"}</b></li>
            <li>Language scoring: <b>{caps.llm ? `${caps.llm.id} (${caps.llm.model})` : "heuristic (no LLM configured)"}</b></li>
            <li>Examiner voice: <b>{caps.tts.id}</b></li>
            <li>Pronunciation: <b>{caps.pronunciation ? caps.pronunciation.id : "not assessed (no audio model)"}</b></li>
          </ul>
        </Card>
      </div>
    </>
  );
}
