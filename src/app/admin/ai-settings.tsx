"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, Badge } from "@/components/ui";

type ProviderKey = "llm" | "tts" | "asr" | "pronunciation";

interface Prov {
  enabled: boolean;
  provider: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
  region?: string;
  hasKey: boolean;
  keyHint: string | null;
}
interface Cfg {
  llm: Prov; tts: Prov; asr: Prov; pronunciation: Prov;
  path: string; fileExists: boolean; updatedAt: string | null; warnings: string[];
}

interface Draft extends Prov {
  apiKey: string;
  clearKey: boolean;
}
type Drafts = Record<ProviderKey, Draft>;

const PROVIDERS: Record<ProviderKey, { label: string; hint: string; options: { id: string; label: string }[]; fields: ("baseUrl" | "model" | "voice" | "region")[] }> = {
  llm: {
    label: "Language scoring LLM (FC / LR / GRA)",
    hint: "The exam can still be completed with this off, but the report will be unscored — scores are never fabricated.",
    options: [
      { id: "auto", label: "Auto (from environment variables)" },
      { id: "openai", label: "OpenAI-compatible / DeepSeek / Qwen / local vLLM" },
      { id: "anthropic", label: "Anthropic" },
      { id: "none", label: "Off (no scoring)" },
    ],
    fields: ["baseUrl", "model"],
  },
  tts: {
    label: "Examiner voice (TTS)",
    hint: "When off, falls back to browser speech synthesis (robotic, but usable). Azure requires a region.",
    options: [
      { id: "auto", label: "Auto (from environment variables)" },
      { id: "openai", label: "OpenAI-compatible / Kokoro" },
      { id: "azure", label: "Azure Neural" },
      { id: "browser", label: "Browser speech synthesis" },
    ],
    fields: ["baseUrl", "model", "voice", "region"],
  },
  asr: {
    label: "Speech transcription (ASR)",
    hint: "When off, browser Web Speech is used; without ASR, recording and playback still work but no automatic scoring happens.",
    options: [
      { id: "auto", label: "Auto (from environment variables)" },
      { id: "openai", label: "OpenAI-compatible Whisper" },
      { id: "browser", label: "Browser Web Speech" },
      { id: "none", label: "Off" },
    ],
    fields: ["baseUrl", "model"],
  },
  pronunciation: {
    label: "Pronunciation assessment (P criterion)",
    hint: "When not configured, P is marked not_assessed and the overall band is hidden — pronunciation is never guessed from the transcript.",
    options: [
      { id: "auto", label: "Auto (from environment variables)" },
      { id: "azure", label: "Azure Pronunciation Assessment" },
      { id: "none", label: "Off" },
    ],
    fields: ["region"],
  },
};

const KEYS: ProviderKey[] = ["llm", "tts", "asr", "pronunciation"];

function toDrafts(c: Cfg): Drafts {
  const one = (p: Prov): Draft => ({
    enabled: p.enabled, provider: p.provider,
    baseUrl: p.baseUrl ?? "", model: p.model ?? "", voice: p.voice ?? "", region: p.region ?? "",
    hasKey: p.hasKey, keyHint: p.keyHint, apiKey: "", clearKey: false,
  });
  return { llm: one(c.llm), tts: one(c.tts), asr: one(c.asr), pronunciation: one(c.pronunciation) };
}

export function AiSettings() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [draft, setDraft] = useState<Drafts | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const headers = () => {
    const token = typeof window !== "undefined" ? localStorage.getItem("admin-token") : null;
    return { "Content-Type": "application/json", ...(token ? { "x-admin-token": token } : {}) };
  };

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/ai", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to load");
      setCfg(j.config as Cfg);
      setDraft(toDrafts(j.config as Cfg));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  // Deferred so the effect body has no synchronous setState (react-hooks rule).
  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(t);
  }, [load]);

  function set<K extends ProviderKey>(k: K, patch: Partial<Draft>) {
    setDraft((d) => (d ? { ...d, [k]: { ...d[k], ...patch } } : d));
  }

  async function save() {
    if (!draft) return;
    setBusy(true); setMsg(null);
    try {
      const patch: Record<string, unknown> = {};
      for (const k of KEYS) {
        const d = draft[k];
        patch[k] = {
          enabled: d.enabled,
          provider: d.provider,
          baseUrl: d.baseUrl, model: d.model, voice: d.voice, region: d.region,
          ...(d.apiKey.trim() ? { apiKey: d.apiKey.trim() } : {}),
          ...(d.clearKey ? { clearKey: true } : {}),
        };
      }
      const r = await fetch("/api/admin/ai", { method: "PUT", headers: headers(), body: JSON.stringify(patch) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to save");
      setCfg(j.config as Cfg);
      setDraft(toDrafts(j.config as Cfg));
      setMsg("Saved. Takes effect on the next request (no restart needed).");
    } catch (e) {
      setMsg(`Save failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (err) return <Card className="p-5 text-sm text-red-600">Failed to load AI configuration: {err}</Card>;
  if (!cfg || !draft) return <Card className="p-5 text-sm text-zinc-400">Loading AI configuration…</Card>;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">AI services (scoring / speech / transcription)</h2>
          <p className="mt-1 text-xs leading-5 text-zinc-500">
            Changes take effect immediately after saving. Keys are stored on the server only ({cfg.path}); the API returns masked values only and keys are never sent to the browser.
            &quot;Auto&quot; means the environment variables apply; an explicit choice here takes precedence.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {cfg.fileExists ? <Badge tone="green">Configured</Badge> : <Badge tone="amber">Not configured (using environment variables)</Badge>}
          <button onClick={save} disabled={busy} className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {msg && <p className="mt-3 rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-700">{msg}</p>}
      {cfg.warnings.map((w) => <p key={w} className="mt-2 text-xs text-amber-700">{w}</p>)}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {KEYS.map((k) => {
          const meta = PROVIDERS[k];
          const d = draft[k];
          return (
            <div key={k} className="rounded-xl border border-zinc-200 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="text-sm font-medium">{meta.label}</div>
                <label className="flex shrink-0 items-center gap-1.5 text-xs text-zinc-600">
                  <input type="checkbox" checked={d.enabled} onChange={(e) => set(k, { enabled: e.target.checked })} />
                  Enabled
                </label>
              </div>
              <p className="mt-1 text-[11px] leading-4 text-zinc-400">{meta.hint}</p>

              <label className="mt-3 block text-xs text-zinc-500">Provider
                <select value={d.provider} onChange={(e) => set(k, { provider: e.target.value })} className="mt-1 w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-sm">
                  {meta.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              </label>

              <div className="mt-2 grid grid-cols-2 gap-2">
                {meta.fields.map((f) => (
                  <label key={f} className="block text-xs text-zinc-500">
                    {f === "baseUrl" ? "Base URL" : f === "model" ? "Model" : f === "voice" ? "Voice" : "Region"}
                    <input
                      value={d[f] as string}
                      onChange={(e) => set(k, { [f]: e.target.value } as Partial<Draft>)}
                      placeholder={f === "baseUrl" ? "https://api.openai.com/v1" : f === "model" ? "gpt-4o-mini" : f === "voice" ? "en-GB-SoniaNeural" : "eastus"}
                      className="mt-1 w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-sm"
                    />
                  </label>
                ))}
              </div>

              <label className="mt-2 block text-xs text-zinc-500">API Key
                <input
                  type="password"
                  value={d.apiKey}
                  onChange={(e) => set(k, { apiKey: e.target.value })}
                  placeholder={d.hasKey ? `Saved ${d.keyHint} (leave blank to keep)` : "Not set"}
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-sm"
                />
              </label>
              {d.hasKey && (
                <label className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-500">
                  <input type="checkbox" checked={d.clearKey} onChange={(e) => set(k, { clearKey: e.target.checked })} />
                  Clear the saved key
                </label>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
