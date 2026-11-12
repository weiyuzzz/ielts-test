/**
 * Tencent Cloud Flash Recognition (录音文件识别极速版) as an ASRProvider.
 *
 * Chosen over the other Tencent ASR APIs because it is SYNCHRONOUS (30 min of
 * audio ≈ 10 s), takes raw audio in the POST body (≤100 MB / ≤2 h — our
 * 2-minute 16 kHz WAV fits), and returns word-level timestamps — exactly what
 * the fluency-evidence pipeline needs. It is NOT a Cloud API 3.0 endpoint:
 * params go in the query string, the body is raw audio, and auth is the
 * legacy HMAC-SHA1 signature over the sorted query string.
 *
 * Docs: cloud.tencent.com/document/product/1093/52097 (flash v1).
 * Credentials: TENCENT_SECRET_ID / TENCENT_SECRET_KEY / TENCENT_APP_ID
 * (the AppID is account-level, shared by sub-accounts).
 */
import crypto from "node:crypto";
import { ProviderError, type ASRProvider, type ASRResult } from "./types";
import type { WordTiming } from "@/db/schema";

const FLASH_HOST = "asr.cloud.tencent.com";
const FLASH_PATH_PREFIX = "/asr/flash/v1/";

export interface FlashWord {
  word: string;
  start_time: number; // ms from audio start
  end_time: number;
}

/** Build the sorted query string exactly the way the signature expects it. */
export function flashQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");
}

/** Legacy HMAC-SHA1 signature: base64(HmacSHA1(SecretKey, "POST" + host + path + "?" + sortedQuery)). */
export function flashSignature(opts: { secretKey: string; host: string; path: string; query: string }): string {
  const original = `POST${opts.host}${opts.path}?${opts.query}`;
  return crypto.createHmac("sha1", opts.secretKey).update(original, "utf8").digest("base64");
}

export interface FlashResponse {
  code: number;
  message?: string;
  request_id?: string;
  audio_duration?: number;
  flash_result?: {
    channel_id: number;
    text: string;
    word_list?: FlashWord[];
  }[];
}

export interface TencentAsrOptions {
  secretId?: string;
  secretKey?: string;
  /** Account-level AppID (console.cloud.tencent.com/developer → 账号信息). */
  appId?: string;
  /** Engine model, e.g. 16k_en (English) / 16k_zh. */
  engine?: string;
}

export function tencentFlashAsr(opts: TencentAsrOptions = {}): ASRProvider {
  const secretId = opts.secretId || process.env.TENCENT_SECRET_ID || "";
  const secretKey = opts.secretKey || process.env.TENCENT_SECRET_KEY || "";
  const appId = opts.appId || process.env.TENCENT_APP_ID || "";
  const engine = opts.engine || process.env.TENCENT_ASR_ENGINE || "16k_en";
  return {
    id: "tencent-flash-asr",
    model: engine,
    location: "server",
    async transcribe(audio, mimeType, transcribeOpts): Promise<ASRResult> {
      if (!secretId || !secretKey || !appId) {
        throw new ProviderError("tencent-flash-asr", "config", "missing TENCENT_SECRET_ID / TENCENT_SECRET_KEY / TENCENT_APP_ID");
      }
      const format = /wav/i.test(mimeType) ? "wav" : /mp3/i.test(mimeType) ? "mp3" : /m4a|mp4|aac/i.test(mimeType) ? "m4a" : /ogg/i.test(mimeType) ? "ogg-opus" : "wav";
      const params: Record<string, string> = {
        appid: appId,
        engine_type: engine,
        secretid: secretId,
        timestamp: String(Math.floor(Date.now() / 1000)),
        voice_format: format,
        word_info: "2", // word-level timestamps incl. punctuation
        first_channel_only: "1",
        nonce: String(Math.floor(Math.random() * 1_000_000_000)),
      };
      const query = flashQuery(params);
      const path = `${FLASH_PATH_PREFIX}${appId}`;
      const signature = flashSignature({ secretKey, host: FLASH_HOST, path, query });
      const res = await fetch(`https://${FLASH_HOST}${path}?${query}`, {
        method: "POST",
        headers: { Authorization: signature, "Content-Type": "audio/wav" },
        body: new Uint8Array(audio),
        signal: transcribeOpts?.signal,
      });
      const bodyText = await res.text();
      if (!res.ok) throw new ProviderError("tencent-flash-asr", "http", `${res.status} ${bodyText.slice(0, 200)}`);
      let j: FlashResponse;
      try {
        j = JSON.parse(bodyText) as FlashResponse;
      } catch {
        throw new ProviderError("tencent-flash-asr", "invalid_response", `non-JSON response: ${bodyText.slice(0, 120)}`);
      }
      if (j.code !== 0) throw new ProviderError("tencent-flash-asr", "invalid_response", `${j.code}: ${(j.message || "unknown error").slice(0, 200)}`);
      const channel = j.flash_result?.[0];
      const text = (channel?.text ?? "").trim();
      const words: WordTiming[] = (channel?.word_list ?? [])
        .filter((w) => typeof w.word === "string" && w.word.trim() && Number.isFinite(w.start_time) && Number.isFinite(w.end_time) && w.end_time >= w.start_time)
        .map((w) => ({
          word: w.word.trim().toLowerCase(),
          start: Math.round(w.start_time) / 1000,
          end: Math.round(w.end_time) / 1000,
        }));
      return { text, words: words.length ? words : undefined, language: "en" };
    },
  };
}
