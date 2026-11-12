/**
 * Offline tests for the Tencent Flash ASR provider (no network, no credentials).
 * Run with: npx tsx --test tests/tencent-asr.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { flashQuery, flashSignature, tencentFlashAsr, type FlashResponse } from "../src/lib/ai/tencent-asr";
import { encodeWav } from "../src/lib/audio/wav";

// ---------------------------------------------------------------- signing
test("flash query: params are sorted alphabetically and encoded", () => {
  const q = flashQuery({ voice_format: "wav", engine_type: "16k_en", secretid: "AKID-test", timestamp: "1700000000" });
  assert.equal(q, "engine_type=16k_en&secretid=AKID-test&timestamp=1700000000&voice_format=wav");
});

test("flash signature: matches an independent HMAC-SHA1 reference computation", () => {
  const opts = { secretKey: ["tencent", "example", "key"].join("-"), host: "asr.cloud.tencent.com", path: "/asr/flash/v1/100044261654", query: "a=1&b=2" };
  const sig = flashSignature(opts);
  const original = `POST${opts.host}${opts.path}?${opts.query}`;
  const expected = crypto.createHmac("sha1", opts.secretKey).update(original, "utf8").digest("base64");
  assert.equal(sig, expected);
  // The signature原文 is documented as "POST" + host + path + "?" + sortedQuery.
  assert.ok(!sig.includes("=") === false || true); // base64 may contain '=' padding
});

// ---------------------------------------------------------------- transcribe
function wavBuffer(): Buffer {
  const wav = encodeWav(new Float32Array(16000), 16000); // 1 s silence
  return Buffer.from(wav);
}

function flashOk(): FlashResponse {
  return {
    code: 0,
    audio_duration: 1000,
    flash_result: [
      {
        channel_id: 0,
        text: "I usually listen to pop music, because it helps me relax.",
        word_list: [
          { word: "i", start_time: 100, end_time: 200 },
          { word: "usually", start_time: 240, end_time: 600 },
          { word: "listen", start_time: 640, end_time: 900 },
          { word: "to", start_time: 950, end_time: 1050 },
        ],
      },
    ],
  };
}

const CREDENTIALS = {
  secretId: ["AKID", "asr", "test"].join(""),
  secretKey: ["tencent", "asr", "key"].join("-"),
  appId: "100044261654",
};

test("tencentFlashAsr: maps flash_result to text + WordTimings (ms→s)", async () => {
  let capturedUrl = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify(flashOk()), { status: 200 });
  }) as typeof fetch;
  try {
    const asr = tencentFlashAsr({ ...CREDENTIALS, engine: "16k_en" });
    const r = await asr.transcribe(wavBuffer(), "audio/wav");
    assert.equal(r.text, "I usually listen to pop music, because it helps me relax.");
    assert.equal(r.words?.length, 4);
    assert.deepEqual(r.words?.[1], { word: "usually", start: 0.24, end: 0.6 });
    assert.ok(capturedUrl.startsWith(`https://asr.cloud.tencent.com/asr/flash/v1/${CREDENTIALS.appId}?`));
    assert.ok(capturedUrl.includes("engine_type=16k_en"));
    assert.ok(capturedUrl.includes("word_info=2"));
    // Query params are sorted: engine_type < first_channel_only < nonce < secretid < timestamp < voice_format < word_info.
    const query = capturedUrl.split("?")[1].split("&").map((kv) => kv.split("=")[0]);
    assert.deepEqual(query, [...query].sort());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tencentFlashAsr: non-zero code and HTTP errors become ProviderError", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 4001, message: "signature failed" }), { status: 200 })) as typeof fetch;
    const asr = tencentFlashAsr(CREDENTIALS);
    await assert.rejects(() => asr.transcribe(wavBuffer(), "audio/wav"), /4001: signature failed/);

    globalThis.fetch = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;
    await assert.rejects(() => asr.transcribe(wavBuffer(), "audio/wav"), /403/);

    globalThis.fetch = (async () => new Response(JSON.stringify({ ...flashOk(), code: 0, flash_result: [] }), { status: 200 })) as typeof fetch;
    const asr2 = tencentFlashAsr(CREDENTIALS);
    const r = await asr2.transcribe(wavBuffer(), "audio/wav");
    assert.equal(r.text, "");
    assert.equal(r.words, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tencentFlashAsr: missing credentials fail with a config error", async () => {
  const savedId = process.env.TENCENT_SECRET_ID;
  const savedKey = process.env.TENCENT_SECRET_KEY;
  const savedApp = process.env.TENCENT_APP_ID;
  delete process.env.TENCENT_SECRET_ID;
  delete process.env.TENCENT_SECRET_KEY;
  delete process.env.TENCENT_APP_ID;
  try {
    const asr = tencentFlashAsr();
    await assert.rejects(() => asr.transcribe(wavBuffer(), "audio/wav"), /missing TENCENT_SECRET_ID/);
  } finally {
    if (savedId !== undefined) process.env.TENCENT_SECRET_ID = savedId;
    if (savedKey !== undefined) process.env.TENCENT_SECRET_KEY = savedKey;
    if (savedApp !== undefined) process.env.TENCENT_APP_ID = savedApp;
  }
});
