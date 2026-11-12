/**
 * Offline tests for the Tencent Cloud ASR provider (CreateRecTask + polling;
 * no network, no credentials). Run with: npx tsx --test tests/tencent-asr.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tencentAsr, type AsrSdkClient, type TaskDetail } from "../src/lib/ai/tencent-asr";
import { encodeWav } from "../src/lib/audio/wav";

const CREDENTIALS = {
  secretId: ["AKID", "asr", "test"].join(""),
  secretKey: ["tencent", "asr", "key"].join("-"),
  region: "ap-guangzhou",
};

function wavBuffer(): Buffer {
  return Buffer.from(encodeWav(new Float32Array(16000), 16000)); // 1 s silence
}

interface CapturedRequest {
  action: string;
  body: Record<string, unknown>;
}

/** Fake SDK client: scripted responses per Action, capturing requests. */
function stubClient(
  script: Map<string, unknown[]>,
  captured: CapturedRequest[],
): AsrSdkClient {
  return {
    async CreateRecTask(req) {
      captured.push({ action: "CreateRecTask", body: req });
      const next = script.get("CreateRecTask")?.shift();
      if (next === undefined) throw new Error("unexpected CreateRecTask call");
      return next as { Data?: { TaskId?: number } };
    },
    async DescribeTaskStatus(req) {
      captured.push({ action: "DescribeTaskStatus", body: req });
      const next = script.get("DescribeTaskStatus")?.shift();
      if (next === undefined) throw new Error("unexpected DescribeTaskStatus call");
      return next as { Data?: TaskDetail };
    },
  };
}

test("tencentAsr: submits an inline task, polls to success, maps word timings", async () => {
  const captured: CapturedRequest[] = [];
  const script = new Map<string, unknown[]>([
    ["CreateRecTask", [{ Data: { TaskId: 12345 } }]],
    ["DescribeTaskStatus", [
      { Data: { TaskId: 12345, Status: 1, StatusStr: "doing" } },
      { Data: {
        TaskId: 12345, Status: 2, StatusStr: "success",
        Text: "I usually listen to pop music, because it helps me relax.",
        ResultDetail: [{
          FinalSentence: "I usually listen to pop music, because it helps me relax.",
          Words: [
            { Word: "i", OffsetStartMs: 100, OffsetEndMs: 200 },
            { Word: "usually", OffsetStartMs: 240, OffsetEndMs: 600 },
            { Word: "listen", OffsetStartMs: 640, OffsetEndMs: 900 },
          ],
        }],
      } },
    ]],
  ]);
  const asr = tencentAsr({ ...CREDENTIALS, engine: "16k_en", clientFactory: () => stubClient(script, captured) });
  const r = await asr.transcribe(wavBuffer(), "audio/wav");
  assert.equal(r.text, "I usually listen to pop music, because it helps me relax.");
  assert.deepEqual(r.words?.[1], { word: "usually", start: 0.24, end: 0.6 });
  assert.equal(r.language, "en");

  const create = captured.find((c) => c.action === "CreateRecTask")!;
  assert.equal(create.body.EngineModelType, "16k_en");
  assert.equal(create.body.ChannelNum, 1);
  assert.equal(create.body.ResTextFormat, 2, "ResTextFormat=2 → word timestamps + punctuation");
  assert.equal(create.body.SourceType, 1, "inline base64 submission");
  assert.ok(typeof create.body.Data === "string" && (create.body.Data as string).length > 0);
});

test("tencentAsr: failed task surfaces the server error message", async () => {
  const script = new Map<string, unknown[]>([
    ["CreateRecTask", [{ Data: { TaskId: 99 } }]],
    ["DescribeTaskStatus", [{ Data: { TaskId: 99, Status: 3, StatusStr: "failed", ErrorMsg: "audio decode failed" } }]],
  ]);
  const asr = tencentAsr({ ...CREDENTIALS, clientFactory: () => stubClient(script, []) });
  await assert.rejects(() => asr.transcribe(wavBuffer(), "audio/wav"), /task failed: audio decode failed/);
});

test("tencentAsr: empty top-level Text falls back to ResultDetail sentences", async () => {
  const script = new Map<string, unknown[]>([
    ["CreateRecTask", [{ Data: { TaskId: 55 } }]],
    ["DescribeTaskStatus", [{ Data: {
      TaskId: 55, Status: 2, Text: "",
      ResultDetail: [
        { FinalSentence: "I usually listen to pop music.", Words: [{ Word: "i", OffsetStartMs: 100, OffsetEndMs: 200 }] },
        { FinalSentence: "It helps me relax.", Words: [{ Word: "it", OffsetStartMs: 300, OffsetEndMs: 400 }] },
      ],
    } }]],
  ]);
  const asr = tencentAsr({ ...CREDENTIALS, clientFactory: () => stubClient(script, []) });
  const r = await asr.transcribe(wavBuffer(), "audio/wav");
  assert.equal(r.text, "I usually listen to pop music. It helps me relax.");
  assert.equal(r.words?.length, 2);
});

test("tencentAsr: aborts promptly instead of polling forever", async () => {
  const script = new Map<string, unknown[]>([
    ["CreateRecTask", [{ Data: { TaskId: 7 } }]],
    ["DescribeTaskStatus", [{ Data: { TaskId: 7, Status: 1 } }]],
  ]);
  const asr = tencentAsr({ ...CREDENTIALS, clientFactory: () => stubClient(script, []) });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 150);
  await assert.rejects(
    () => asr.transcribe(wavBuffer(), "audio/wav", { signal: ctrl.signal }),
    /aborted|timeout/,
  );
  clearTimeout(t);
});

test("tencentAsr: oversize inline audio fails fast with an explicit error", async () => {
  const asr = tencentAsr({ ...CREDENTIALS, clientFactory: () => stubClient(new Map(), []) });
  await assert.rejects(() => asr.transcribe(Buffer.alloc(5 * 1024 * 1024 + 100), "audio/wav"), /5 MB/);
});

test("tencentAsr: missing credentials fail with a config error", async () => {
  const saved = [process.env.TENCENT_SECRET_ID, process.env.TENCENT_SECRET_KEY];
  delete process.env.TENCENT_SECRET_ID;
  delete process.env.TENCENT_SECRET_KEY;
  try {
    const asr = tencentAsr();
    await assert.rejects(() => asr.transcribe(wavBuffer(), "audio/wav"), /missing TENCENT_SECRET_ID/);
  } finally {
    if (saved[0] !== undefined) process.env.TENCENT_SECRET_ID = saved[0];
    if (saved[1] !== undefined) process.env.TENCENT_SECRET_KEY = saved[1];
  }
});
