import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

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
  modelMs: z.number().nonnegative(),
  toolMs: z.number().nonnegative(),
  ttftMs: z.number().nonnegative(),
  ttftSteps: z.number().int().nonnegative(),
  speedKind: z.literal("estimated"),
});

export type Stats = z.infer<typeof statsSchema>;
export const readStats = defineRpc({
  name: "stats.read",
  input: z.object({ agentId: z.string().min(1) }),
  output: statsSchema,
});

export function emptyStats(provider: string, source: Stats["source"] = "session"): Stats {
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
    speedKind: "estimated",
  };
}

export function totalTokens(stats: Stats): number {
  // inputTokens includes cache reads and writes on both provider adapters.
  return stats.inputTokens + stats.outputTokens;
}

export function speed(stats: Stats): number | null {
  return stats.modelMs > 0 && stats.timedOutputTokens > 0
    ? (stats.timedOutputTokens * 1000) / stats.modelMs
    : null;
}

export function averageTtft(stats: Stats): number | null {
  return stats.ttftSteps > 0 ? stats.ttftMs / stats.ttftSteps : null;
}

export function cachePercent(stats: Stats): string | null {
  if (stats.inputTokens <= 0) return null;
  const pct = Math.min(100, (stats.cachedTokens / stats.inputTokens) * 100);
  // Preserve the distinction between almost all and a complete cache hit.
  return pct < 100 && pct >= 99.5 ? "99.9" : String(Math.round(pct));
}

export function formatTokens(value: number): string {
  const divisor = value >= 1e9 ? 1e9 : value >= 1e6 ? 1e6 : value >= 1e3 ? 1e3 : 1;
  return divisor === 1
    ? String(value)
    : `${Number((value / divisor).toFixed(1))}${divisor === 1e9 ? "B" : divisor === 1e6 ? "M" : "K"}`;
}

export function formatDuration(ms: number, locale = "en"): string {
  const zh = locale.startsWith("zh");
  if (ms < 60_000) return `${Number((ms / 1000).toFixed(1))}${zh ? "秒" : " s"}`;
  const seconds = Math.round(ms / 1000);
  return zh
    ? `${Math.floor(seconds / 60)}分${seconds % 60}秒`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
