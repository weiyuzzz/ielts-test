/**
 * Runtime AI provider configuration, editable from /admin.
 *
 * Why a JSON sidecar instead of a DB table: the provider registry
 * (`getLLM/getTTS/getASR`) is SYNCHRONOUS and called from ~15 server paths.
 * Reading a small JSON file synchronously (with an mtime cache) lets the admin
 * UI change providers at runtime without turning the whole registry async or
 * adding a schema migration.
 *
 * Precedence: this file overrides environment variables for the fields it sets.
 * With no file present, behaviour is exactly the previous env-only behaviour.
 *
 * Limitations (documented, not hidden):
 *  - The file is per-instance. Multiple instances each need the same file/volume,
 *    or a restart after editing.
 *  - API keys are stored in the file. It lives under `storage/` (gitignored) and
 *    is never returned to the browser, but it is plaintext on disk. For
 *    production prefer environment variables (or a secrets manager) and keep the
 *    UI for toggles only.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ProviderKey = "llm" | "asr" | "tts" | "pronunciation";

export interface ProviderConfig {
  /** false → the provider is force-disabled regardless of credentials. */
  enabled: boolean;
  /** "auto" keeps the env-driven default; otherwise an explicit provider id. */
  provider: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  /** Two-credential providers (e.g. Tencent Cloud): the access-key id. */
  secretId?: string;
  voice?: string;
  region?: string;
  /** LLM only: sampling temperature 0–2 (overrides LLM_TEMPERATURE). */
  temperature?: number;
  /** LLM only: max output tokens 64–8000 (overrides LLM_MAX_TOKENS). */
  maxTokens?: number;
}

export interface AiConfig {
  llm: ProviderConfig;
  asr: ProviderConfig;
  tts: ProviderConfig;
  pronunciation: ProviderConfig;
  updatedAt?: string;
}

export interface PublicProviderConfig extends Omit<ProviderConfig, "apiKey"> {
  hasKey: boolean;
  keyHint: string | null;
}

export interface PublicAiConfig {
  llm: PublicProviderConfig;
  asr: PublicProviderConfig;
  tts: PublicProviderConfig;
  pronunciation: PublicProviderConfig;
  updatedAt: string | null;
  path: string;
  fileExists: boolean;
  warnings: string[];
}

const DEFAULTS: AiConfig = {
  llm: { enabled: true, provider: "auto" },
  asr: { enabled: true, provider: "auto" },
  tts: { enabled: true, provider: "auto" },
  pronunciation: { enabled: true, provider: "auto" },
};

const PROVIDER_IDS: Record<ProviderKey, string[]> = {
  llm: ["auto", "openai", "deepseek", "qwen", "gemini", "anthropic", "none"],
  asr: ["auto", "openai", "browser", "none"],
  tts: ["auto", "openai", "azure", "browser"],
  pronunciation: ["auto", "azure", "tencent-soe", "none"],
};

export function configPath(): string {
  return process.env.AI_CONFIG_PATH?.trim() || path.join(process.cwd(), "storage", "ai-config.json");
}

let cache: { path: string; mtimeMs: number; cfg: AiConfig } | null = null;

function sanitizeProvider(key: ProviderKey, raw: unknown): ProviderConfig {
  const base = { ...DEFAULTS[key] };
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max = 300) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const num = (v: unknown, lo: number, hi: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined;
  };
  const provider = str(r.provider, 40);
  const out: ProviderConfig = {
    enabled: r.enabled !== false,
    provider: provider && PROVIDER_IDS[key].includes(provider) ? provider : base.provider,
  };
  const baseUrl = str(r.baseUrl, 400);
  const model = str(r.model, 120);
  const apiKey = str(r.apiKey, 500);
  const secretId = str(r.secretId, 200);
  const voice = str(r.voice, 120);
  const region = str(r.region, 60);
  if (baseUrl) out.baseUrl = baseUrl;
  if (model) out.model = model;
  if (apiKey) out.apiKey = apiKey;
  if (secretId) out.secretId = secretId;
  if (voice) out.voice = voice;
  if (region) out.region = region;
  if (key === "llm") {
    const temperature = num(r.temperature, 0, 2);
    const maxTokens = num(r.maxTokens, 64, 8000);
    if (temperature !== undefined) out.temperature = temperature;
    if (maxTokens !== undefined) out.maxTokens = Math.floor(maxTokens);
  }
  return out;
}

function sanitize(raw: unknown): AiConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const cfg: AiConfig = {
    llm: sanitizeProvider("llm", r.llm),
    asr: sanitizeProvider("asr", r.asr),
    tts: sanitizeProvider("tts", r.tts),
    pronunciation: sanitizeProvider("pronunciation", r.pronunciation),
  };
  if (typeof r.updatedAt === "string") cfg.updatedAt = r.updatedAt;
  return cfg;
}

/** Read the config file. Missing file → env-driven defaults. Never throws. */
export function readAiConfig(): AiConfig {
  const file = configPath();
  try {
    if (!existsSync(file)) { cache = null; return cloneDefaults(); }
    const { mtimeMs } = statSync(file);
    // Cache key includes the path: AI_CONFIG_PATH can differ between tests/instances.
    if (cache && cache.path === file && cache.mtimeMs === mtimeMs) return cache.cfg;
    const cfg = sanitize(JSON.parse(readFileSync(file, "utf8")));
    cache = { path: file, mtimeMs, cfg };
    return cfg;
  } catch {
    return cloneDefaults();
  }
}

function cloneDefaults(): AiConfig {
  return {
    llm: { ...DEFAULTS.llm }, asr: { ...DEFAULTS.asr },
    tts: { ...DEFAULTS.tts }, pronunciation: { ...DEFAULTS.pronunciation },
  };
}

export interface AiConfigPatch {
  llm?: Partial<ProviderConfig> & { clearKey?: boolean };
  asr?: Partial<ProviderConfig> & { clearKey?: boolean };
  tts?: Partial<ProviderConfig> & { clearKey?: boolean };
  pronunciation?: Partial<ProviderConfig> & { clearKey?: boolean };
}

/**
 * Merge a patch into the current config and persist atomically.
 * An omitted/empty `apiKey` keeps the stored key; send `clearKey: true` to erase it.
 */
export function writeAiConfig(patch: AiConfigPatch): AiConfig {
  const current = readAiConfig();
  const next: AiConfig = {
    llm: mergeProvider(current.llm, patch.llm),
    asr: mergeProvider(current.asr, patch.asr),
    tts: mergeProvider(current.tts, patch.tts),
    pronunciation: mergeProvider(current.pronunciation, patch.pronunciation),
    updatedAt: new Date().toISOString(),
  };
  const file = configPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw new Error(`cannot write AI config to ${file}: ${(e as Error).message}`);
  }
  cache = null; // force re-read on next access
  return next;
}

function mergeProvider(cur: ProviderConfig, p?: Partial<ProviderConfig> & { clearKey?: boolean }): ProviderConfig {
  const out: ProviderConfig = { ...cur };
  if (!p) return out;
  if (typeof p.enabled === "boolean") out.enabled = p.enabled;
  if (typeof p.provider === "string" && p.provider.trim()) out.provider = p.provider.trim();
  for (const f of ["baseUrl", "model", "voice", "region", "secretId"] as const) {
    if (typeof p[f] === "string") {
      const v = (p[f] as string).trim();
      if (v) out[f] = v; else delete out[f];
    }
  }
  // LLM sampling overrides: valid numbers replace, everything else is ignored
  // (there is deliberately no "clear" — send the default value instead).
  if (typeof p.temperature === "number" && p.temperature >= 0 && p.temperature <= 2) out.temperature = p.temperature;
  if (typeof p.maxTokens === "number" && p.maxTokens >= 64 && p.maxTokens <= 8000) out.maxTokens = Math.floor(p.maxTokens);
  if (p.clearKey) delete out.apiKey;
  else if (typeof p.apiKey === "string" && p.apiKey.trim()) out.apiKey = p.apiKey.trim();
  return out;
}

const mask = (k?: string) => (k ? `••••${k.slice(-4)}` : null);

/** Browser-safe view: never returns the key itself. */
export function publicAiConfig(): PublicAiConfig {
  const cfg = readAiConfig();
  const file = configPath();
  const warnings: string[] = [];
  if (!existsSync(file)) {
    warnings.push("尚未保存过配置：当前完全由环境变量决定（LLM_PROVIDER / TTS_PROVIDER / ASR_PROVIDER ...）。");
  }
  const view = (p: ProviderConfig): PublicProviderConfig => ({
    enabled: p.enabled,
    provider: p.provider,
    ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
    ...(p.model ? { model: p.model } : {}),
    ...(p.secretId ? { secretId: p.secretId } : {}),
    ...(p.voice ? { voice: p.voice } : {}),
    ...(p.region ? { region: p.region } : {}),
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
    ...(p.maxTokens !== undefined ? { maxTokens: p.maxTokens } : {}),
    hasKey: !!p.apiKey,
    keyHint: mask(p.apiKey),
  });
  return {
    llm: view(cfg.llm), asr: view(cfg.asr), tts: view(cfg.tts), pronunciation: view(cfg.pronunciation),
    updatedAt: cfg.updatedAt ?? null, path: file, fileExists: existsSync(file), warnings,
  };
}

/**
 * Env overrides for one provider, or null when the config should not interfere
 * (provider "auto" and enabled → keep the env-driven default).
 */
export function envOverridesFor(cfg: AiConfig, key: ProviderKey): Record<string, string | undefined> | null {
  const sampling = (p: ProviderConfig, out: Record<string, string | undefined>) => {
    if (key === "llm" && p.temperature !== undefined) out.LLM_TEMPERATURE = String(p.temperature);
    if (key === "llm" && p.maxTokens !== undefined) out.LLM_MAX_TOKENS = String(p.maxTokens);
  };
  const p = cfg[key];
  if (p.provider === "auto" && p.enabled) {
    // Still allow credentials/model overrides while keeping provider auto-detection.
    const extra: Record<string, string | undefined> = {};
    if (p.apiKey) extra[KEY_ENV[key].apiKey] = p.apiKey;
    if (p.baseUrl) extra[KEY_ENV[key].baseUrl] = p.baseUrl;
    if (p.model) extra[KEY_ENV[key].model] = p.model;
    sampling(p, extra);
    if (key === "tts" && p.voice) extra.TTS_VOICE = p.voice;
    if (key === "tts" && p.region) extra.AZURE_SPEECH_REGION = p.region;
    if (key === "pronunciation" && p.region) extra.AZURE_SPEECH_REGION = p.region;
    return Object.keys(extra).length ? extra : null;
  }
  if (!p.enabled) {
    const off: Record<ProviderKey, Record<string, string | undefined>> = {
      llm: { LLM_PROVIDER: "none" },
      asr: { ASR_PROVIDER: "browser" },
      tts: { TTS_PROVIDER: "browser" },
      pronunciation: { PRONUNCIATION_PROVIDER: "none" },
    };
    return off[key];
  }
  const e = KEY_ENV[key];
  const out: Record<string, string | undefined> = { [e.provider]: p.provider };
  if (p.apiKey) out[e.apiKey] = p.apiKey;
  if (p.baseUrl) out[e.baseUrl] = p.baseUrl;
  if (p.model) out[e.model] = p.model;
  sampling(p, out);
  if (key === "tts") {
    if (p.voice) out.TTS_VOICE = p.voice;
    if (p.region) out.AZURE_SPEECH_REGION = p.region;
    if (p.provider === "azure" && p.apiKey) out.AZURE_SPEECH_KEY = p.apiKey;
  }
  if (key === "pronunciation" && p.provider === "azure") {
    if (p.apiKey) out.AZURE_SPEECH_KEY = p.apiKey;
    if (p.region) out.AZURE_SPEECH_REGION = p.region;
  }
  if (key === "pronunciation" && p.provider === "tencent-soe") {
    if (p.secretId) out.TENCENT_SECRET_ID = p.secretId;
    if (p.apiKey) out.TENCENT_SECRET_KEY = p.apiKey;
    if (p.region) out.TENCENT_SOE_REGION = p.region;
  }
  if (key === "tts" && p.provider === "azure" && p.region) out.AZURE_SPEECH_REGION = p.region;
  return out;
}

const KEY_ENV: Record<ProviderKey, { provider: string; apiKey: string; baseUrl: string; model: string }> = {
  llm: { provider: "LLM_PROVIDER", apiKey: "LLM_API_KEY", baseUrl: "LLM_BASE_URL", model: "LLM_MODEL" },
  asr: { provider: "ASR_PROVIDER", apiKey: "ASR_API_KEY", baseUrl: "ASR_BASE_URL", model: "ASR_MODEL" },
  tts: { provider: "TTS_PROVIDER", apiKey: "TTS_API_KEY", baseUrl: "TTS_BASE_URL", model: "TTS_MODEL" },
  pronunciation: { provider: "PRONUNCIATION_PROVIDER", apiKey: "AZURE_SPEECH_KEY", baseUrl: "AZURE_SPEECH_REGION", model: "AZURE_TTS_VOICE" },
};

/** Run `fn` with temporary env overrides, restoring them afterwards (synchronous only). */
export function withEnvOverrides<T>(overrides: Record<string, string | undefined> | null, fn: () => T): T {
  if (!overrides) return fn();
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(overrides)) {
    prev.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
