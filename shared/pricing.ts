import type { CostBreakdown, TurnUsage } from "./stats";

export interface ResolvedModelPricing {
  uncachedInput: number;
  cachedInput: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  output: number;
}

interface PricingOptions {
  promptTokens?: number;
  timestampMs?: number | null;
}

type PricingSchedule = ResolvedModelPricing | ((options: PricingOptions) => ResolvedModelPricing);

const rates = (uncachedInput: number, cachedInput: number, output: number): ResolvedModelPricing =>
  ({ uncachedInput, cachedInput, output });

const claudeRates = (uncachedInput: number, cachedInput: number, output: number): ResolvedModelPricing =>
  ({ uncachedInput, cachedInput, cacheWrite5m: uncachedInput * 1.25, cacheWrite1h: uncachedInput * 2, output });

const contextRates = (threshold: number, standard: ResolvedModelPricing, long: ResolvedModelPricing) =>
  ({ promptTokens = 0 }: PricingOptions) => promptTokens > threshold ? long : standard;

const openAiLongRates = (input: number, cached: number, output: number) =>
  contextRates(272_000, rates(input, cached, output), rates(input * 2, cached * 2, output * 1.5));

const datedRates = (effectiveAtMs: number, earlier: ResolvedModelPricing, later: ResolvedModelPricing) =>
  ({ timestampMs }: PricingOptions) => (timestampMs ?? Date.now()) < effectiveAtMs ? earlier : later;

const schedules: [string[], PricingSchedule][] = [
  // OpenAI
  [["gpt-6.2-astra"], openAiLongRates(8, 0.4, 40)],
  [["gpt-6-astra"], openAiLongRates(10, 1, 50)],
  [["gpt-6.2-sol", "gpt-6.1-sol"], openAiLongRates(2, 0.1, 10)],
  [["gpt-6.1-terra"], openAiLongRates(1, 0.05, 5)],
  [["gpt-6-luna"], openAiLongRates(0.1, 0.01, 0.5)],
  [["gpt-5.4-pro", "gpt-5.5-pro"], openAiLongRates(30, 30, 180)],
  [["gpt-5.4"], openAiLongRates(2.5, 0.25, 15)],
  [["gpt-5.4-mini"], rates(0.75, 0.075, 4.5)],
  [["gpt-5.4-nano", "gpt-5-nano"], rates(0.05, 0.005, 0.4)],
  [["gpt-5.3-codex", "gpt-5.3-instant", "gpt-5.2-codex", "gpt-5.2"], rates(1.75, 0.175, 14)],
  [["gpt-5.2-pro"], rates(21, 2.1, 168)],
  [["gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-max", "gpt-5", "gpt-5-codex"], rates(1.25, 0.125, 10)],
  [["gpt-5.1-codex-mini", "gpt-5-mini"], rates(0.25, 0.025, 2)],
  [["gpt-5-pro"], rates(15, 15, 120)],
  [["o3"], rates(2, 0.5, 8)],
  [["o3-pro"], rates(20, 20, 80)],
  [["o3-mini"], rates(1.1, 0.55, 4.4)],
  [["o4-mini"], rates(1.1, 0.275, 4.4)],
  [["o1"], rates(15, 7.5, 60)],
  [["gpt-4.1"], rates(2, 0.5, 8)],
  [["gpt-4.1-mini"], rates(0.4, 0.1, 1.6)],
  [["gpt-4.1-nano"], rates(0.1, 0.025, 0.4)],
  [["gpt-4o"], rates(2.5, 1.25, 10)],
  [["gpt-4o-mini"], rates(0.15, 0.075, 0.6)],
  // Anthropic
  [["claude-fable-5-2", "claude-mythos-5-2"], claudeRates(8, 0.2, 40)],
  [["claude-fable-5-1", "claude-mythos-5-1"], claudeRates(10, 0.25, 50)],
  [["claude-fable-5", "claude-mythos-5"], claudeRates(10, 1, 50)],
  [["claude-opus-5-5"], claudeRates(4, 0.2, 20)],
  [["claude-sonnet-5-5"], claudeRates(2, 0.1, 10)],
  [["claude-haiku-5-5"], contextRates(100_000, claudeRates(0.1, 0.01, 0.5), claudeRates(0.5, 0.05, 2.5))],
  [["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5"], claudeRates(5, 0.5, 25)],
  [["claude-sonnet-5"], claudeRates(2, 0.2, 10)],
  [["claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4", "claude-3-7-sonnet", "claude-3-5-sonnet"], claudeRates(3, 0.3, 15)],
  [["claude-haiku-4-5"], claudeRates(1, 0.1, 5)],
  [["claude-opus-4-1", "claude-opus-4", "claude-3-opus"], claudeRates(15, 1.5, 75)],
  [["claude-3-5-haiku"], claudeRates(0.8, 0.08, 4)],
  // Gemini
  [["gemini-4-neon"], rates(3, 0.15, 15)],
  [["gemini-4-hydrogen"], rates(1.5, 0.075, 7.5)],
  [["gemini-4-argon", "gemini-4-carbon"], datedRates(Date.UTC(2026, 11, 1), rates(2, 0.1, 10), rates(4, 0.2, 20))],
  [["gemini-3.8-flash"], datedRates(Date.UTC(2027, 0, 1), rates(0.75, 0.075, 3.75), rates(1.5, 0.15, 7.5))],
  [["gemini-3.1-pro", "gemini-3-pro"], contextRates(200_000, rates(2, 0.2, 12), rates(4, 0.4, 18))],
  [["gemini-3-flash"], rates(0.5, 0.05, 3)],
  [["gemini-3.1-flash-lite"], rates(0.25, 0.025, 1.5)],
  [["gemini-2.5-pro"], contextRates(200_000, rates(1.25, 0.125, 10), rates(2.5, 0.25, 15))],
  [["gemini-2.5-flash"], rates(0.3, 0.03, 2.5)],
  [["gemini-2.5-flash-lite"], rates(0.1, 0.01, 0.4)],
  // DeepSeek
  [["deepseek-v4-pro"], rates(1.32, 0.044, 3.96)],
  [["deepseek-flash", "deepseek-v4.1-flash"], rates(0.3, 0.006, 1.2)],
];

const pricingByModel = new Map(schedules.flatMap(([models, schedule]) =>
  models.map((model) => [model, schedule] as const),
));

export function normalizeModelId(raw: string): string {
  const route = raw.trim().toLowerCase();
  let model = route.slice(route.lastIndexOf("/") + 1).replace(/\[\d+[km]?\]$/, "");
  if (pricingByModel.has(model)) return model;
  if (model.startsWith("claude-")) model = model.replace(/(\d)\.(?=\d)/g, "$1-");
  while (!pricingByModel.has(model)) {
    const base = model.replace(/-(?:trial|preview|latest|exp|\d{8}|\d{4}-\d{2}-\d{2}|\d{4})$/, "");
    if (base === model) break;
    model = base;
  }
  return model;
}

export function resolveModelPricing(model: string, options: PricingOptions = {}): ResolvedModelPricing | null {
  const schedule = pricingByModel.get(normalizeModelId(model));
  if (!schedule) return null;
  return { ...(typeof schedule === "function" ? schedule(options) : schedule) };
}

interface StepPricingInput {
  model?: string | null;
  uncachedInputTokens: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  outputTokens: number;
  timestampMs?: number | null;
}

const picoUsdPerDollar = 1_000_000_000_000n;
const tokenCost = (tokenCount: number, rate: number): bigint =>
  BigInt(tokenCount) * BigInt(Math.round(rate * 1_000_000));
const toUsd = (picoUsd: bigint): number => Number(`${picoUsd}e-12`);
const fromUsd = (usd: number): bigint => usd < 1e21
  ? BigInt(usd.toFixed(12).replace(".", ""))
  : BigInt(usd) * picoUsdPerDollar;

export type PicoUsdBreakdown = Record<"uncachedInput" | "cachedInput" | "cacheWrite" | "output", bigint>;
type CostRates = NonNullable<CostBreakdown["ratesPerMillion"]>;

export function priceStep(input: StepPricingInput) {
  const {
    model, uncachedInputTokens, cachedTokens = 0, cacheWriteTokens = 0,
    cacheWrite5mTokens = 0, cacheWrite1hTokens = 0, outputTokens, timestampMs,
  } = input;
  if (!model) return null;
  const counts = [uncachedInputTokens, cachedTokens, cacheWriteTokens, cacheWrite5mTokens, cacheWrite1hTokens, outputTokens];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) return null;
  const promptTokens = uncachedInputTokens + cachedTokens + cacheWriteTokens;
  const pricing = resolveModelPricing(model, { promptTokens, timestampMs });
  if (!pricing) return null;
  const { uncachedInput, cachedInput, output, cacheWrite5m = uncachedInput, cacheWrite1h = cacheWrite5m } = pricing;
  const unclassifiedWrites = Math.max(0, cacheWriteTokens - cacheWrite5mTokens - cacheWrite1hTokens);
  const shortWrites = cacheWrite5mTokens + unclassifiedWrites;
  const cacheWriteRate = shortWrites > 0
    ? (cacheWrite1hTokens === 0 ? cacheWrite5m : undefined)
    : (cacheWrite1hTokens > 0 ? cacheWrite1h : undefined);
  return {
    picoUsd: {
      uncachedInput: tokenCost(uncachedInputTokens, uncachedInput),
      cachedInput: tokenCost(cachedTokens, cachedInput),
      cacheWrite: tokenCost(shortWrites, cacheWrite5m) + tokenCost(cacheWrite1hTokens, cacheWrite1h),
      output: tokenCost(outputTokens, output),
    } satisfies PicoUsdBreakdown,
    ratesPerMillion: { uncachedInput, cachedInput, output },
    hasCacheWrite: shortWrites > 0 || cacheWrite1hTokens > 0,
    cacheWriteRate,
  };
}

export function toCostBreakdown(
  { uncachedInput, cachedInput, cacheWrite, output }: PicoUsdBreakdown,
  complete: boolean,
  ratesPerMillion?: CostRates,
): CostBreakdown {
  return {
    currency: "USD",
    totalUsd: toUsd(uncachedInput + cachedInput + cacheWrite + output),
    uncachedInputUsd: toUsd(uncachedInput),
    cachedInputUsd: toUsd(cachedInput),
    cacheWriteUsd: toUsd(cacheWrite),
    outputUsd: toUsd(output),
    complete,
    ...(ratesPerMillion && { ratesPerMillion }),
  };
}

export function sameBaseRates(a: CostRates, b: CostRates): boolean {
  return a.uncachedInput === b.uncachedInput && a.cachedInput === b.cachedInput && a.output === b.output;
}

export function aggregateSessionCost(turnUsages: readonly TurnUsage[]): CostBreakdown | undefined {
  const costs = turnUsages.flatMap(({ cost }) => cost ? [cost] : []);
  if (costs.length === 0) return undefined;
  const complete = turnUsages.every(({ steps, cost }) => steps === 0 || cost?.complete === true);
  const rates = costs[0].ratesPerMillion;
  const uniformRates = rates && costs.every(({ ratesPerMillion, cacheWriteUsd }) =>
    ratesPerMillion && sameBaseRates(rates, ratesPerMillion)
    && rates.cacheWrite === ratesPerMillion.cacheWrite
    && (cacheWriteUsd === 0 || ratesPerMillion.cacheWrite !== undefined),
  );
  const sum = { uncachedInput: 0n, cachedInput: 0n, cacheWrite: 0n, output: 0n };
  let total = 0n;
  for (const cost of costs) {
    total += fromUsd(cost.totalUsd);
    sum.uncachedInput += fromUsd(cost.uncachedInputUsd);
    sum.cachedInput += fromUsd(cost.cachedInputUsd);
    sum.cacheWrite += fromUsd(cost.cacheWriteUsd);
    sum.output += fromUsd(cost.outputUsd);
  }
  return {
    ...toCostBreakdown(sum, complete, uniformRates ? { ...rates } : undefined),
    totalUsd: toUsd(total),
  };
}

export function formatUsd(usd: number, mode: "compact" | "detail" = "detail"): string {
  if (mode === "compact") {
    if (usd <= 0) return "$0";
    if (usd >= 0.1) return `$${usd.toFixed(2)}`;
    if (usd >= 0.01) return `$${usd.toFixed(3)}`;
    if (usd >= 0.001) return `$${usd.toFixed(4)}`;
    return "<$0.001";
  }
  if (usd <= 0) return "$0.00";
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(usd >= 0.0001 ? 4 : 6)}`;
}

export function formatRatePerMillion(rate: number): string {
  return `$${Number(rate.toFixed(4))} / 1M`;
}
