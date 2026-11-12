"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, Badge } from "@/components/ui";

interface BankRow {
  id: number; season: string; name: string; label: string | null; region: string; source: string | null;
  isActive: boolean; importedAt: string;
  counts: { part1: number; part2: number; part3: number };
}
interface TopicRow {
  key: string; name: string; nameZh: string | null; type: string;
  part1: string[]; part2: { text: string; cues: string[] }[]; part3: string[];
}
interface Detail { set: BankRow; topics: TopicRow[] }

const TYPE_LABEL: Record<string, string> = { evergreen: "万年保留题", new: "当季新题", retained: "当季保留题" };

export function AdminView() {
  const [banks, setBanks] = useState<BankRow[]>([]);
  const [protectedMode, setProtected] = useState(false);
  const [token, setToken] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [filter, setFilter] = useState<"all" | "1" | "2" | "3">("all");
  const [query, setQuery] = useState("");
  const [importText, setImportText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setToken(localStorage.getItem("admin-token") || ""), 0);
    return () => clearTimeout(t);
  }, []);

  const headers = useCallback(() => ({ "Content-Type": "application/json", "x-admin-token": token }), [token]);
  const load = useCallback(async () => {
    const r = await fetch("/api/admin/banks", { cache: "no-store" });
    const j = await r.json();
    setBanks(j.banks || []);
    setProtected(!!j.protected);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(t);
  }, [load]);

  async function view(id: number) {
    setMessage(null);
    const r = await fetch(`/api/admin/banks?id=${id}`, { cache: "no-store" });
    if (r.ok) setDetail(await r.json());
    else setMessage("Could not load this bank.");
  }
  async function activate(id: number) {
    setBusy(true); setMessage(null);
    const r = await fetch("/api/admin/banks", { method: "PUT", headers: headers(), body: JSON.stringify({ id }) });
    setMessage(r.ok ? "Active bank switched. New exams will draw only from this bank." : (await r.json()).error || "Failed");
    await load(); setBusy(false);
  }
  async function doImport(activateAfter: boolean) {
    if (!importText.trim()) { setMessage("Paste a bank JSON first."); return; }
    setBusy(true); setMessage(null);
    try {
      const parsed = JSON.parse(importText);
      const r = await fetch("/api/admin/banks", { method: "POST", headers: headers(), body: JSON.stringify({ bank: parsed, activate: activateAfter }) });
      const j = await r.json();
      setMessage(r.ok ? `Imported ${j.season}: ${j.counts.part1} Part 1 / ${j.counts.part2} Part 2 / ${j.counts.part3} Part 3 questions.` : (j.error || "Import failed"));
      if (r.ok) { setImportText(""); await load(); }
    } catch (e) { setMessage(`Invalid JSON: ${(e as Error).message}`); }
    setBusy(false);
  }
  async function onFile(f: File | null) {
    if (!f) return;
    setImportText(await f.text());
  }

  const topics = (detail?.topics ?? []).filter((t) => {
    if (filter !== "all" && !t[`part${filter}` as "part1" | "part2" | "part3"].length) return false;
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return [t.name, t.nameZh, ...t.part1, ...t.part2.map((x) => x.text), ...t.part3].some((s) => (s || "").toLowerCase().includes(q));
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">题库后台</h1>
        <p className="mt-1 text-sm text-zinc-500">导入季度题库、切换启用季度、查看题库内容。考试严格从当前启用的题库抽取。</p>
      </div>

      {protectedMode && (
        <Card className="p-4">
          <label className="block text-sm">管理令牌（ADMIN_TOKEN）
            <input type="password" value={token} onChange={(e) => { setToken(e.target.value); localStorage.setItem("admin-token", e.target.value); }} className="mt-1 w-full max-w-sm rounded-lg border border-zinc-200 px-3 py-2 text-sm" placeholder="输入服务端配置的 ADMIN_TOKEN" />
          </label>
        </Card>
      )}

      <Card className="p-5">
        <h2 className="mb-3 font-semibold">季度题库</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-zinc-400">
              <tr><th className="py-2">季度</th><th>考区</th><th>题目数 (P1/P2/P3)</th><th>状态</th><th className="text-right">操作</th></tr>
            </thead>
            <tbody>
              {banks.map((b) => (
                <tr key={b.id} className="border-t border-zinc-100">
                  <td className="py-3 font-medium">{b.season}<div className="text-xs font-normal text-zinc-400">{b.label || b.name}</div></td>
                  <td>{b.region}</td>
                  <td className="tabular-nums">{b.counts.part1} / {b.counts.part2} / {b.counts.part3}</td>
                  <td>{b.isActive ? <Badge tone="green">启用中</Badge> : <Badge>未启用</Badge>}</td>
                  <td className="text-right">
                    <button onClick={() => view(b.id)} className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs">查看内容</button>
                    {!b.isActive && <button disabled={busy} onClick={() => activate(b.id)} className="ml-2 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs text-white disabled:opacity-50">设为启用</button>}
                  </td>
                </tr>
              ))}
              {!banks.length && <tr><td colSpan={5} className="py-6 text-center text-zinc-400">暂无题库，先导入一个季度题库。</td></tr>}
            </tbody>
          </table>
        </div>
        {banks[0]?.source && <p className="mt-3 text-xs text-zinc-400">来源：{banks[0].source}</p>}
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 font-semibold">导入季度题库</h2>
        <p className="mb-3 text-xs leading-5 text-zinc-500">粘贴或选择符合格式的 JSON（season / region / topics）。同一 season 重复导入会覆盖旧数据；导入后可立即设为启用。</p>
        <input type="file" accept="application/json,.json" onChange={(e) => void onFile(e.target.files?.[0] ?? null)} className="mb-3 block text-xs" />
        <textarea value={importText} onChange={(e) => setImportText(e.target.value)} placeholder='{"season":"2027-01-04","region":"大陆地区","topics":[...]}' className="h-32 w-full rounded-lg border border-zinc-200 p-3 font-mono text-xs" />
        <div className="mt-3 flex gap-2">
          <button disabled={busy} onClick={() => doImport(false)} className="rounded-lg border border-zinc-200 px-4 py-2 text-sm disabled:opacity-50">仅导入</button>
          <button disabled={busy} onClick={() => doImport(true)} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50">导入并设为启用</button>
        </div>
        {message && <p className="mt-3 rounded-lg bg-zinc-50 p-3 text-sm text-zinc-700">{message}</p>}
      </Card>

      {detail && (
        <Card className="p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">题库内容 · {detail.set.season}</h2>
              <p className="text-xs text-zinc-500">{detail.set.region} · {detail.topics.length} 个主题</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="rounded-lg border border-zinc-200 px-2 py-1.5 text-xs">
                <option value="all">全部 Part</option><option value="1">Part 1</option><option value="2">Part 2</option><option value="3">Part 3</option>
              </select>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索题目" className="rounded-lg border border-zinc-200 px-2 py-1.5 text-xs" />
              <button onClick={() => setDetail(null)} className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs">收起</button>
            </div>
          </div>
          <div className="max-h-[640px] space-y-3 overflow-y-auto pr-1">
            {topics.map((t) => (
              <div key={t.key} className="rounded-xl border border-zinc-100 p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{t.name}</span>
                  {t.nameZh && <span className="text-xs text-zinc-400">{t.nameZh}</span>}
                  <Badge tone={t.type === "evergreen" ? "amber" : t.type === "new" ? "indigo" : "zinc"}>{TYPE_LABEL[t.type] || t.type}</Badge>
                </div>
                {!!t.part1.length && <div className="mb-2"><div className="text-xs font-medium text-zinc-400">Part 1 · {t.part1.length} 题</div><ul className="mt-1 space-y-0.5 text-sm text-zinc-700">{t.part1.map((q, i) => <li key={i}>· {q}</li>)}</ul></div>}
                {!!t.part2.length && <div className="mb-2"><div className="text-xs font-medium text-zinc-400">Part 2 · 题卡</div>{t.part2.map((c, i) => <div key={i} className="mt-1 text-sm text-zinc-700">{c.text}{c.cues.length > 0 && <span className="ml-2 text-xs text-zinc-400">You should say: {c.cues.join(" · ")}</span>}</div>)}</div>}
                {!!t.part3.length && <div><div className="text-xs font-medium text-zinc-400">Part 3 · {t.part3.length} 题</div><ul className="mt-1 space-y-0.5 text-sm text-zinc-700">{t.part3.map((q, i) => <li key={i}>· {q}</li>)}</ul></div>}
              </div>
            ))}
            {!topics.length && <p className="text-sm text-zinc-400">没有匹配的题目。</p>}
          </div>
        </Card>
      )}
    </div>
  );
}
