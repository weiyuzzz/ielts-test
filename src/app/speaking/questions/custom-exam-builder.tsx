"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Badge } from "@/components/ui";

/**
 * Minimal shape the picker needs. Deliberately NOT importing `LibraryItem`, so
 * the builder and the browser never form an import cycle.
 */
export interface BuilderItem {
  part: number;
  topic: string;
  topicKey: string;
  topicZh: string | null;
}

/** Practice history handed in by the page. Read-only labels; never used for selection. */
export interface PracticeCounts {
  byPart: Record<string, number>;
  byTopic: Record<string, number>;
}

type Mode = "full" | "part1" | "part2" | "part3";
type Part = 1 | 2 | 3;

const MODES: { mode: Mode; label: string; hint: string }[] = [
  { mode: "full", label: "Full mock", hint: "P1 → P2 → P3" },
  { mode: "part1", label: "Part 1", hint: "1–3 topics" },
  { mode: "part2", label: "Part 2", hint: "1–2 cue cards" },
  { mode: "part3", label: "Part 3", hint: "1–2 discussions" },
];

/** Keep in sync with CUSTOM_TOPIC_LIMITS on the server. */
const LIMITS: Record<Part, number> = { 1: 3, 2: 2, 3: 2 };
const PARTS_FOR: Record<Mode, Part[]> = { full: [1, 2, 3], part1: [1], part2: [2], part3: [3] };
const PART_LABEL: Record<Part, string> = { 1: "Part 1", 2: "Part 2", 3: "Part 3" };
const UNIT: Record<Part, string> = { 1: "topics", 2: "cue cards", 3: "discussions" };

interface Topic {
  key: string;
  name: string;
  nameZh: string | null;
  /** Questions this topic holds for its part (a cue-card topic always has 1). */
  count: number;
}

function TopicPicker({
  part,
  topics,
  selected,
  onToggle,
  practiceByPart,
}: {
  part: Part;
  topics: Topic[];
  selected: string[];
  onToggle: (key: string) => void;
  practiceByPart: Record<string, number>;
}) {
  const [q, setQ] = useState("");
  const limit = LIMITS[part];
  const full = selected.length >= limit;
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return topics;
    return topics.filter((t) => [t.name, t.nameZh].some((s) => (s || "").toLowerCase().includes(needle)));
  }, [topics, q]);

  return (
    <div className="rounded-xl border border-zinc-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium text-zinc-800">
          {PART_LABEL[part]}
          <span className="ml-2 text-[11px] font-normal text-zinc-400">pick 1–{limit} {UNIT[part]}</span>
        </div>
        <Badge tone={selected.length ? "indigo" : "zinc"}>{selected.length}/{limit} selected</Badge>
      </div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Search ${PART_LABEL[part].toLowerCase()} topics`}
        className="mt-2 w-full rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs"
      />
      <div className="mt-2 flex max-h-40 flex-wrap content-start gap-1.5 overflow-y-auto">
        {filtered.map((t) => {
          const on = selected.includes(t.key);
          const disabled = !on && full;
          const practised = practiceByPart[`${part}:${t.key}`] ?? 0;
          const hint = [t.nameZh && t.nameZh !== t.name ? t.nameZh : null, `${t.count} question${t.count === 1 ? "" : "s"}`, `practised ${practised}× — reference only, it does not affect selection`]
            .filter(Boolean)
            .join(" · ");
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onToggle(t.key)}
              disabled={disabled}
              aria-pressed={on}
              title={hint}
              className={`rounded-lg px-2 py-1 text-[11px] transition ${
                on
                  ? "bg-zinc-900 text-white"
                  : disabled
                    ? "cursor-not-allowed border border-zinc-100 text-zinc-300"
                    : "border border-zinc-200 text-zinc-600 hover:bg-zinc-50"
              }`}
            >
              {t.name}
              <span className={`ml-1 tabular-nums ${on ? "text-white/60" : "text-zinc-400"}`}>{t.count}</span>
              <span className={`ml-1 tabular-nums ${on ? "text-white/60" : disabled ? "text-zinc-300" : practised ? "text-indigo-500" : "text-zinc-300"}`}>
                · {practised}×
              </span>
            </button>
          );
        })}
        {!filtered.length && <span className="text-[11px] text-zinc-400">No matching topics.</span>}
      </div>
    </div>
  );
}

export function CustomExamBuilder({ items, practiceCounts }: { items: BuilderItem[]; practiceCounts: PracticeCounts }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("full");
  const [selected, setSelected] = useState<Record<Part, string[]>>({ 1: [], 2: [], 3: [] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const topicsByPart = useMemo(() => {
    const out: Record<Part, Topic[]> = { 1: [], 2: [], 3: [] };
    for (const part of [1, 2, 3] as const) {
      const map = new Map<string, Topic>();
      for (const it of items) {
        if (it.part !== part) continue;
        const t = map.get(it.topicKey) ?? { key: it.topicKey, name: it.topic, nameZh: it.topicZh, count: 0 };
        t.count += 1;
        map.set(it.topicKey, t);
      }
      out[part] = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    return out;
  }, [items]);

  const activeParts = PARTS_FOR[mode];
  const missing = activeParts.filter((p) => selected[p].length === 0);
  const canStart = missing.length === 0;

  function toggle(part: Part, key: string) {
    setSelected((s) => {
      const cur = s[part];
      if (cur.includes(key)) return { ...s, [part]: cur.filter((k) => k !== key) };
      if (cur.length >= LIMITS[part]) return s; // the chip is disabled anyway
      return { ...s, [part]: [...cur, key] };
    });
  }

  async function start() {
    setBusy(true);
    setErr(null);
    try {
      // Only the parts this mode runs are sent; the server rejects the rest.
      const selection: Record<string, string[]> = {};
      for (const p of activeParts) selection[`part${p}`] = selected[p];
      const res = await fetch("/api/speaking/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, selection }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Could not start");
      router.push(`/speaking/exam/${j.id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold text-zinc-900">Build a custom practice test</h2>
      <p className="mt-1 max-w-2xl text-[11px] leading-5 text-zinc-400">
        Pick the exact topics to practise. A full session runs Part 1 → 2 → 3; a part session runs that part only.
        Selecting several topics in one part examines them back to back. <b className="font-medium text-emerald-700">Custom practice is untimed — no per-part or whole-test clock, and nothing is cut off early — so you can speak at your own pace.</b> Formal mock tests keep the real exam timing.
        The two small numbers on each topic are its question count and how many mock tests you have practised it in —
        shown for reference only; practise history never affects which topics a test picks.
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            onClick={() => { setMode(m.mode); setErr(null); }}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium ${mode === m.mode ? "bg-zinc-900 text-white" : "border border-zinc-200 text-zinc-600 hover:bg-zinc-50"}`}
          >
            {m.label}
            <span className={`ml-1.5 text-[10px] ${mode === m.mode ? "text-white/60" : "text-zinc-400"}`}>{m.hint}</span>
          </button>
        ))}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {activeParts.map((p) => (
          <TopicPicker
            key={p}
            part={p}
            topics={topicsByPart[p]}
            selected={selected[p]}
            onToggle={(key) => toggle(p, key)}
            practiceByPart={practiceCounts.byPart}
          />
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={start}
          disabled={!canStart || busy}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? "Preparing…" : "Start custom test"}
        </button>
        {!canStart && (
          <span className="text-[11px] text-zinc-500">
            Pick at least one {missing.map((p) => PART_LABEL[p]).join(" and ")} topic to start.
          </span>
        )}
        {err && <span className="text-[11px] text-red-600">{err}</span>}
      </div>
    </Card>
  );
}
