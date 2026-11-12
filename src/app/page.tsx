import Link from "next/link";
import { getCurrentUser } from "@/lib/server/user";
import { speakingProgress } from "@/lib/server/queries";
import { Card, PageHeader, Band, Badge, Stat, modeLabel, statusTone, fmtDate } from "@/components/ui";
import { StartExamButton } from "@/components/start-exam-button";
import { DIMENSION_LABELS, DIMENSIONS } from "@/lib/speaking/bands";

export const dynamic = "force-dynamic";

const MODULES = [
  { href: "/speaking", name: "Speaking", status: "live", desc: "AI mock test, Part 1–3 practice, transcripts and criterion feedback." },
  { href: "/listening", name: "Listening", status: "soon", desc: "Timed sections with answer checking and transcript review." },
  { href: "/reading", name: "Reading", status: "soon", desc: "Academic & General passages with question-type drills." },
  { href: "/writing", name: "Writing", status: "soon", desc: "Task 1 & Task 2 essays with criterion-based feedback." },
];

export default async function Dashboard() {
  const user = await getCurrentUser();
  const p = user ? await speakingProgress(user) : null;
  const latest = p?.latest;
  return (
    <>
      <PageHeader title={`Welcome back${user && user.displayName !== "Candidate" ? `, ${user.displayName}` : ""}`} subtitle="Your IELTS preparation at a glance." action={<StartExamButton mode="full" label="Start full speaking mock" primary />} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Target band" value={<Band value={user?.targetBand ?? 7} />} hint={user?.examDate ? `Exam on ${user.examDate}` : <Link href="/settings" className="underline">Set exam date</Link>} />
        <Stat label="Latest speaking" value={<Band value={latest?.assessment?.overallBand ?? null} />} hint={latest ? `${modeLabel(latest.mode)} · ${fmtDate(latest.startedAt)}${latest.assessment?.isComplete ? "" : " · provisional"}` : "No scored attempt yet"} />
        <Stat label="Best speaking" value={<Band value={p?.best ?? null} />} hint="Across all scored attempts" />
        <Stat label="Sessions completed" value={<span className="text-2xl font-semibold tabular-nums">{p?.completed ?? 0}</span>} hint={`${p?.fullMocks ?? 0} full mock tests`} />
      </div>

      <h2 className="mb-3 mt-10 text-sm font-semibold uppercase tracking-wide text-zinc-400">Modules</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {MODULES.map((m) => (
          <Link key={m.href} href={m.href} className="group">
            <Card className="h-full p-5 transition group-hover:border-zinc-300">
              <div className="flex items-center justify-between">
                <span className="font-semibold">{m.name}</span>
                {m.status === "live" ? <Badge tone="green">Available</Badge> : <Badge>Coming soon</Badge>}
              </div>
              <p className="mt-2 text-sm leading-6 text-zinc-500">{m.desc}</p>
              {m.status === "live" ? (
                <div className="mt-4 h-1.5 rounded-full bg-zinc-100">
                  <div className="h-1.5 rounded-full bg-zinc-900" style={{ width: `${Math.min(100, ((p?.completed ?? 0) / 10) * 100)}%` }} />
                </div>
              ) : (
                <div className="mt-4 h-1.5 rounded-full bg-zinc-100" />
              )}
              <div className="mt-1.5 text-xs text-zinc-400">{m.status === "live" ? `${p?.completed ?? 0}/10 sessions this cycle` : "Not yet available"}</div>
            </Card>
          </Link>
        ))}
      </div>

      <div className="mt-10 grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">Recent speaking sessions</h2>
            <Link href="/history" className="text-sm text-zinc-500 hover:text-zinc-900">View all</Link>
          </div>
          {p?.sessions.length ? (
            <ul className="divide-y divide-zinc-100">
              {p.sessions.slice(0, 6).map((s) => (
                <li key={s.id}>
                  <Link href={s.status === "in_progress" ? `/speaking/exam/${s.id}` : `/speaking/report/${s.id}`} className="flex items-center justify-between py-3 text-sm hover:bg-zinc-50">
                    <div>
                      <div className="font-medium">{modeLabel(s.mode)}</div>
                      <div className="text-xs text-zinc-400">{fmtDate(s.startedAt)}</div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge tone={statusTone(s.status === "completed" ? s.assessment?.status : s.status)}>{s.status === "completed" ? s.assessment?.status ?? "completed" : s.status.replace("_", " ")}</Badge>
                      <Band value={s.assessment?.overallBand ?? null} size="sm" />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-8 text-center text-sm text-zinc-500">No sessions yet. Start with a Part 1 practice or a full mock test.</p>
          )}
        </Card>
        <Card className="p-5">
          <h2 className="mb-4 font-semibold">Speaking criteria (last 5)</h2>
          <div className="space-y-4">
            {DIMENSIONS.map((d) => {
              const v = p?.averages[d] ?? null;
              return (
                <div key={d}>
                  <div className="flex justify-between text-sm">
                    <span className="text-zinc-600">{DIMENSION_LABELS[d]}</span>
                    <span className="font-medium tabular-nums">{v?.toFixed(1) ?? "–"}</span>
                  </div>
                  <div className="mt-1.5 h-1.5 rounded-full bg-zinc-100">
                    <div className="h-1.5 rounded-full bg-indigo-500" style={{ width: `${((v ?? 0) / 9) * 100}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-xs leading-5 text-zinc-400">Pronunciation is shown only when an audio-based assessment service is configured.</p>
        </Card>
      </div>
    </>
  );
}
