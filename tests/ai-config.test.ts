/**
 * Runtime AI configuration tests (/admin → AI 服务).
 *
 * Run with: npx tsx --test tests/ai-config.test.ts
 *
 * Uses a temp AI_CONFIG_PATH, so the developer's real config is never touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  readAiConfig, writeAiConfig, publicAiConfig, envOverridesFor, configPath,
} from "../src/lib/server/ai-config";

async function withConfigFile<T>(fn: (file: string) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "b9-ai-"));
  const prev = process.env.AI_CONFIG_PATH;
  const file = path.join(dir, "ai-config.json");
  process.env.AI_CONFIG_PATH = file;
  try {
    return await fn(file);
  } finally {
    if (prev === undefined) delete process.env.AI_CONFIG_PATH;
    else process.env.AI_CONFIG_PATH = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("ai-config: no file → env-driven defaults, nothing disabled", async () => {
  await withConfigFile(() => {
    assert.equal(configPath().endsWith("ai-config.json"), true);
    const cfg = readAiConfig();
    for (const k of ["llm", "asr", "tts", "pronunciation"] as const) {
      assert.equal(cfg[k].enabled, true, `${k} must default to enabled`);
      assert.equal(cfg[k].provider, "auto", `${k} must default to auto`);
    }
    // auto + enabled → the registry keeps its env behaviour (no override).
    assert.equal(envOverridesFor(cfg, "llm"), null);
  });
});

test("ai-config: write persists atomically and round-trips", async () => {
  await withConfigFile(async (file) => {
    writeAiConfig({
      llm: { enabled: true, provider: "openai", baseUrl: "https://api.example.com/v1", model: "gpt-4o-mini", apiKey: "sk-abcdefgh1234" },
    });
    assert.equal(existsSync(file), true);
    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.llm.model, "gpt-4o-mini");
    assert.equal(raw.llm.apiKey, "sk-abcdefgh1234");

    const cfg = readAiConfig();
    assert.equal(cfg.llm.provider, "openai");
    assert.equal(cfg.llm.baseUrl, "https://api.example.com/v1");
    assert.equal(cfg.llm.apiKey, "sk-abcdefgh1234");
  });
});

test("ai-config: an empty apiKey keeps the stored key; clearKey erases it", async () => {
  await withConfigFile(() => {
    writeAiConfig({ llm: { enabled: true, provider: "openai", apiKey: "sk-keep-me-9999" } });
    writeAiConfig({ llm: { model: "gpt-4o" } }); // no apiKey field → keep
    assert.equal(readAiConfig().llm.apiKey, "sk-keep-me-9999");
    assert.equal(readAiConfig().llm.model, "gpt-4o");

    writeAiConfig({ llm: { clearKey: true } });
    assert.equal(readAiConfig().llm.apiKey, undefined);
  });
});

test("ai-config: the public view never exposes the key", async () => {
  await withConfigFile(() => {
    writeAiConfig({ llm: { enabled: true, provider: "openai", apiKey: "sk-supersecret-4321" } });
    const pub = publicAiConfig();
    assert.equal(pub.llm.hasKey, true);
    assert.equal(pub.llm.keyHint, "••••4321");
    const serialised = JSON.stringify(pub);
    assert.equal(serialised.includes("sk-supersecret-4321"), false, "raw key must not be serialised");
    assert.equal("apiKey" in pub.llm, false);
  });
});

test("ai-config: disabling a provider forces it off regardless of credentials", async () => {
  await withConfigFile(() => {
    writeAiConfig({
      llm: { enabled: false, apiKey: "sk-should-be-ignored" },
      asr: { enabled: false },
      tts: { enabled: false },
      pronunciation: { enabled: false },
    });
    const cfg = readAiConfig();
    assert.deepEqual(envOverridesFor(cfg, "llm"), { LLM_PROVIDER: "none" });
    assert.deepEqual(envOverridesFor(cfg, "asr"), { ASR_PROVIDER: "browser" });
    assert.deepEqual(envOverridesFor(cfg, "tts"), { TTS_PROVIDER: "browser" });
    assert.deepEqual(envOverridesFor(cfg, "pronunciation"), { PRONUNCIATION_PROVIDER: "none" });
  });
});

test("ai-config: explicit provider maps to the right env vars", async () => {
  await withConfigFile(() => {
    writeAiConfig({
      tts: { enabled: true, provider: "azure", apiKey: "az-key-1", region: "eastus", voice: "en-GB-SoniaNeural" },
      asr: { enabled: true, provider: "openai", apiKey: "sk-asr", baseUrl: "https://asr.example.com/v1", model: "whisper-1" },
    });
    const cfg = readAiConfig();
    const tts = envOverridesFor(cfg, "tts")!;
    assert.equal(tts.TTS_PROVIDER, "azure");
    assert.equal(tts.AZURE_SPEECH_KEY, "az-key-1");
    assert.equal(tts.AZURE_SPEECH_REGION, "eastus");
    assert.equal(tts.TTS_VOICE, "en-GB-SoniaNeural");

    const asr = envOverridesFor(cfg, "asr")!;
    assert.equal(asr.ASR_PROVIDER, "openai");
    assert.equal(asr.ASR_API_KEY, "sk-asr");
    assert.equal(asr.ASR_BASE_URL, "https://asr.example.com/v1");
    assert.equal(asr.ASR_MODEL, "whisper-1");
  });
});

test("ai-config: unknown providers and junk values are sanitised, not trusted", async () => {
  await withConfigFile(async (file) => {
    const fs = await import("node:fs/promises");
    await fs.writeFile(file, JSON.stringify({
      llm: { enabled: true, provider: "definitely-not-a-provider", apiKey: 12345, model: "" },
      tts: "not-an-object",
    }), "utf8");
    const cfg = readAiConfig();
    assert.equal(cfg.llm.provider, "auto", "unknown provider falls back to auto");
    assert.equal(cfg.llm.apiKey, undefined, "non-string key is dropped");
    assert.equal(cfg.tts.provider, "auto", "malformed section falls back to defaults");
  });
});

test("ai-config: a corrupt file degrades to env defaults instead of crashing", async () => {
  await withConfigFile(async (file) => {
    const fs = await import("node:fs/promises");
    await fs.writeFile(file, "{ this is not json", "utf8");
    const cfg = readAiConfig();
    assert.equal(cfg.llm.provider, "auto");
    assert.equal(cfg.llm.enabled, true);
  });
});
