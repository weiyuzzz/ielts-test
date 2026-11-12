/** Real-call verification for the Tencent ASR provider (uses prod sidecar creds). */
import fs from "node:fs";
import { tencentAsr } from "../src/lib/ai/tencent-asr";
import { encodeWav } from "../src/lib/audio/wav";

const sidecar = JSON.parse(fs.readFileSync("C:/Users/L/WorkBuddy AI/ielts-test/storage/ai-config.json", "utf8"));
const asr = sidecar.asr;
if (!asr.secretId || !asr.apiKey || !asr.appId) {
  console.log("MISSING_CONFIG", JSON.stringify({ secretId: !!asr.secretId, key: !!asr.apiKey, appId: !!asr.appId }));
  process.exit(0);
}

// 2-minute 16 kHz mono tone — 3.84 MB raw / ~5.1 MB base64, probing the
// documented 5 MB inline limit with a real CreateRecTask submission.
const rate = 16000;
const dur = 120;
const samples = new Float32Array(rate * dur);
for (let i = 0; i < samples.length; i++) samples[i] = 0.15 * Math.sin((2 * Math.PI * 220 * i) / rate);
const wav = Buffer.from(encodeWav(samples, rate));
console.log(`submitting ${(wav.length / 1048576).toFixed(2)} MB raw (${(wav.toString("base64").length / 1048576).toFixed(2)} MB base64), engine=${asr.model ?? "16k_en"} …`);

const asrProvider = tencentAsr({
  secretId: asr.secretId,
  secretKey: asr.apiKey,
  region: asr.region || "ap-guangzhou",
  engine: asr.model || "16k_en",
});
const t0 = Date.now();
try {
  const r = await asrProvider.transcribe(wav, "audio/wav");
  console.log(`SUCCESS in ${((Date.now() - t0) / 1000).toFixed(1)}s: text="${(r.text || "(empty — expected for a pure tone)").slice(0, 80)}" words=${r.words?.length ?? 0}`);
} catch (e) {
  console.log(`FAIL in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${(e as Error).message.slice(0, 300)}`);
}
process.exit(0);
