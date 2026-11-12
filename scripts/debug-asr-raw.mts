/** Debug: raw CreateRecTask response inspection. */
import fs from "node:fs";
import { tc3Authorization } from "../src/lib/ai/tencent-soe";

const cfg = JSON.parse(fs.readFileSync("C:/Users/L/WorkBuddy AI/ielts-test/storage/ai-config.json", "utf8")).asr;
const body = JSON.stringify({
  EngineModelType: "16k_en",
  ChannelNum: 1,
  ResTextFormat: 2,
  SourceType: 0,
  Url: "https://example.com/nonexistent.wav",
});
const ts = Math.floor(Date.now() / 1000);
const region = cfg.region || "ap-shanghai";
const res = await fetch("https://asr.tencentcloudapi.com", {
  method: "POST",
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    Host: "asr.tencentcloudapi.com",
    "X-TC-Action": "CreateRecTask",
    "X-TC-Version": "2019-06-14",
    "X-TC-Region": region,
    "X-TC-Timestamp": String(ts),
    Authorization: tc3Authorization({
      secretId: cfg.secretId, secretKey: cfg.apiKey,
      host: "asr.tencentcloudapi.com", service: "asr", region,
      action: "CreateRecTask", timestamp: ts, body,
    }),
  },
  body,
});
console.log("HTTP", res.status);
console.log((await res.text()).slice(0, 600));
process.exit(0);
