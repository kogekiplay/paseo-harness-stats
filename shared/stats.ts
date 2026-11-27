import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const turnRouteSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});
export type TurnRoute = z.infer<typeof turnRouteSchema>;

export const costRatesSchema = z.object({
  uncachedInput: z.number().nonnegative(),
  cachedInput: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative().optional(),
  output: z.number().nonnegative(),
});

export const costBreakdownSchema = z.object({
  currency: z.literal("USD").default("USD"),
  totalUsd: z.number().nonnegative(),
  uncachedInputUsd: z.number().nonnegative(),
  cachedInputUsd: z.number().nonnegative(),
  cacheWriteUsd: z.number().nonnegative(),
  outputUsd: z.number().nonnegative(),
  complete: z.boolean(),
  ratesPerMillion: costRatesSchema.optional(),
});
export type CostBreakdown = z.infer<typeof costBreakdownSchema>;

export const turnUsageSchema = z.object({
  turnNumber: z.number().int().positive(),
  turnId: z.string().optional(),
  messageIds: z.array(z.string()).default([]),
  startedAtMs: z.number().nonnegative().nullable().default(null),
  completedAtMs: z.number().nonnegative().nullable().default(null),
  routes: z.array(turnRouteSchema).default([]),
  steps: z.number().int().nonnegative(),
  inputTokens: z.number().nonnegative(),
  uncachedInputTokens: z.number().nonnegative(),
  cachedTokens: z.number().nonnegative().optional(),
  cacheWriteTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative(),
  reasoningTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative(),
  cost: costBreakdownSchema.optional(),
});
export type TurnUsage = z.infer<typeof turnUsageSchema>;

export const statsSchema = z.object({
  provider: z.string(),
  source: z.enum(["session", "unavailable", "unsupported"]),
  turns: z.number().nonnegative(),
  steps: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
  cachedTokens: z.number().nonnegative(),
  cacheWriteTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  timedOutputTokens: z.number().nonnegative(),
  modelMs: z.number().nonnegative().nullable(),
  toolMs: z.number().nonnegative().nullable(),
  ttftMs: z.number().nonnegative(),
  ttftSteps: z.number().int().nonnegative(),
  turnUsages: z.array(turnUsageSchema).default([]),
  cost: costBreakdownSchema.optional(),
  speedKind: z.literal("estimated"),
});

export type Stats = z.infer<typeof statsSchema>;
export const readStats = defineRpc({
  name: "stats.read",
  input: z.object({ agentId: z.string().min(1) }),
  output: statsSchema,
});

export function emptyStats(provider: string, source: Stats["source"] = "session") {
  return {
    provider,
    source,
    turns: 0,
    steps: 0,
    inputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    timedOutputTokens: 0,
    modelMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    turnUsages: [] as TurnUsage[],
    speedKind: "estimated",
  } satisfies Stats;
}

export function totalTokens(stats: Stats): number {
  // inputTokens includes cache reads and writes.
  return stats.inputTokens + stats.outputTokens;
}

export function speed(stats: Stats): number | null {
  return stats.modelMs !== null && stats.modelMs > 0 && stats.timedOutputTokens > 0
    ? (stats.timedOutputTokens * 1000) / stats.modelMs
    : null;
}

export function averageTtft(stats: Stats): number | null {
  return stats.ttftSteps > 0 ? stats.ttftMs / stats.ttftSteps : null;
}

export function cachePercent(stats: Stats): string | null {
  return formatCacheHitPercent(stats.cachedTokens, stats.inputTokens);
}

export function formatCacheHitPercent(
  cacheReadTokens: number,
  promptTokens: number,
  decimalPlaces: 0 | 1 = 0,
): string | null {
  if (promptTokens <= 0 || !Number.isFinite(promptTokens)) return null;
  const cacheRead = Math.max(0, Math.min(cacheReadTokens, promptTokens));
  if (cacheRead === promptTokens) return "100";
  const scale = decimalPlaces === 0 ? 100 : 1000;

  if (Number.isSafeInteger(cacheRead) && Number.isSafeInteger(promptTokens)) {
    const denominator = BigInt(promptTokens);
    const doubledCache = 2n * BigInt(cacheRead);
    const rounded = Number((doubledCache * BigInt(scale) + denominator) / (2n * denominator));
    if (rounded < scale) return String(rounded / (scale / 100));

    // Find the first precision at which the rounded cache miss is at least one unit.
    let doubledMiss = (2n * denominator - doubledCache) * 1000n;
    let places = 1;
    while (doubledMiss <= denominator) {
      doubledMiss *= 10n;
      places++;
    }
    const loss = Number((doubledMiss + denominator - 1n) / (2n * denominator));
    return `99.${"9".repeat(places - 1)}${10 - loss}`;
  }

  const rounded = Math.round((cacheRead / promptTokens) * scale);
  if (!(rounded >= scale)) return String(rounded / (scale / 100));
  let loss = ((promptTokens - cacheRead) / promptTokens) * 1000;
  let places = 1;
  while (loss <= 0.5) {
    loss *= 10;
    places++;
  }
  return `99.${"9".repeat(places - 1)}${10 - Math.ceil(loss - 0.5)}`;
}

export function turnCachePercent(turn: TurnUsage): string | null {
  return turn.cachedTokens === undefined
    ? null
    : formatCacheHitPercent(turn.cachedTokens, turn.inputTokens, 1);
}

export function formatExactTokens(value: number): string {
  return Math.trunc(value).toLocaleString("en-US");
}

export function formatTokens(value: number): string {
  const divisor = value >= 1e9 ? 1e9 : value >= 1e6 ? 1e6 : value >= 1e3 ? 1e3 : 1;
  return divisor === 1
    ? String(value)
    : `${Number((value / divisor).toFixed(1))}${divisor === 1e9 ? "B" : divisor === 1e6 ? "M" : "K"}`;
}

export function formatDuration(ms: number | null, locale = "en"): string {
  if (ms === null) return "—";
  const zh = locale.startsWith("zh");
  if (ms < 60_000) return `${Number((ms / 1000).toFixed(1))}${zh ? "秒" : " s"}`;
  const seconds = Math.round(ms / 1000);
  return zh
    ? `${Math.floor(seconds / 60)}分${seconds % 60}秒`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
