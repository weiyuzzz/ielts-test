import { ensureSeed } from "@/lib/server/seed";
import { questionBank } from "@/lib/server/queries";
import { Card, PageHeader, Badge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Questions() {
  await ensureSeed();
  const qs = await questionBank();
  const parts = [1, 2, 3];
  return (
    <>
      <PageHeader title="Question bank" subtitle="Original practice questions used by the mock test. Topics you have not practised yet are picked first. Read-only for now." />
      <div className="space-y-6">
        {parts.map((p) => {
          const topics = [...new Set(qs.filter((q) => q.part === p).map((q) => q.topic))];
          return (
            <Card key={p} className="p-5">
              <h2 className="mb-4 font-semibold">Part {p} <span className="ml-2 text-sm font-normal text-zinc-400">{qs.filter((q) => q.part === p).length} items</span></h2>
              <div className="grid gap-4 md:grid-cols-2">
                {topics.map((t) => (
                  <div key={t} className="rounded-xl bg-zinc-50 p-4">
                    <div className="mb-2"><Badge>{t}</Badge></div>
                    <ul className="space-y-1.5 text-sm text-zinc-700">
                      {qs.filter((q) => q.part === p && q.topic === t).map((q) => (
                        <li key={q.id}>
                          {q.text}
                          {q.cuePoints?.length ? <ul className="ml-4 mt-1 list-disc text-zinc-500">{q.cuePoints.map((c) => <li key={c}>{c}</li>)}</ul> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
