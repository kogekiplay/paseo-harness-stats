import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateSessionCost, formatRatePerMillion, formatUsd, normalizeModelId,
  priceStep, resolveModelPricing,
} from "../shared/pricing";
import { costBreakdownSchema, turnUsageSchema } from "../shared/stats";

test("Pricing strips provider routes, Claude version dots, context windows and stacked suffixes", () => {
  const cases = [
    [" auto/GPT-6.2-SOL ", "gpt-6.2-sol"],
    ["codex/gpt-6.2-sol", "gpt-6.2-sol"],
    ["openai/gpt-5.4-2026-03-05", "gpt-5.4"],
    ["claude-opus-4-6[1m]", "claude-opus-4-6"],
    ["anthropic/claude-opus-5.5[1M]", "claude-opus-5-5"],
    ["claude-sonnet-4.6", "claude-sonnet-4-6"],
    ["claude-sonnet-4-5-20250929", "claude-sonnet-4-5"],
    ["google/models/gemini-4-neon", "gemini-4-neon"],
    ["gemini-4-argon-trial", "gemini-4-argon"],
    ["gemini-3-pro-preview-20251118-exp-latest", "gemini-3-pro"],
    ["deepseek-v4-pro-0813", "deepseek-v4-pro"],
    ["deepseek-v4.1-flash-1017", "deepseek-v4.1-flash"],
    ["gpt-5.1-codex-max", "gpt-5.1-codex-max"],
  ];
  for (const [raw, canonical] of cases) {
    assert.equal(normalizeModelId(raw), canonical);
    assert.deepEqual(resolveModelPricing(raw), resolveModelPricing(canonical));
    assert.ok(resolveModelPricing(raw));
  }
});

test("Standard rates preserve the exact catalog and provider-specific cache discounts", () => {
  const rates = (uncachedInput: number, cachedInput: number, output: number) =>
    ({ uncachedInput, cachedInput, output });
  const opus = { ...rates(4, 0.2, 20), cacheWrite5m: 5, cacheWrite1h: 8 };
  const cases = [
    ["gpt-6.2-astra", rates(8, 0.4, 40)],
    ["gpt-6-astra", rates(10, 1, 50)],
    ["gpt-6.1-sol", rates(2, 0.1, 10)],
    ["gpt-6.1-terra", rates(1, 0.05, 5)],
    ["gpt-6-luna", rates(0.1, 0.01, 0.5)],
    ["gpt-5.4-pro", rates(30, 30, 180)],
    ["gpt-5.4", rates(2.5, 0.25, 15)],
    ["gpt-5.4-mini", rates(0.75, 0.075, 4.5)],
    ["gpt-5.4-nano", rates(0.05, 0.005, 0.4)],
    ["gpt-5.3-codex", rates(1.75, 0.175, 14)],
    ["gpt-5.2-pro", rates(21, 2.1, 168)],
    ["gpt-5.1-codex-max", rates(1.25, 0.125, 10)],
    ["gpt-5.1-codex-mini", rates(0.25, 0.025, 2)],
    ["gpt-5-pro", rates(15, 15, 120)],
    ["o3-mini", rates(1.1, 0.55, 4.4)],
    ["o4-mini", rates(1.1, 0.275, 4.4)],
    ["gpt-4.1-nano", rates(0.1, 0.025, 0.4)],
    ["gpt-4o-mini", rates(0.15, 0.075, 0.6)],
    ["claude-opus-5.5", opus],
    ["claude-mythos-5-2", { ...rates(8, 0.2, 40), cacheWrite5m: 10, cacheWrite1h: 16 }],
    ["claude-fable-5-1", { ...rates(10, 0.25, 50), cacheWrite5m: 12.5, cacheWrite1h: 20 }],
    ["claude-fable-5", { ...rates(10, 1, 50), cacheWrite5m: 12.5, cacheWrite1h: 20 }],
    ["claude-sonnet-4.6", { ...rates(3, 0.3, 15), cacheWrite5m: 3.75, cacheWrite1h: 6 }],
    ["claude-opus-4-6[1m]", { ...rates(5, 0.5, 25), cacheWrite5m: 6.25, cacheWrite1h: 10 }],
    ["gemini-4-neon", rates(3, 0.15, 15)],
    ["gemini-4-hydrogen", rates(1.5, 0.075, 7.5)],
    ["gemini-3-flash", rates(0.5, 0.05, 3)],
    ["gemini-3.1-flash-lite", rates(0.25, 0.025, 1.5)],
    ["gemini-2.5-flash", rates(0.3, 0.03, 2.5)],
    ["deepseek-v4-pro-0813", rates(1.32, 0.044, 3.96)],
    ["deepseek-flash", rates(0.3, 0.006, 1.2)],
  ] as const;
  for (const [model, expected] of cases) {
    assert.deepEqual(resolveModelPricing(model), expected, model);
  }
  assert.deepEqual(resolveModelPricing("claude-opus-5.5", { promptTokens: 999_999 }), opus);
});

test("Long context boundaries use the combined prompt tokens of one request", () => {
  for (const [model, boundary, short, long] of [
    ["gpt-6.2-sol", 272_000, [2, 0.1, 10], [4, 0.2, 15]],
    ["gpt-6.2-astra", 272_000, [8, 0.4, 40], [16, 0.8, 60]],
    ["gpt-5.4", 272_000, [2.5, 0.25, 15], [5, 0.5, 22.5]],
    ["gpt-5.5-pro", 272_000, [30, 30, 180], [60, 60, 270]],
    ["gpt-5.4-mini", 272_000, [0.75, 0.075, 4.5], [0.75, 0.075, 4.5]],
    ["gemini-3.1-pro", 200_000, [2, 0.2, 12], [4, 0.4, 18]],
    ["gemini-2.5-pro", 200_000, [1.25, 0.125, 10], [2.5, 0.25, 15]],
    ["claude-haiku-5-5", 100_000, [0.1, 0.01, 0.5], [0.5, 0.05, 2.5]],
  ] as const) {
    const parts = {
      model,
      uncachedInputTokens: 1000,
      cachedTokens: boundary - 2000,
      cacheWriteTokens: 1000,
      outputTokens: 10,
    };
    for (const [step, rates] of [
      [parts, short],
      [{ ...parts, cachedTokens: parts.cachedTokens + 1 }, long],
    ] as const) {
      const [uncachedInput, cachedInput, output] = rates;
      assert.deepEqual(priceStep(step)?.ratesPerMillion, { uncachedInput, cachedInput, output }, model);
    }
  }
  assert.deepEqual(
    priceStep({
      model: "claude-haiku-5-5",
      uncachedInputTokens: 90_000,
      cachedTokens: 10_000,
      cacheWriteTokens: 1,
      cacheWrite1hTokens: 1,
      outputTokens: 2,
    })?.picoUsd,
    { uncachedInput: 45_000_000_000n, cachedInput: 500_000_000n, cacheWrite: 1_000_000n, output: 5_000_000n },
  );
});

test("Gemini promotional rates switch at the stated UTC instant", () => {
  for (const [model, effectiveMs, short, later] of [
    ["gemini-4-argon-trial", Date.UTC(2026, 11, 1), [2, 0.1, 10], [4, 0.2, 20]],
    ["gemini-4-carbon", Date.UTC(2026, 11, 1), [2, 0.1, 10], [4, 0.2, 20]],
    ["gemini-3.8-flash", Date.UTC(2027, 0, 1), [0.75, 0.075, 3.75], [1.5, 0.15, 7.5]],
  ] as const) {
    for (const [timestampMs, [uncachedInput, cachedInput, output]] of [
      [effectiveMs - 1, short],
      [effectiveMs, later],
    ] as const) {
      assert.deepEqual(resolveModelPricing(model, { timestampMs }), { uncachedInput, cachedInput, output }, model);
    }
  }
});

test("Step prices charge 5-minute, 1-hour, and unclassified writes at their respective rates", () => {
  const usage = { model: "claude-opus-5-5", uncachedInputTokens: 3, cachedTokens: 7, outputTokens: 2 };
  const mixed = priceStep({
    ...usage, cacheWriteTokens: 100, cacheWrite5mTokens: 30, cacheWrite1hTokens: 40,
  });
  assert.deepEqual(mixed?.picoUsd, {
    uncachedInput: 12_000_000n,
    cachedInput: 1_400_000n,
    cacheWrite: 620_000_000n,
    output: 40_000_000n,
  });
  assert.equal(mixed?.hasCacheWrite, true);
  assert.equal(mixed?.cacheWriteRate, undefined);

  for (const [writes, expected, rate] of [
    [{ cacheWriteTokens: 50 }, 250_000_000n, 5],
    [{ cacheWriteTokens: 50, cacheWrite5mTokens: 50 }, 250_000_000n, 5],
    [{ cacheWriteTokens: 50, cacheWrite1hTokens: 50 }, 400_000_000n, 8],
    [{ cacheWrite1hTokens: 50 }, 400_000_000n, 8],
    [{ cacheWriteTokens: 10, cacheWrite1hTokens: 50 }, 400_000_000n, 8],
    [{ cacheWriteTokens: 0 }, 0n, undefined],
  ] as const) {
    const priced = priceStep({ ...usage, ...writes });
    assert.equal(priced?.picoUsd.cacheWrite, expected);
    assert.equal(priced?.cacheWriteRate, rate);
  }
  assert.deepEqual(priceStep({ ...usage, model: "gemini-4-neon", cacheWriteTokens: 2 })?.picoUsd, {
    uncachedInput: 9_000_000n, cachedInput: 1_050_000n, cacheWrite: 6_000_000n, output: 30_000_000n,
  });
  assert.deepEqual(priceStep({ ...usage, model: "codex/gpt-6.2-sol" })?.picoUsd, {
    uncachedInput: 6_000_000n, cachedInput: 700_000n, cacheWrite: 0n, output: 20_000_000n,
  });
});

test("Unknown, missing and malformed usage cannot produce a guessed price", () => {
  const step = { uncachedInputTokens: 2, outputTokens: 3 };
  for (const model of ["gpt-oss-120b-medium", "gemini-pro-orchestrator-neon", "private/model-preview", "gpt-5.4-ultra", ""]) {
    assert.equal(resolveModelPricing(model), null);
    assert.equal(priceStep({ ...step, model }), null);
  }
  assert.equal(priceStep(step), null);
  assert.equal(priceStep({ ...step, model: "gpt-5.4", cachedTokens: 1.5 }), null);
});

test("Session aggregation sums decimal amounts, keeps common rates and ignores empty turns for completeness", () => {
  const turn = turnUsageSchema.parse({
    turnNumber: 1, steps: 1, inputTokens: 1, uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2,
  });
  const cost = costBreakdownSchema.parse({
    totalUsd: 0.1, uncachedInputUsd: 0.1, cachedInputUsd: 0, cacheWriteUsd: 0, outputUsd: 0,
    complete: true, ratesPerMillion: { uncachedInput: 2, cachedInput: 0.1, output: 10 },
  });
  const secondCost = { ...cost, totalUsd: 0.2, uncachedInputUsd: 0.2 };
  const first = { ...turn, cost };
  const second = { ...turn, turnNumber: 2, cost: secondCost };
  assert.equal(aggregateSessionCost([]), undefined);
  assert.equal(aggregateSessionCost([turn]), undefined);
  assert.deepEqual(aggregateSessionCost([first, second, { ...turn, steps: 0 }]), {
    ...cost, totalUsd: 0.3, uncachedInputUsd: 0.3,
  });
  assert.equal(aggregateSessionCost([first, turn])?.complete, false);
  assert.equal(aggregateSessionCost([first, { ...second, cost: { ...secondCost, complete: false } }])?.complete, false);
  assert.equal(aggregateSessionCost([first, { ...second, cost: { ...secondCost, ratesPerMillion: undefined } }])?.ratesPerMillion, undefined);
  assert.equal(aggregateSessionCost([
    { ...first, cost: { ...cost, totalUsd: 4096.000000000006, uncachedInputUsd: 4096.000000000006 } },
    { ...second, cost: { ...secondCost, totalUsd: 0.000000000001, uncachedInputUsd: 0.000000000001 } },
  ])?.totalUsd, 4096.000000000007);
});

test("USD and per-million formatting follow the compact and detail thresholds", () => {
  for (const [amount, compact, detail] of [
    [-1, "$0", "$0.00"],
    [0, "$0", "$0.00"],
    [0.000012, "<$0.001", "$0.000012"],
    [0.0001, "<$0.001", "$0.0001"],
    [0.001, "$0.0010", "$0.0010"],
    [0.01, "$0.010", "$0.0100"],
    [0.1, "$0.10", "$0.1000"],
    [1.2, "$1.20", "$1.20"],
  ] as const) {
    assert.equal(formatUsd(amount, "compact"), compact);
    assert.equal(formatUsd(amount), detail);
  }
  assert.deepEqual([3, 0.15, 0.075, 0.005, 0.6 * 3].map(formatRatePerMillion), [
    "$3 / 1M", "$0.15 / 1M", "$0.075 / 1M", "$0.005 / 1M", "$1.8 / 1M",
  ]);
});
