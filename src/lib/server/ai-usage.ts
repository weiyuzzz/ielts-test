/**
 * AI usage ledger — one row per outbound AI call (scoring, transcription,
 * pronunciation, TTS) so /admin can show consumption per service.
 * Recording is best-effort: a failed insert must never break the AI flow.
 */
import { db } from "@/db";
import { aiUsageEvents } from "@/db/schema";
import { desc, sql } from "drizzle-orm";

export type AiService = "llm" | "asr" | "tts" | "pronunciation";

export interface UsageEvent {
  service: AiService;
  provider: string;
  model?: string | null;
  status: "ok" | "failed";
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** Service-specific units: ASR = audio ms, TTS = characters, pronunciation = sessions. */
  units?: number;
  unitLabel?: string;
  meta?: Record<string, unknown>;
}

export async function recordUsage(e: UsageEvent): Promise<void> {
  try {
    await db.insert(aiUsageEvents).values({
      service: e.service,
      provider: e.provider,
      model: e.model ?? null,
      status: e.status,
      latencyMs: e.latencyMs ?? null,
      tokensIn: e.tokensIn ?? null,
      tokensOut: e.tokensOut ?? null,
      units: e.units ?? null,
      unitLabel: e.unitLabel ?? null,
      meta: e.meta ?? null,
    });
  } catch {
    // Never let usage bookkeeping break an AI call.
  }
}

export interface ServiceUsage {
  calls: number;
  ok: number;
  failed: number;
  avgLatencyMs: number | null;
  tokensIn: number;
  tokensOut: number;
  units: number;
  unitLabel: string | null;
}

export interface UsageSummary {
  totals: Record<AiService, ServiceUsage>;
  recent: {
    service: string;
    provider: string;
    model: string | null;
    status: string;
    latencyMs: number | null;
    tokensIn: number | null;
    tokensOut: number | null;
    units: number | null;
    unitLabel: string | null;
    createdAt: Date;
  }[];
}

export async function getUsageSummary(): Promise<UsageSummary> {
  const totals = await db
    .select({
      service: aiUsageEvents.service,
      calls: sql<number>`count(*)::int`,
      ok: sql<number>`count(*) filter (where ${aiUsageEvents.status} = 'ok')::int`,
      failed: sql<number>`count(*) filter (where ${aiUsageEvents.status} = 'failed')::int`,
      avgLatencyMs: sql<number>`coalesce(avg(${aiUsageEvents.latencyMs}), 0)::int`,
      tokensIn: sql<number>`coalesce(sum(${aiUsageEvents.tokensIn}), 0)::int`,
      tokensOut: sql<number>`coalesce(sum(${aiUsageEvents.tokensOut}), 0)::int`,
      units: sql<number>`coalesce(sum(${aiUsageEvents.units}), 0)::int`,
    })
    .from(aiUsageEvents)
    .groupBy(aiUsageEvents.service);

  const unitLabels: Record<string, string> = { asr: "audio ms", tts: "chars", pronunciation: "sessions" };
  const out: Partial<Record<AiService, ServiceUsage>> = {};
  for (const t of totals) {
    out[t.service as AiService] = { ...t, unitLabel: unitLabels[t.service] ?? null };
  }
  const blank = (label: string | null = null): ServiceUsage => ({ calls: 0, ok: 0, failed: 0, avgLatencyMs: null, tokensIn: 0, tokensOut: 0, units: 0, unitLabel: label });

  const recentRows = await db
    .select({
      service: aiUsageEvents.service,
      provider: aiUsageEvents.provider,
      model: aiUsageEvents.model,
      status: aiUsageEvents.status,
      latencyMs: aiUsageEvents.latencyMs,
      tokensIn: aiUsageEvents.tokensIn,
      tokensOut: aiUsageEvents.tokensOut,
      units: aiUsageEvents.units,
      unitLabel: aiUsageEvents.unitLabel,
      createdAt: aiUsageEvents.createdAt,
    })
    .from(aiUsageEvents)
    .orderBy(desc(aiUsageEvents.createdAt))
    .limit(20);

  return {
    totals: {
      llm: out.llm ?? blank(),
      asr: out.asr ?? blank(unitLabels.asr),
      tts: out.tts ?? blank(unitLabels.tts),
      pronunciation: out.pronunciation ?? blank(unitLabels.pronunciation),
    },
    recent: recentRows,
  };
}
