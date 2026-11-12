/**
 * Tencent Cloud Smart Oral Evaluation (智聆口语评测, SOE basic version,
 * product 884) as a PronunciationProvider. Pure TypeScript TC3-HMAC-SHA256
 * signing — no SDK dependency, sized for Raspberry-Pi-class deployments.
 *
 * Flow per answer (SOE has no single-shot endpoint in the basic version):
 *   1. InitOralProcess  — session with RefText, paragraph mode, sync evaluation
 *   2. TransmitOralProcess — audio in ≤512 KB base64 chunks, IsEnd=1 on last
 *
 * Long answers: the SOE paragraph mode caps RefText at 120 words, so the
 * transcript is split into ≤120-word groups (preferring sentence boundaries)
 * and — when ASR word timings exist — each group is evaluated against ONLY its
 * own audio slice. Without word timings the whole audio is used and long
 * transcripts honestly fail instead of being mis-scored.
 *
 * Provider numbers are raw evidence (0–100 / 0–1 scales), never IELTS bands.
 */
import crypto from "node:crypto";
import { ProviderError, type PronunciationProvider, type PronunciationResult } from "./types";
import { decodeWavPcm16, clamp } from "@/lib/speaking/audio-signal";
import { encodeWav } from "@/lib/audio/wav";

const SOE_HOST = "soe.tencentcloudapi.com";
const SOE_VERSION = "2018-07-24";
/** Paragraph mode RefText cap (words). */
const MAX_GROUP_WORDS = 120;
/** Raw audio bytes per Transmit chunk (base64 inflates ~1.37×; API caps 1 MB). */
const AUDIO_CHUNK_BYTES = 512 * 1024;
const SEGMENT_PAD_MS = 300;

export interface TencentSoeOptions {
  secretId?: string;
  secretKey?: string;
  /** Credential-scope region (SOE itself needs no Region parameter). */
  region?: string;
  /** SOE 评价苛刻指数 1.0（宽松）– 4.0（严格）；默认 3.0（成人口语）。 */
  scoreCoeff?: number;
}

export interface SoeWord {
  word: string;
  accuracy: number;
}

// ---------------------------------------------------------------- signing
/** TC3-HMAC-SHA256 Authorization header for a Tencent Cloud API request. */
export function tc3Authorization(opts: {
  secretId: string;
  secretKey: string;
  host: string;
  service: string;
  region: string;
  action: string;
  timestamp: number;
  body: string;
}): string {
  const date = new Date(opts.timestamp * 1000).toISOString().slice(0, 10);
  const hashedBody = crypto.createHash("sha256").update(opts.body, "utf8").digest("hex");
  const canonicalRequest = [
    "POST",
    "/",
    "",
    `content-type:application/json; charset=utf-8`,
    `host:${opts.host}`,
    `x-tc-action:${opts.action.toLowerCase()}`,
    "",
    "content-type;host;x-tc-action",
    hashedBody,
  ].join("\n");
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(opts.timestamp),
    `${date}/${opts.region}/${opts.service}/tc3_request`,
    crypto.createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");
  const hmac = (key: crypto.BinaryLike | crypto.KeyObject, data: string) =>
    crypto.createHmac("sha256", key).update(data, "utf8").digest();
  const secretDate = hmac(`TC3${opts.secretKey}`, date);
  const secretService = hmac(secretDate, opts.service);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = crypto.createHmac("sha256", secretSigning).update(stringToSign, "utf8").digest("hex");
  return `TC3-HMAC-SHA256 Credential=${opts.secretId}/${date}/${opts.region}/${opts.service}/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`;
}

async function soeRequest(
  action: string,
  params: Record<string, unknown>,
  creds: { secretId: string; secretKey: string; region: string },
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const body = JSON.stringify(params);
  const timestamp = Math.floor(Date.now() / 1000);
  const res = await fetch(`https://${SOE_HOST}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Host: SOE_HOST,
      "X-TC-Action": action,
      "X-TC-Version": SOE_VERSION,
      "X-TC-Timestamp": String(timestamp),
      Authorization: tc3Authorization({
        secretId: creds.secretId, secretKey: creds.secretKey,
        host: SOE_HOST, service: "soe", region: creds.region,
        action, timestamp, body,
      }),
    },
    body,
    signal,
  });
  if (!res.ok) {
    throw new ProviderError("tencent-soe", "http", `${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  const j = (await res.json()) as { Response?: Record<string, unknown>; Error?: { Code: string; Message: string } };
  if (j.Error) throw new ProviderError("tencent-soe", "invalid_response", `${j.Error.Code}: ${j.Error.Message}`);
  if (!j.Response) throw new ProviderError("tencent-soe", "invalid_response", "no Response envelope");
  return j.Response;
}

// ---------------------------------------------------------------- text grouping
/** Split tokens into ≤maxWords groups, preferring sentence boundaries. */
export function groupTranscript(text: string, maxWords = MAX_GROUP_WORDS): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const groups: string[] = [];
  let cur: string[] = [];
  let curWords = 0;
  for (const s of sentences) {
    const n = (s.match(/[A-Za-z']+/g) ?? []).length || s.length;
    if (curWords > 0 && curWords + n > maxWords) {
      groups.push(cur.join(" "));
      cur = [];
      curWords = 0;
    }
    if (n > maxWords) {
      // A single over-long run-on sentence: split at word boundaries.
      const words = s.split(/\s+/);
      for (let i = 0; i < words.length; i += maxWords) {
        const part = words.slice(i, i + maxWords).join(" ");
        if (curWords > 0) {
          groups.push([...cur, part].join(" "));
          cur = [];
          curWords = 0;
        } else {
          groups.push(part);
        }
      }
      continue;
    }
    cur.push(s);
    curWords += n;
  }
  if (cur.length) groups.push(cur.join(" "));
  return groups;
}

// ---------------------------------------------------------------- audio slicing
export interface TimingPoint {
  start: number; // seconds
  end: number;
}

/** Sentence-group word ranges [firstIdx, lastIdx] aligned to the token stream. */
function groupWordRanges(text: string, groups: string[]): { first: number; last: number }[] {
  const tokens = (text.toLowerCase().match(/[a-z']+/g) ?? []);
  const ranges: { first: number; last: number }[] = [];
  let cursor = 0;
  for (const g of groups) {
    const n = (g.toLowerCase().match(/[a-z']+/g) ?? []).length;
    if (n === 0 || cursor >= tokens.length) continue;
    const last = Math.min(tokens.length - 1, cursor + n - 1);
    ranges.push({ first: cursor, last });
    cursor = last + 1;
  }
  return ranges;
}

/**
 * Slice the decoded WAV into one Float32 segment per text group, bounded by
 * the group's first/last word timing (±300 ms). Requires word timings; without
 * them the caller must fall back to whole-audio evaluation.
 */
export function sliceAudioByGroups(
  samples: Float32Array,
  sampleRate: number,
  words: TimingPoint[],
  groups: string[],
  text: string,
): Float32Array[] {
  const ranges = groupWordRanges(text, groups);
  return ranges.map(({ first, last }) => {
    const startMs = Math.max(0, words[first].start * 1000 - SEGMENT_PAD_MS);
    const endMs = Math.min((samples.length / sampleRate) * 1000, words[last].end * 1000 + SEGMENT_PAD_MS);
    const from = Math.floor((startMs / 1000) * sampleRate);
    const to = Math.min(samples.length, Math.ceil((endMs / 1000) * sampleRate));
    return samples.subarray(from, Math.max(from + 1, to));
  });
}

// ---------------------------------------------------------------- sessions
export interface SoeSessionResult {
  /** 0–100, −1 means "no match" / meaningless. */
  accuracy: number;
  /** 0–1, −1 when meaningless. */
  fluency: number;
  /** 0–1, −1 when meaningless. */
  completion: number;
  /** 0–100 suggested score. */
  suggested: number;
  words: SoeWord[];
  /** Number of reference words in this group (aggregation weight). */
  weight: number;
}

function wordCount(text: string): number {
  return (text.toLowerCase().match(/[a-z']+/g) ?? []).length || 1;
}

interface SoeWordRsp {
  ReferenceWord?: string;
  Word?: string;
  PronAccuracy?: number;
}

async function evaluateSession(opts: {
  creds: { secretId: string; secretKey: string; region: string };
  sessionId: string;
  refText: string;
  samples: Float32Array;
  sampleRate: number;
  scoreCoeff: number;
  signal?: AbortSignal;
}): Promise<SoeSessionResult> {
  const { creds, sessionId, refText, samples, sampleRate, scoreCoeff, signal } = opts;
  await soeRequest("InitOralProcess", {
    SessionId: sessionId,
    RefText: refText.slice(0, 1000),
    WorkMode: 0, // streaming chunks (recommended by the API docs)
    EvalMode: 2, // paragraph mode
    ScoreCoeff: scoreCoeff,
    IsAsync: 0,
    ServerType: 0, // English
  }, creds, signal);

  const wav = encodeWav(samples, sampleRate);
  let final: Record<string, unknown> | null = null;
  const chunks = Math.ceil(wav.length / AUDIO_CHUNK_BYTES);
  for (let i = 0; i < chunks; i++) {
    const isEnd = i === chunks - 1 ? 1 : 0;
    final = await soeRequest("TransmitOralProcess", {
      SessionId: sessionId,
      SeqId: i + 1,
      IsEnd: isEnd,
      VoiceEncodeType: 1,
      VoiceFileType: 2, // wav
      UserVoiceData: Buffer.from(wav.subarray(i * AUDIO_CHUNK_BYTES, Math.min(wav.length, (i + 1) * AUDIO_CHUNK_BYTES))).toString("base64"),
    }, creds, signal);
  }
  if (!final) throw new ProviderError("tencent-soe", "invalid_response", "empty audio — nothing transmitted");

  const num = (v: unknown, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? v : dflt);
  const wordsRsp = Array.isArray(final.Words) ? (final.Words as SoeWordRsp[]) : [];
  return {
    accuracy: Math.max(0, num(final.PronAccuracy, 0)),
    fluency: num(final.PronFluency, -1),
    completion: num(final.PronCompletion, -1),
    suggested: Math.max(0, num(final.SuggestedScore, 0)),
    weight: wordCount(refText),
    words: wordsRsp
      .map((w) => ({ word: w.ReferenceWord || w.Word || "", accuracy: Math.max(0, num(w.PronAccuracy, 0)) }))
      .filter((w) => w.word.length > 0),
  };
}

// ---------------------------------------------------------------- provider
/**
 * Tencent SOE pronunciation provider. Credentials: TENCENT_SECRET_ID +
 * TENCENT_SECRET_KEY (optional TENCENT_SOE_REGION, TENCENT_SOE_SCORE_COEFF).
 * `assessOpts.words` (ASR word timings) enables audio slicing for long
 * transcripts; without timings only ≤120-word transcripts are assessable.
 */
export function tencentSoePronunciation(opts: TencentSoeOptions = {}): PronunciationProvider {
  const secretId = opts.secretId || process.env.TENCENT_SECRET_ID || "";
  const secretKey = opts.secretKey || process.env.TENCENT_SECRET_KEY || "";
  const region = opts.region || process.env.TENCENT_SOE_REGION || "ap-guangzhou";
  const scoreCoeff = clamp(Number(process.env.TENCENT_SOE_SCORE_COEFF) || 3.0, 1.0, 4.0);
  return {
    id: "tencent-soe",
    model: "soe paragraph en",
    async assess(wav, referenceText, assessOpts) {
      if (!secretId || !secretKey) throw new ProviderError("tencent-soe", "config", "missing TENCENT_SECRET_ID / TENCENT_SECRET_KEY");
      if (!referenceText.trim()) throw new ProviderError("tencent-soe", "invalid_response", "no reference text");
      const decoded = decodeWavPcm16(new Uint8Array(wav));
      if (!decoded.ok) throw new ProviderError("tencent-soe", "unsupported", `undecodable WAV: ${decoded.reason}`);
      const creds = { secretId, secretKey, region };
      const groups = groupTranscript(referenceText);
      const timings = assessOpts?.words && assessOpts.words.length >= 2
        ? assessOpts.words.map((w) => ({ start: w.start, end: w.end }))
        : null;
      if (!timings && groups.length !== 1) {
        throw new ProviderError("tencent-soe", "unsupported", "transcript exceeds the 120-word paragraph cap and no word timings are available to slice the audio");
      }
      const segments = timings
        ? sliceAudioByGroups(decoded.wav.samples, decoded.wav.sampleRate, timings, groups, referenceText)
        : [decoded.wav.samples];
      const evalGroups = timings ? groups.slice(0, segments.length) : groups;

      const results: SoeSessionResult[] = [];
      for (let g = 0; g < evalGroups.length; g++) {
        if (segments[g].length < decoded.wav.sampleRate / 10) continue; // <100 ms of audio
        results.push(await evaluateSession({
          creds,
          sessionId: crypto.randomUUID(),
          refText: evalGroups[g],
          samples: segments[g],
          sampleRate: decoded.wav.sampleRate,
          scoreCoeff,
          signal: assessOpts?.signal,
        }));
      }
      if (!results.length) throw new ProviderError("tencent-soe", "invalid_response", "no evaluable audio segments");
      return aggregateSoeSessions(results);
    },
  };
}

/**
 * Word-weighted aggregation of per-group SOE sessions into the provider-neutral
 * PronunciationResult (0–100 scales; SOE fluency/completion are 0–1 → ×100).
 * SOE basic has no prosody dimension, so it stays undefined rather than faked.
 */
export function aggregateSoeSessions(results: SoeSessionResult[]): PronunciationResult {
  const wsum = results.reduce((s, r) => s + r.weight, 0) || 1;
  const wavg = (get: (r: SoeSessionResult) => number) =>
    Math.round((results.reduce((s, r) => s + get(r) * r.weight, 0) / wsum) * 10) / 10;
  const mean = (get: (r: SoeSessionResult) => number) => {
    const vals = results.map(get).filter((v) => v >= 0);
    return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000 : -1;
  };
  const fluency = mean((r) => r.fluency);
  const completion = mean((r) => r.completion);
  return {
    accuracy: wavg((r) => r.accuracy),
    fluency: fluency >= 0 ? Math.round(fluency * 1000) / 10 : 0, // 0–1 → 0–100
    prosody: undefined,
    completeness: completion >= 0 ? Math.round(completion * 1000) / 10 : undefined,
    overall: wavg((r) => r.suggested),
    words: results.flatMap((r) => r.words),
  };
}
export async function probeTencentSoe(opts?: TencentSoeOptions): Promise<boolean> {
  const secretId = opts?.secretId || process.env.TENCENT_SECRET_ID || "";
  const secretKey = opts?.secretKey || process.env.TENCENT_SECRET_KEY || "";
  if (!secretId || !secretKey) return false;
  const creds = { secretId, secretKey, region: opts?.region || process.env.TENCENT_SOE_REGION || "ap-guangzhou" };
  try {
    // Init a short-lived session and immediately end it with silence — the
    // cheapest possible authenticated round trip.
    const sessionId = crypto.randomUUID();
    await soeRequest("InitOralProcess", {
      SessionId: sessionId,
      RefText: "hello",
      WorkMode: 1,
      EvalMode: 0,
      ScoreCoeff: 3.0,
    }, creds);
    return true;
  } catch {
    return false;
  }
}
