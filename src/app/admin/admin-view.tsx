"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, Badge } from "@/components/ui";
import { AiSettings } from "./ai-settings";

interface AudioDecision {
  source: "preset" | "tts" | "blocked";
  status: "missing" | "invalid-url" | "unlabelled" | "voice-mismatch" | "ready";
  reason?: string;
  equivalentVoice?: boolean;
}
interface LearningSummary {
  hasSampleAnswer: boolean;
  ideaNotes: number;
  keyPhrases: number;
  hasFollowAudio: boolean;
  reviewStatus: string | null;
  sourceKind: string | null;
  sourceLabel: string | null;
}
interface DetailQuestion {
  id: number; text: string; cues: string[];
  audioUrl: string | null; voiceProfile: string | null;
  audio: AudioDecision;
  followAudio: { playable: boolean; reason?: string };
  learning: LearningSummary;
}
interface BankRow {
  id: number; season: string; name: string; label: string | null; region: string; source: string | null;
  isActive: boolean; importedAt: string;
  counts: { part1: number; part2: number; part3: number };
  audio: { withAudio: number; total: number };
}
interface Detail {
  set: BankRow;
  topics: Array<{ key: string; name: string; nameZh: string | null; type: string; part1: DetailQuestion[]; part2: DetailQuestion[]; part3: DetailQuestion[] }>;
  audio: { total: number; ready: number; voiceMismatch: number; unlabelled: number; invalidUrl: number; missing: number; coveragePercent: number; relabelable: number };
  examinerProfile: { id: string; name: string };
  learning: {
    entries: number;
    sampleAnswerCoverage: { total: number; withSampleAnswer: number; withFollowAudio: number; withAnyContent: number; reviewed: number; sampleAnswerPercent: number };
    warnings: string[];
  };
}

const TYPE_LABEL: Record<string, string> = { evergreen: "Evergreen", new: "New this season", retained: "Retained" };

/** Bank region values come from the import pipeline (source docs are Chinese); display them in English. */
const REGION_LABEL: Record<string, string> = { "大陆地区": "Mainland China", "非大陆地区": "Outside mainland China" };
const regionLabel = (r: string) => REGION_LABEL[r] ?? r;

const AUDIO_LABEL: Record<AudioDecision["status"], { text: string; tone: "green" | "amber" | "red" | "zinc" }> = {
  ready: { text: "Preset audio", tone: "green" },
  missing: { text: "TTS", tone: "zinc" },
  "voice-mismatch": { text: "Voice mismatch", tone: "amber" },
  unlabelled: { text: "Unlabelled voice", tone: "red" },
  "invalid-url": { text: "Invalid URL", tone: "red" },
};

function pct(n: number, d: number) {
  return d ? `${Math.round((n / d) * 1000) / 10}%` : "—";
}

function QuestionRow({ q }: { q: DetailQuestion }) {
  const label = AUDIO_LABEL[q.audio.status];
  return (
    <li className="py-1.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="flex-1 text-sm text-zinc-700">{q.text}</span>
        <Badge tone={label.tone}>{label.text}</Badge>
        {q.learning.hasSampleAnswer && <Badge tone="indigo">Sample answer</Badge>}
        {q.learning.hasFollowAudio && <Badge tone={q.followAudio.playable ? "green" : "red"}>Shadowing audio</Badge>}
      </div>
      {q.audio.status !== "ready" && q.audio.status !== "missing" && q.audio.reason && (
        <p className="mt-0.5 text-xs text-zinc-400">Preset audio cannot play: {q.audio.reason}</p>
      )}
      {(q.audioUrl || q.voiceProfile) && (
        <p className="mt-0.5 break-all text-[11px] text-zinc-400">
          {q.audioUrl || "(no URL)"} · Voice {q.voiceProfile || "unlabelled"}
        </p>
      )}
      {q.learning.hasSampleAnswer && (
        <p className="mt-0.5 text-[11px] text-zinc-400">
          Source: {q.learning.sourceLabel || "Unlabelled"} · Review: {q.learning.reviewStatus === "reviewed" ? "Reviewed" : "Unreviewed"} · {q.learning.ideaNotes} idea notes · {q.learning.keyPhrases} phrase groups
        </p>
      )}
    </li>
  );
}

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
  const [warnings, setWarnings] = useState<string[]>([]);

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
      if (r.ok) {
        const warn = Array.isArray(j.warnings) && j.warnings.length ? ` · ${j.warnings.length} warnings (see below)` : "";
        setMessage(`Imported ${j.season}: ${j.counts.part1} Part 1 / ${j.counts.part2} Part 2 / ${j.counts.part3} Part 3 questions · ${j.learning?.entries ?? 0} learning entries${warn}`);
        setImportText("");
        await load();
        if (j.warnings?.length) setWarnings(j.warnings as string[]);
      } else {
        setMessage(j.error || "Import failed");
        setWarnings(Array.isArray(j.details) ? (j.details as string[]) : []);
      }
    } catch (e) { setMessage(`Invalid JSON: ${(e as Error).message}`); }
    setBusy(false);
  }
  async function onFile(f: File | null) {
    if (!f) return;
    setImportText(await f.text());
  }

  const topics = (detail?.topics ?? []).filter((t) => {
    if (filter !== "all") return !!t[`part${filter}` as "part1" | "part2" | "part3"].length;
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    const texts = [...t.part1, ...t.part2, ...t.part3].map((x) => x.text);
    return [t.name, t.nameZh, ...texts].some((s) => (s || "").toLowerCase().includes(q));
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Question bank admin</h1>
        <p className="mt-1 text-sm text-zinc-500">Import seasonal banks, switch the active season, and inspect bank content and audio coverage. Exams draw strictly from the currently active bank; learning material is used on the practice pages only and never enters the exam.</p>
      </div>

      {protectedMode && (
        <Card className="p-4">
          <label className="block text-sm">Admin token (ADMIN_TOKEN)
            <input type="password" value={token} onChange={(e) => { setToken(e.target.value); localStorage.setItem("admin-token", e.target.value); }} className="mt-1 w-full max-w-sm rounded-lg border border-zinc-200 px-3 py-2 text-sm" placeholder="Enter the ADMIN_TOKEN configured on the server" />
          </label>
        </Card>
      )}

      <AiSettings />

      <Card className="p-5">
        <h2 className="mb-3 font-semibold">Seasonal banks</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-zinc-400">
              <tr>
                <th className="py-2">Season</th><th>Region</th><th>Questions (P1/P2/P3)</th>
                <th>Preset examiner audio</th><th>Status</th><th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {banks.map((b) => (
                <tr key={b.id} className="border-t border-zinc-100">
                  <td className="py-3 font-medium">{b.season}<div className="text-xs font-normal text-zinc-400">{b.label || b.name}</div></td>
                  <td>{regionLabel(b.region)}</td>
                  <td className="tabular-nums">{b.counts.part1} / {b.counts.part2} / {b.counts.part3}</td>
                  <td className="tabular-nums">
                    {b.audio.withAudio} / {b.audio.total}
                    <span className="ml-2 text-xs text-zinc-400">{pct(b.audio.withAudio, b.audio.total)}</span>
                  </td>
                  <td>{b.isActive ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
                  <td className="text-right">
                    <button onClick={() => void view(b.id)} className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs">View content</button>
                    {!b.isActive && <button disabled={busy} onClick={() => void activate(b.id)} className="ml-2 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs text-white disabled:opacity-50">Activate</button>}
                  </td>
                </tr>
              ))}
              {!banks.length && <tr><td colSpan={6} className="py-6 text-center text-zinc-400">No banks yet — import a seasonal bank first.</td></tr>}
            </tbody>
          </table>
        </div>
        {banks[0]?.source && <p className="mt-3 text-xs text-zinc-400">Source: {banks[0].source}</p>}
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 font-semibold">Import a seasonal bank</h2>
        <p className="mb-3 text-xs leading-5 text-zinc-500">
          Paste or pick a JSON file in the expected shape (season / region / topics). Re-importing the same season overwrites the old data; the bank can be activated right after import.
          Questions may carry <code className="rounded bg-zinc-100 px-1">questionAudioUrl</code> + <code className="rounded bg-zinc-100 px-1">questionVoiceProfile</code> (external audio must be HTTPS and must declare a known voice),
          plus <code className="rounded bg-zinc-100 px-1">learning</code> study material.
        </p>
        <input type="file" accept="application/json,.json" onChange={(e) => void onFile(e.target.files?.[0] ?? null)} className="mb-3 block text-xs" />
        <textarea value={importText} onChange={(e) => setImportText(e.target.value)} placeholder='{"season":"2027-01-04","region":"Mainland China","topics":[...]}' className="h-32 w-full rounded-lg border border-zinc-200 p-3 font-mono text-xs" />
        <div className="mt-3 flex gap-2">
          <button disabled={busy} onClick={() => void doImport(false)} className="rounded-lg border border-zinc-200 px-4 py-2 text-sm disabled:opacity-50">Import only</button>
          <button disabled={busy} onClick={() => void doImport(true)} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50">Import and activate</button>
        </div>
        {message && <p className="mt-3 rounded-lg bg-zinc-50 p-3 text-sm text-zinc-700">{message}</p>}
        {!!warnings.length && (
          <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            {warnings.slice(0, 20).map((w, i) => <li key={i}>· {w}</li>)}
          </ul>
        )}
      </Card>

      {detail && (
        <Card className="p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold">Bank content · {detail.set.season}</h2>
              <p className="text-xs text-zinc-500">{regionLabel(detail.set.region)} · {detail.topics.length} topics · reference voice {detail.examinerProfile.name}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="rounded-lg border border-zinc-200 px-2 py-1.5 text-xs">
                <option value="all">All Parts</option><option value="1">Part 1</option><option value="2">Part 2</option><option value="3">Part 3</option>
              </select>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search questions" className="rounded-lg border border-zinc-200 px-2 py-1.5 text-xs" />
              <button onClick={() => setDetail(null)} className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs">Collapse</button>
            </div>
          </div>

          <div className="mb-4 grid gap-2 sm:grid-cols-4">
            {[
              { label: "Total questions", value: detail.audio.total, hint: "All questions in this bank" },
              { label: "Usable preset audio", value: detail.audio.ready, hint: `Coverage ${detail.audio.coveragePercent}%` },
              { label: "Voice mismatch", value: detail.audio.voiceMismatch, hint: detail.audio.relabelable ? `${detail.audio.relabelable} fixable by relabelling` : "Recorded with a different voice than the exam" },
              { label: "No audio / invalid", value: detail.audio.missing + detail.audio.invalidUrl + detail.audio.unlabelled, hint: "Falls back to TTS synthesis" },
            ].map((s) => (
              <div key={s.label} className="rounded-xl border border-zinc-100 p-3">
                <div className="text-xs text-zinc-400">{s.label}</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">{s.value}</div>
                <div className="mt-0.5 text-[11px] text-zinc-400">{s.hint}</div>
              </div>
            ))}
          </div>

          <div className="mb-4 rounded-xl border border-zinc-100 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span className="font-medium text-zinc-700">Learning material coverage</span>
              <span>Sample answers {detail.learning.sampleAnswerCoverage.withSampleAnswer} / {detail.learning.sampleAnswerCoverage.total} ({detail.learning.sampleAnswerCoverage.sampleAnswerPercent}%)</span>
              <span>Shadowing audio {detail.learning.sampleAnswerCoverage.withFollowAudio}</span>
              <span>Human-reviewed {detail.learning.sampleAnswerCoverage.reviewed}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
              <div className="h-full rounded-full bg-zinc-900" style={{ width: `${detail.learning.sampleAnswerCoverage.sampleAnswerPercent}%` }} />
            </div>
            {!!detail.learning.warnings.length && (
              <ul className="mt-2 space-y-0.5 text-[11px] text-amber-700">
                {detail.learning.warnings.slice(0, 5).map((w, i) => <li key={i}>· {w}</li>)}
              </ul>
            )}
          </div>

          <div className="max-h-[640px] space-y-3 overflow-y-auto pr-1">
            {topics.map((t) => (
              <div key={t.key} className="rounded-xl border border-zinc-100 p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{t.name}</span>
                  {t.nameZh && <span className="text-xs text-zinc-400">{t.nameZh}</span>}
                  <Badge tone={t.type === "evergreen" ? "amber" : t.type === "new" ? "indigo" : "zinc"}>{TYPE_LABEL[t.type] || t.type}</Badge>
                </div>
                {!!t.part1.length && <div className="mb-2"><div className="text-xs font-medium text-zinc-400">Part 1 · {t.part1.length} questions</div><ul className="mt-1 divide-y divide-zinc-50">{t.part1.map((q) => <QuestionRow key={q.id} q={q} />)}</ul></div>}
                {!!t.part2.length && <div className="mb-2"><div className="text-xs font-medium text-zinc-400">Part 2 · cue card</div><ul className="mt-1 divide-y divide-zinc-50">{t.part2.map((q) => <QuestionRow key={q.id} q={q} />)}</ul></div>}
                {!!t.part3.length && <div><div className="text-xs font-medium text-zinc-400">Part 3 · {t.part3.length} questions</div><ul className="mt-1 divide-y divide-zinc-50">{t.part3.map((q) => <QuestionRow key={q.id} q={q} />)}</ul></div>}
              </div>
            ))}
            {!topics.length && <p className="text-sm text-zinc-400">No matching questions.</p>}
          </div>
        </Card>
      )}
    </div>
  );
}
