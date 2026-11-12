import Link from "next/link";
import { getCurrentUser } from "@/lib/server/user";
import { listSessions } from "@/lib/server/queries";
import { Card, PageHeader, Band, Badge, modeLabel, statusTone, fmtDate } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function History() {
  const user = await getCurrentUser();
  const sessions = user ? await listSessions(user, 200) : [];
  return (
    <>
      <PageHeader title="Exam history" subtitle="Every speaking session, with its scoring status. Listening, Reading and Writing will appear here once available." />
      <Card className="overflow-hidden">
        {sessions.length === 0 ? (
          <p className="p-10 text-center text-sm text-zinc-500">No sessions yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {sessions.map((s) => (
              <li key={s.id}>
                <Link href={s.status === "in_progress" ? `/speaking/exam/${s.id}` : `/speaking/report/${s.id}`} className="flex flex-col gap-2 px-5 py-4 hover:bg-zinc-50 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <Badge tone="indigo">Speaking</Badge>
                      <span className="font-medium">{modeLabel(s.mode)}</span>
                    </div>
                    <div className="mt-1 text-xs text-zinc-400">Started {fmtDate(s.startedAt)}{s.completedAt ? ` · finished ${fmtDate(s.completedAt)}` : ""}</div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="hidden text-xs text-zinc-500 sm:inline">{["FC", "LR", "GRA", "P"].map((d) => `${d} ${s.dims[d]?.toFixed(1) ?? "–"}`).join(" · ")}</span>
                    <Badge tone={statusTone(s.status === "completed" ? s.assessment?.status : s.status)}>
                      {s.status === "in_progress" ? "resume" : s.status === "abandoned" ? "abandoned" : s.assessment?.status ?? "not scored"}
                    </Badge>
                    <Band value={s.assessment?.overallBand ?? null} size="sm" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
