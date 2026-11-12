/**
 * Tencent Cloud ASR (录音文件识别) as an ASRProvider, via the official SDK
 * (tencentcloud-sdk-nodejs-asr) — standard TC3-signed Cloud API:
 * CreateRecTask + DescribeTaskStatus polling.
 *
 * Chosen over the region-blocked Groq endpoint and over the legacy "flash"
 * endpoint (whose hand-rolled signature produced an opaque server-side
 * "Credential scope size not valid" error): the official client removes the
 * signature guesswork entirely, accepts up to 5 hours of audio inline (base64
 * ≤ ~5 MB — a 2-minute 16 kHz WAV is 3.84 MB raw), and with ResTextFormat=2
 * returns word-level timestamps (ResultDetail[].Words: {Word, OffsetStartMs,
 * OffsetEndMs} in ms) — exactly what the fluency-evidence pipeline and the
 * SOE audio-slicing need.
 *
 * Docs: cloud.tencent.com/document/product/1093/37823 (CreateRecTask),
 * 1093/37822 (DescribeTaskStatus), Version 2019-06-14.
 */
import { ProviderError, type ASRProvider, type ASRResult } from "./types";
import type { WordTiming } from "@/db/schema";

const POLL_INTERVAL_MS = 1200;
const POLL_DEADLINE_MS = 40_000;

export interface TencentAsrOptions {
  secretId?: string;
  secretKey?: string;
  region?: string;
  /** Engine model, e.g. 16k_en (English) / 16k_zh. */
  engine?: string;
  /** Test hook: supplies a pre-built SDK-shaped client instead of the real one. */
  clientFactory?: () => AsrSdkClient;
}

export interface AsrSdkClient {
  CreateRecTask(req: Record<string, unknown>): Promise<{ Data?: { TaskId?: number } }>;
  DescribeTaskStatus(req: Record<string, unknown>): Promise<{ Data?: TaskDetail }>;
}

interface WordDetail {
  Word?: string;
  OffsetStartMs?: number;
  OffsetEndMs?: number;
}

export interface TaskDetail {
  TaskId?: number;
  Status?: number;
  StatusStr?: string;
  Text?: string;
  ErrorMsg?: string;
  ResultDetail?: { FinalSentence?: string; Words?: WordDetail[] }[];
  Words?: WordDetail[];
}

interface CreateRecTaskResult {
  Data?: { TaskId?: number };
}

async function defaultClient(creds: { secretId: string; secretKey: string; region: string }): Promise<AsrSdkClient> {
  // Lazy require so the SDK stays a runtime dependency only of this provider.
  const sdk = await import("tencentcloud-sdk-nodejs-asr");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AsrClient = (sdk as any).asr.v20190614.Client;
  return new AsrClient({
    credential: { secretId: creds.secretId, secretKey: creds.secretKey },
    region: creds.region,
    profile: { httpProfile: { endpoint: "asr.tencentcloudapi.com" } },
  }) as AsrSdkClient;
}

export function tencentAsr(opts: TencentAsrOptions = {}): ASRProvider {
  const secretId = opts.secretId || process.env.TENCENT_SECRET_ID || "";
  const secretKey = opts.secretKey || process.env.TENCENT_SECRET_KEY || "";
  const region = opts.region || process.env.TENCENT_ASR_REGION || "ap-guangzhou";
  const engine = opts.engine || process.env.TENCENT_ASR_ENGINE || "16k_en";
  return {
    id: "tencent-asr",
    model: engine,
    location: "server",
    async transcribe(audio, mimeType, transcribeOpts): Promise<ASRResult> {
      if (!secretId || !secretKey) {
        throw new ProviderError("tencent-asr", "config", "missing TENCENT_SECRET_ID / TENCENT_SECRET_KEY");
      }
      const data = audio.toString("base64");
      if (data.length > 5 * 1024 * 1024) {
        throw new ProviderError("tencent-asr", "unsupported", `inline audio exceeds the 5 MB CreateRecTask limit (got ${Math.round(data.length / 1048576)} MB base64)`);
      }
      const client = opts.clientFactory ? opts.clientFactory() : await defaultClient({ secretId, secretKey, region });
      const created = (await client.CreateRecTask({
        EngineModelType: engine,
        ChannelNum: 1,
        ResTextFormat: 2, // word-level timestamps + punctuation
        SourceType: 1,
        Data: data,
      })) as CreateRecTaskResult;
      const taskId = created.Data?.TaskId;
      if (typeof taskId !== "number") {
        throw new ProviderError("tencent-asr", "invalid_response", "no TaskId returned");
      }

      // Poll until success/failure or deadline (report-service wraps this in
      // the ASR timeout, so stay comfortably under 45 s).
      const deadline = Date.now() + POLL_DEADLINE_MS;
      let detail: TaskDetail | null = null;
      while (Date.now() < deadline) {
        if (transcribeOpts?.signal?.aborted) throw new ProviderError("tencent-asr", "timeout", "aborted");
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const status = (await client.DescribeTaskStatus({ TaskId: taskId })) as { Data?: TaskDetail };
        detail = status.Data ?? null;
        if (detail && (detail.Status === 2 || detail.Status === 3)) break;
      }
      if (!detail) throw new ProviderError("tencent-asr", "timeout", "no task status received in time");
      if (detail.Status === 3) {
        throw new ProviderError("tencent-asr", "invalid_response", `task failed: ${(detail.ErrorMsg || detail.StatusStr || "unknown").slice(0, 200)}`);
      }
      if (detail.Status !== 2) throw new ProviderError("tencent-asr", "timeout", "recognition did not finish in time");

      const text = (detail.Text ?? "").trim();
      const wordDetails = detail.Words ?? detail.ResultDetail?.flatMap((s) => s.Words ?? []) ?? [];
      const words: WordTiming[] = wordDetails
        .filter((w) => typeof w.Word === "string" && w.Word.trim() && Number.isFinite(w.OffsetStartMs) && Number.isFinite(w.OffsetEndMs))
        .map((w) => ({
          word: w.Word!.trim().toLowerCase(),
          start: Math.max(0, Math.round(w.OffsetStartMs!)) / 1000,
          end: Math.round(w.OffsetEndMs!) / 1000,
        }))
        .filter((w) => w.end >= w.start);
      return { text, words: words.length ? words : undefined, language: "en" };
    },
  };
}
