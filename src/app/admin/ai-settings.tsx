"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, Badge } from "@/components/ui";

type ProviderKey = "llm" | "tts" | "asr" | "pronunciation";

interface Prov {
  enabled: boolean;
  provider: string;
  baseUrl?: string;
  model?: string;
  secretId?: string;
  voice?: string;
  region?: string;
  /** Numeric sampling fields (LLM only); the draft carries them as strings. */
  temperature?: number;
  maxTokens?: number;
  hasKey: boolean;
  keyHint: string | null;
}

type NumericField = "temperature" | "maxTokens";
interface Cfg {
  llm: Prov; tts: Prov; asr: Prov; pronunciation: Prov;
  path: string; fileExists: boolean; updatedAt: string | null; warnings: string[];
}

interface Draft extends Omit<Prov, NumericField> {
  apiKey: string;
  clearKey: boolean;
  /** Text inputs carry the numeric sampling fields as strings. */
  temperature: string;
  maxTokens: string;
}
type Drafts = Record<ProviderKey, Draft>;

const PROVIDERS: Record<ProviderKey, { label: string; hint: string; options: { id: string; label: string }[]; fields: ("baseUrl" | "model" | "voice" | "region" | "secretId" | "temperature" | "maxTokens")[] }> = {
  llm: {
    label: "语言评分 LLM（FC / LR / GRA，发音维度需音频证据）",
    hint: "关闭后考试仍可完成，但报告会是「未评分」，绝不伪造分数。所有 Provider 使用同一套评分标准与校验。",
    options: [
      { id: "auto", label: "自动（按环境变量）" },
      { id: "deepseek", label: "DeepSeek" },
      { id: "qwen", label: "Qwen / 通义千问（DashScope）" },
      { id: "gemini", label: "Gemini（OpenAI 兼容端点）" },
      { id: "openai", label: "OpenAI 兼容 / 本地 vLLM" },
      { id: "anthropic", label: "Anthropic" },
      { id: "none", label: "关闭（不评分）" },
    ],
    fields: ["baseUrl", "model", "temperature", "maxTokens"],
  },
  tts: {
    label: "考官语音 TTS",
    hint: "关闭后回退浏览器语音合成（机械音，但可用）。Azure 需要区域。",
    options: [
      { id: "auto", label: "自动（按环境变量）" },
      { id: "openai", label: "OpenAI 兼容 / Kokoro" },
      { id: "azure", label: "Azure Neural" },
      { id: "browser", label: "浏览器语音合成" },
    ],
    fields: ["baseUrl", "model", "voice", "region"],
  },
  asr: {
    label: "语音转写 ASR",
    hint: "关闭后使用浏览器 Web Speech；没有 ASR 时录音与回放仍可用，但不会自动评分。",
    options: [
      { id: "auto", label: "自动（按环境变量）" },
      { id: "openai", label: "OpenAI 兼容 Whisper" },
      { id: "browser", label: "浏览器 Web Speech" },
      { id: "none", label: "关闭" },
    ],
    fields: ["baseUrl", "model"],
  },
  pronunciation: {
    label: "发音评测（P 维度）",
    hint: "未配置时 P 维度标为 not_assessed，总分不显示——不会用转写猜发音。腾讯云填 Secret ID（API 密钥页的 SecretId）+ API Key（SecretKey）。",
    options: [
      { id: "auto", label: "自动（按环境变量）" },
      { id: "azure", label: "Azure Pronunciation Assessment" },
      { id: "tencent-soe", label: "腾讯云智聆口语评测（国内直连）" },
      { id: "none", label: "关闭" },
    ],
    fields: ["region", "secretId"],
  },
};

const KEYS: ProviderKey[] = ["llm", "tts", "asr", "pronunciation"];

function toDrafts(c: Cfg): Drafts {
  const one = (p: Prov): Draft => ({
    enabled: p.enabled, provider: p.provider,
    baseUrl: p.baseUrl ?? "", model: p.model ?? "", secretId: p.secretId ?? "", voice: p.voice ?? "", region: p.region ?? "",
    temperature: p.temperature !== undefined ? String(p.temperature) : "",
    maxTokens: p.maxTokens !== undefined ? String(p.maxTokens) : "",
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
      if (!r.ok) throw new Error(j.error || "加载失败");
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
        const temp = Number(d.temperature);
        const tokens = Number(d.maxTokens);
        patch[k] = {
          enabled: d.enabled,
          provider: d.provider,
          baseUrl: d.baseUrl, model: d.model, secretId: d.secretId, voice: d.voice, region: d.region,
          ...(k === "llm" && d.temperature.trim() && Number.isFinite(temp) ? { temperature: temp } : {}),
          ...(k === "llm" && d.maxTokens.trim() && Number.isFinite(tokens) ? { maxTokens: tokens } : {}),
          ...(d.apiKey.trim() ? { apiKey: d.apiKey.trim() } : {}),
          ...(d.clearKey ? { clearKey: true } : {}),
        };
      }
      const r = await fetch("/api/admin/ai", { method: "PUT", headers: headers(), body: JSON.stringify(patch) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "保存失败");
      setCfg(j.config as Cfg);
      setDraft(toDrafts(j.config as Cfg));
      setMsg("已保存，下一次请求立即生效（无需重启）。");
    } catch (e) {
      setMsg(`保存失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (err) return <Card className="p-5 text-sm text-red-600">AI 配置加载失败：{err}</Card>;
  if (!cfg || !draft) return <Card className="p-5 text-sm text-zinc-400">加载 AI 配置…</Card>;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">AI 服务（评分 / 语音 / 转写）</h2>
          <p className="mt-1 text-xs leading-5 text-zinc-500">
            保存后立即生效。密钥只存在服务器（{cfg.path}），接口只回传掩码，永远不会发到浏览器。
            「自动」表示沿用环境变量；显式选择后以这里为准。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {cfg.fileExists ? <Badge tone="green">已配置</Badge> : <Badge tone="amber">未配置（走环境变量）</Badge>}
          <button onClick={save} disabled={busy} className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
            {busy ? "保存中…" : "保存"}
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
                  启用
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
                    {f === "baseUrl" ? "Base URL" : f === "model" ? "Model" : f === "voice" ? "Voice" : f === "temperature" ? "Temperature (0–2)" : f === "maxTokens" ? "Max tokens" : f === "secretId" ? "Secret ID（腾讯云）" : "Region"}
                    <input
                      value={d[f] as string}
                      onChange={(e) => set(k, { [f]: e.target.value } as Partial<Draft>)}
                      placeholder={f === "baseUrl" ? "https://api.openai.com/v1" : f === "model" ? "gpt-4o-mini" : f === "voice" ? "en-GB-SoniaNeural" : f === "temperature" ? "0.2" : f === "maxTokens" ? "2500" : f === "secretId" ? "SecretId" : "eastus"}
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
                  placeholder={d.hasKey ? `已保存 ${d.keyHint}（留空不修改）` : "未设置"}
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-sm"
                />
              </label>
              {d.hasKey && (
                <label className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-500">
                  <input type="checkbox" checked={d.clearKey} onChange={(e) => set(k, { clearKey: e.target.checked })} />
                  清除已保存的 key
                </label>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
