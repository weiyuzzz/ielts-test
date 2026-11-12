import { Card, Badge, PageHeader } from "./ui";

export function ComingSoon({ title, subtitle, features, preview }: { title: string; subtitle: string; features: { name: string; desc: string }[]; preview: { label: string; items: string[] } }) {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} action={<Badge tone="amber">Coming soon — not yet available</Badge>} />
      <Card className="mb-6 border-dashed p-6">
        <p className="text-sm text-zinc-600">This module is under development. Nothing on this page can be used yet. It previews the planned features and shares the platform&apos;s session, scoring and history infrastructure with Speaking.</p>
      </Card>
      <div className="grid gap-4 md:grid-cols-3">
        {features.map((f) => (
          <Card key={f.name} className="p-5 opacity-80">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">{f.name}</h3>
              <Badge>Planned</Badge>
            </div>
            <p className="mt-2 text-sm leading-6 text-zinc-500">{f.desc}</p>
          </Card>
        ))}
      </div>
      <Card className="mt-6 p-6">
        <h3 className="mb-4 text-xs font-semibold uppercase tracking-wide text-zinc-400">Design preview · {preview.label}</h3>
        <div className="pointer-events-none select-none space-y-3 opacity-60" aria-hidden>
          {preview.items.map((i, n) => (
            <div key={n} className="flex items-center gap-3">
              <span className="grid h-7 w-7 place-items-center rounded-md bg-zinc-100 text-xs font-semibold text-zinc-500">{n + 1}</span>
              <div className="h-9 flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-sm leading-9 text-zinc-400">{i}</div>
            </div>
          ))}
        </div>
        <button disabled className="mt-6 cursor-not-allowed rounded-lg bg-zinc-200 px-4 py-2 text-sm font-medium text-zinc-500">Not available yet</button>
      </Card>
    </>
  );
}
