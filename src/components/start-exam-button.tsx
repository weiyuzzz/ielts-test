"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function StartExamButton({ mode, label = "Start", primary = false }: { mode: string; label?: string; primary?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function start() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/speaking/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Could not start");
      router.push(`/speaking/exam/${j.id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div>
      <button onClick={start} disabled={busy} className={`rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-50 ${primary ? "bg-zinc-900 text-white hover:bg-zinc-700" : "border border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50"}`}>
        {busy ? "Preparing…" : label}
      </button>
      {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
    </div>
  );
}
