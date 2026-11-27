import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionFold } from "../server/fold";
import { valuesSchema } from "../shared/preferences";
import {
  cachePercent, emptyStats, formatCacheHitPercent, formatDuration, formatExactTokens,
  statsSchema, totalTokens, turnCachePercent, turnUsageSchema,
} from "../shared/stats";

const at = (seconds: number) => new Date(seconds * 1000).toISOString();
const usage = (input: number, cached: number, output: number) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
});
const event = (type: string, seconds: number, payload = {}) => ({
  type: "event_msg",
  timestamp: at(seconds),
  payload: { type, ...payload },
});
const response = (id: string, seconds: number, turn = "t1") => ({
  type: "token_usage_record",
  timestamp: at(seconds),
  payload: { response_id: id, turn_id: turn, usage: usage(1000, 600, 100) },
});
const item = (type: string, id: string, seconds: number) => ({
  type: "response_item",
  timestamp: at(seconds),
  payload: { type, call_id: id },
});

test("Codex deduplicates response IDs and compatibility token_count events", () => {
  const fold = new SessionFold("codex");
  fold.apply(event("task_started", 1, { turn_id: "t1" }));
  fold.apply(response("r1", 3));
  fold.apply(response("r1", 3));
  fold.apply(event("token_count", 3, { info: { total_token_usage: usage(1000, 600, 100) } }));
  fold.apply(response("r2", 5));
  fold.apply(event("task_started", 10, { turn_id: "t2" }));
  fold.apply(response("r3", 12, "t2"));
  assert.equal(fold.stats.steps, 3);
  assert.equal(fold.stats.turns, 2);
  assert.equal(totalTokens(fold.stats), 3300);
  assert.equal(cachePercent(fold.stats), "60");
});

test("Parallel tools and user idle time do not dilute model speed", () => {
  const fold = new SessionFold("codex");
  for (const row of [
    event("task_started", 1, { turn_id: "t1" }),
    item("function_call", "a", 3),
    item("function_call", "b", 3),
    response("r1", 3),
    item("function_call_output", "a", 20),
    item("function_call_output", "b", 30),
    response("r2", 32),
    event("task_completed", 33),
    event("task_started", 1000, { turn_id: "t2" }),
    response("r3", 1002, "t2"),
  ])
    fold.apply(row);
  assert.equal(fold.stats.modelMs, 6000);
  assert.equal(fold.stats.timedOutputTokens, 300);
  assert.equal(fold.stats.toolMs, 44_000);
});

test("Old Codex usage ignores repeats and survives counter resets", () => {
  const fold = new SessionFold("codex");
  fold.apply(event("task_started", 1, { turn_id: "old" }));
  for (const [seconds, u] of [
    [2, usage(1000, 600, 100)],
    [3, usage(1000, 600, 100)],
    [4, usage(3000, 1200, 300)],
    [5, usage(500, 0, 50)],
  ] as const) {
    fold.apply(event("token_count", seconds, { info: { total_token_usage: u } }));
  }
  assert.equal(fold.stats.steps, 3);
  assert.equal(fold.stats.inputTokens, 3500);
  assert.equal(fold.stats.outputTokens, 350);
  assert.equal(fold.stats.cachedTokens, 1200);
});

test("Claude merges streamed blocks by message ID, including cache writes once", () => {
  const fold = new SessionFold("claude");
  fold.apply({ type: "user", uuid: "u1", timestamp: at(1), message: { content: "hello" } });
  const assistant = (output: number, seconds: number) => ({
    type: "assistant",
    timestamp: at(seconds),
    message: {
      id: "msg1",
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 600,
        cache_creation_input_tokens: 300,
        output_tokens: output,
      },
    },
  });
  fold.apply(assistant(1, 2));
  fold.apply(assistant(100, 3));
  fold.apply(assistant(100, 3));
  assert.equal(fold.stats.steps, 1);
  assert.equal(fold.stats.turns, 1);
  assert.equal(totalTokens(fold.stats), 1100);
  assert.equal(fold.stats.cacheWriteTokens, 300);
  assert.equal(fold.stats.modelMs, 2000);
  assert.equal(fold.stats.timedOutputTokens, 100);
});

test("Claude tool results stay in one turn; errors and sidechains are excluded", () => {
  const fold = new SessionFold("claude");
  fold.apply({ type: "user", uuid: "u1", timestamp: at(1), message: { content: "hi" } });
  const assistant = (id: string) => ({
    type: "assistant",
    timestamp: at(3),
    message: { id, usage: { input_tokens: 10, output_tokens: 10 } },
  });
  fold.apply(assistant("a"));
  fold.apply({
    type: "user",
    uuid: "tool",
    timestamp: at(4),
    message: { content: [{ type: "tool_result" }] },
  });
  fold.apply(assistant("b"));
  fold.apply({ ...assistant("side"), isSidechain: true });
  fold.apply({ ...assistant("error"), isApiErrorMessage: true });
  assert.equal(fold.stats.steps, 2);
  assert.equal(fold.stats.turns, 1);
});

test("No billed input has no hit rate; near-full cache reads stay below 100%", () => {
  const fold = new SessionFold("codex");
  assert.equal(cachePercent(fold.stats), null);
  fold.stats.inputTokens = 100000;
  fold.stats.cachedTokens = 99999;
  assert.notEqual(cachePercent(fold.stats), "100");
});

test("Chinese durations retain the original DSH minute and second notation", () => {
  assert.equal(formatDuration(1_247_000, "zh-CN"), "20分47秒");
  assert.equal(formatDuration(246_000, "zh-CN"), "4分6秒");
  assert.equal(formatDuration(13_900, "zh-CN"), "13.9秒");
});

test("New Codex output-item timestamps produce TTFT while tool-only starts stay uncounted", () => {
  const fold = new SessionFold("codex");
  fold.apply(event("task_started", 1, { turn_id: "t1" }));
  fold.apply({ type: "turn_context", timestamp: at(2), payload: { turn_id: "t1" } });
  fold.apply(event("item_completed", 6, { item: { type: "AgentMessage" }, started_at_ms: 4000 }));
  fold.apply(response("r1", 7));
  assert.equal(fold.stats.ttftMs, 2000);
  assert.equal(fold.stats.ttftSteps, 1);
  fold.apply(item("function_call_output", "a", 10));
  fold.apply(item("function_call", "b", 12));
  fold.apply(response("r2", 13));
  assert.equal(fold.stats.ttftSteps, 1);
  fold.apply(item("function_call_output", "b", 15));
  fold.apply(event("item_completed", 19, { item: { type: "Reasoning" }, started_at_ms: 16000 }));
  fold.apply(response("r3", 20));
  assert.equal(fold.stats.ttftSteps, 2);
  assert.equal(fold.stats.ttftMs, 3000);
});

test("Claude thinking duration and parent timestamps recover TTFT only for completed first thinking blocks", () => {
  const fold = new SessionFold("claude");
  fold.apply({ type: "user", uuid: "u", timestamp: at(1), message: { content: "hello" } });
  const part = (content: unknown[], seconds: number, extra = {}, stop: string | null = null) => ({
    type: "assistant",
    uuid: `a${seconds}`,
    parentUuid: "u",
    apiBlockIndex: 0,
    timestamp: at(seconds),
    ...extra,
    message: {
      id: "m",
      stop_reason: stop,
      content,
      usage: { input_tokens: 10, output_tokens: 100 },
    },
  });
  fold.apply(part([{ type: "thinking" }], 6, { thinkingDurationMs: 2000 }));
  assert.equal(fold.stats.ttftSteps, 0);
  fold.apply(part([{ type: "text" }], 10, {}, "end_turn"));
  fold.apply(part([{ type: "text" }], 10, {}, "end_turn"));
  assert.equal(fold.stats.ttftSteps, 1);
  assert.equal(fold.stats.ttftMs, 3000);
  const plain = new SessionFold("claude");
  plain.apply({ type: "user", uuid: "u", timestamp: at(1), message: { content: "hello" } });
  plain.apply(part([{ type: "text" }], 10, {}, "end_turn"));
  assert.equal(plain.stats.ttftSteps, 0);
});

test("A session upgraded from old to new Codex retains all earlier billed usage", () => {
  const fold = new SessionFold("codex");
  fold.apply(event("task_started", 1, { turn_id: "old" }));
  fold.apply(event("token_count", 2, { info: { total_token_usage: usage(1000, 600, 100) } }));
  assert.equal(fold.snapshot().cost, undefined);
  fold.apply({ type: "turn_context", timestamp: at(3), payload: { turn_id: "old", model: "auto/gpt-6.2-sol" } });
  fold.apply(event("task_started", 10, { turn_id: "new" }));
  fold.apply({ type: "turn_context", timestamp: at(11), payload: { turn_id: "new", model: "codex/gpt-6.2-sol" } });
  fold.apply(response("new-1", 12, "new"));
  assert.equal(fold.stats.steps, 2);
  assert.equal(fold.stats.turns, 2);
  assert.equal(totalTokens(fold.stats), 2200);
  const { cost, turnUsages } = statsSchema.parse(fold.snapshot());
  assert.deepEqual(turnUsages.map((turn) => turn.cost?.totalUsd), [0.00186, 0.00186]);
  assert.deepEqual(cost, {
    currency: "USD", complete: true, totalUsd: 0.00372,
    uncachedInputUsd: 0.0016, cachedInputUsd: 0.00012, cacheWriteUsd: 0, outputUsd: 0.002,
    ratesPerMillion: { uncachedInput: 2, cachedInput: 0.1, output: 10 },
  });
});

test("Codex prices session metadata, per-request long context and in-turn model changes", () => {
  const fold = new SessionFold("codex");
  for (const row of [
    { type: "session_meta", payload: { model: "openai/gpt-6.2-sol" } },
    event("task_started", 1, { turn_id: "t1" }),
    response("short", 2),
    { ...response("long", 3), payload: { response_id: "long", turn_id: "t1", usage: usage(272_001, 72_001, 100) } },
    { type: "turn_context", timestamp: at(4), payload: { turn_id: "t1", model: "openai/gpt-5.4-mini" } },
    response("mini", 5),
    response("mini", 5),
    event("token_count", 5, { info: { total_token_usage: usage(100_000, 10, 100) } }),
    event("task_started", 6, { turn_id: "t2" }),
    { type: "turn_context", timestamp: at(7), payload: { turn_id: "t2", model: "deepseek-v4-pro-0813" } },
    response("pro", 8, "t2"),
  ]) fold.apply(row);

  const stats = statsSchema.parse(fold.snapshot());
  assert.deepEqual(stats.turnUsages[0].cost, {
    currency: "USD", complete: true, totalUsd: 0.8185552,
    uncachedInputUsd: 0.8011, cachedInputUsd: 0.0145052, cacheWriteUsd: 0, outputUsd: 0.00295,
  });
  assert.equal(stats.turnUsages[1].cost?.totalUsd, 0.0009504);
  assert.equal(stats.cost?.totalUsd, 0.8195056);
  assert.equal(stats.cost?.ratesPerMillion, undefined);
  assert.equal(
    Math.round(stats.cost!.totalUsd * 1e12),
    stats.turnUsages.reduce((sum, turn) => sum + Math.round(turn.cost!.totalUsd * 1e12), 0),
  );
});

test("A known model is never substituted for an explicitly unknown Codex or Claude model", () => {
  const codex = new SessionFold("codex");
  codex.apply({ type: "session_meta", payload: { model: "gpt-oss-120b-medium" } });
  codex.apply(response("unknown", 2));
  assert.equal(codex.snapshot("gpt-6.2-sol").turnUsages[0].cost, undefined);
  assert.equal(codex.snapshot("gpt-6.2-sol").cost, undefined);

  const claude = new SessionFold("claude");
  const message = (id: string, model: string, seconds: number) => ({
    type: "assistant", timestamp: at(seconds),
    message: { id, model, usage: { input_tokens: 100, output_tokens: 10 } },
  });
  claude.apply(message("private", "private/model", 1));
  assert.equal(claude.snapshot("claude-opus-5-5").cost, undefined);
  claude.apply(message("opus", "claude-opus-5-5", 2));
  const stats = claude.snapshot("claude-opus-5-5");
  assert.deepEqual(stats.turnUsages[0].cost, {
    currency: "USD", complete: false, totalUsd: 0.0006,
    uncachedInputUsd: 0.0004, cachedInputUsd: 0, cacheWriteUsd: 0, outputUsd: 0.0002,
  });
  assert.deepEqual(stats.cost, stats.turnUsages[0].cost);
});

test("Codex prices a deferred mixed-route step from each read's fallback", () => {
  const fold = new SessionFold("codex");
  fold.apply(response("deferred", 1));
  for (const [seconds, model] of [[2, "gpt-6.2-sol"], [4, "gpt-5.4-mini"]] as const) {
    fold.apply({ type: "turn_context", timestamp: at(seconds), payload: { turn_id: "t1", model } });
    fold.apply(response(model, seconds + 1));
  }
  assert.equal(fold.snapshot().cost?.complete, false);
  assert.equal(fold.snapshot("gpt-6.2-sol").cost?.totalUsd, 0.004515);
  assert.equal(fold.snapshot("gpt-5.4-mini").cost?.totalUsd, 0.00345);
  assert.equal(fold.snapshot("gpt-5.4-mini").cost?.complete, true);
  assert.equal(fold.snapshot().cost?.totalUsd, 0.002655);
});

test("Claude replaces streamed output and both cache TTLs without accumulating drift", () => {
  const fold = new SessionFold("claude");
  const assistant = (seconds: number, usage: object, model?: string, id = "msg") => ({
    type: "assistant", timestamp: at(seconds), message: { id, model, usage },
  });
  const cache_creation = (short: number, long: number) => ({
    ephemeral_5m_input_tokens: short, ephemeral_1h_input_tokens: long,
  });
  fold.apply(assistant(1, {
    input_tokens: 1, cache_read_input_tokens: 3, cache_creation_input_tokens: 10,
    cache_creation: cache_creation(4, 6), output_tokens: 1,
  }, "claude-opus-5-5"));
  assert.equal(fold.snapshot().turnUsages[0].cost?.totalUsd, 0.0000926);
  assert.equal(fold.snapshot().turnUsages[0].cost?.ratesPerMillion?.cacheWrite, undefined);
  assert.equal(fold.snapshot().cost?.ratesPerMillion, undefined);

  for (let i = 0; i < 20; i++) {
    fold.apply(assistant(i * 2 + 2, { output_tokens: 137 }));
    fold.apply(assistant(i * 2 + 3, { output_tokens: 2 }));
  }
  assert.deepEqual(fold.snapshot().turnUsages[0].cost, {
    currency: "USD", complete: true, totalUsd: 0.0001126,
    uncachedInputUsd: 0.000004, cachedInputUsd: 0.0000006, cacheWriteUsd: 0.000068, outputUsd: 0.00004,
    ratesPerMillion: { uncachedInput: 4, cachedInput: 0.2, output: 20 },
  });

  fold.apply(assistant(42, { cache_creation: cache_creation(10, 0) }));
  fold.apply(assistant(43, { output_tokens: 1 }, "anthropic/claude-opus-5.5", "second"));
  const stats = statsSchema.parse(fold.snapshot());
  assert.deepEqual(stats.cost, {
    currency: "USD", complete: true, totalUsd: 0.0001146,
    uncachedInputUsd: 0.000004, cachedInputUsd: 0.0000006, cacheWriteUsd: 0.00005, outputUsd: 0.00006,
    ratesPerMillion: { uncachedInput: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 },
  });
  assert.deepEqual(stats.cost, stats.turnUsages[0].cost);
  assert.equal(stats.steps, 2);
  assert.equal(stats.inputTokens, 14);
  assert.equal(stats.outputTokens, 3);
});

test("Claude cache writes reported through split fields alone can be replaced or removed", () => {
  const fold = new SessionFold("claude");
  const assistant = (seconds: number, writes: number, model?: string) => ({
    type: "assistant", timestamp: at(seconds), message: {
      id: "msg", model, usage: { cache_creation: { ephemeral_1h_input_tokens: writes } },
    },
  });
  fold.apply(assistant(1, 10));
  assert.equal(fold.snapshot("claude-opus-5-5").cost?.totalUsd, 0.00008);
  fold.apply(assistant(2, 3, "claude-opus-5-5"));
  assert.equal(fold.snapshot().cost?.totalUsd, 0.000024);
  assert.equal(fold.snapshot().turnUsages[0].cost?.ratesPerMillion?.cacheWrite, 8);
  fold.apply(assistant(3, 0));
  assert.equal(fold.snapshot().cost, undefined);
  assert.deepEqual(fold.snapshot().turnUsages, []);
});

test("Stream replacement removes the original rate when undated steps cross a price change", (t) => {
  const effectiveAt = Date.UTC(2026, 11, 1);
  let now = effectiveAt - 1;
  t.mock.method(Date, "now", () => now);
  const fold = new SessionFold("claude");
  const assistant = (output: number) => ({
    type: "assistant",
    message: { id: "msg", model: "gemini-4-argon", usage: { input_tokens: 10, output_tokens: output } },
  });
  fold.apply(assistant(1));
  assert.equal(fold.snapshot().cost?.totalUsd, 0.00003);
  now = effectiveAt;
  fold.apply(assistant(2));
  assert.equal(fold.snapshot().cost?.totalUsd, 0.00008);
  assert.deepEqual(fold.snapshot().cost?.ratesPerMillion, { uncachedInput: 4, cachedInput: 0.2, output: 20 });
});

test("Stored preferences and stats without turn usage receive defaults", () => {
  assert.deepEqual(valuesSchema.parse({ enabled: false, mobilePlacement: "track" }), {
    enabled: false, turnUsageEnabled: true, mobilePlacement: "track",
  });
  assert.equal(valuesSchema.parse({ turnUsageEnabled: false }).turnUsageEnabled, false);
  const { turnUsages, ...legacy } = emptyStats("codex");
  assert.deepEqual(statsSchema.parse(legacy).turnUsages, turnUsages);
});

test("Cache percentages round ordinary hits and expand partial hits near 100", () => {
  assert.equal(formatCacheHitPercent(0, 0), null);
  assert.equal(formatCacheHitPercent(1, -1, 1), null);
  assert.equal(formatCacheHitPercent(0, 100, 1), "0");
  assert.equal(formatCacheHitPercent(40, 40), "100");
  assert.equal(formatCacheHitPercent(41, 40, 1), "100");
  assert.equal(formatCacheHitPercent(1, 2, 1), "50");
  assert.equal(formatCacheHitPercent(497, 1000, 1), "49.7");
  assert.equal(formatCacheHitPercent(497, 1000), "50");
  assert.equal(formatCacheHitPercent(999, 1000), "99.9");
  assert.equal(formatCacheHitPercent(999, 1000, 1), "99.9");
  assert.equal(formatCacheHitPercent(9999, 10000, 1), "99.99");
  assert.equal(formatCacheHitPercent(9995, 10000, 1), "99.95");
  assert.equal(formatCacheHitPercent(9999, 10000), "99.99");
  assert.equal(formatCacheHitPercent(99995, 100000), "99.995");
  assert.equal(
    formatCacheHitPercent(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER),
    "99.99999999999999",
  );
  assert.equal(formatCacheHitPercent(0.9999, 1, 1), "99.99");

  const turn = turnUsageSchema.parse({
    turnNumber: 1, steps: 1, inputTokens: 1000, uncachedInputTokens: 1000,
    outputTokens: 10, totalTokens: 1010,
  });
  assert.equal(turnCachePercent(turn), null);
  assert.equal(turnCachePercent({ ...turn, cachedTokens: 0, inputTokens: 0 }), null);
  assert.equal(turnCachePercent({ ...turn, cachedTokens: 0 }), "0");
  assert.equal(turnCachePercent({ ...turn, cachedTokens: 500 }), "50");
  assert.equal(turnCachePercent({ ...turn, cachedTokens: 497 }), "49.7");
  assert.equal(turnCachePercent({ ...turn, cachedTokens: 1000 }), "100");
  assert.equal(turnCachePercent({ ...turn, cachedTokens: 999 }), "99.9");
  assert.equal(turnCachePercent({ ...turn, inputTokens: 10000, cachedTokens: 9999 }), "99.99");
  assert.equal(formatExactTokens(0), "0");
  assert.equal(formatExactTokens(999), "999");
  assert.equal(formatExactTokens(15811), "15,811");
  assert.equal(formatExactTokens(Number.MAX_SAFE_INTEGER), "9,007,199,254,740,991");
});

test("Codex turn usage tracks billed steps, routes, ids and timing in log order", () => {
  const fold = new SessionFold("codex", "fallback-model");
  const context = (turn_id: string, model: string, seconds: number) => ({
    type: "turn_context", timestamp: at(seconds), payload: { turn_id, model },
  });
  const message = (id: string, seconds: number, role = "assistant") => ({
    type: "response_item", timestamp: at(seconds), payload: { type: "message", role, id },
  });
  for (const row of [
    event("task_started", 9, { turn_id: "t1", started_at: 8 }),
    event("task_started", 11, { turn_id: "t1", started_at: 10 }),
    context("t1", "model-a", 12),
    message("assistant-1", 13),
    {
      ...response("r1", 14),
      payload: {
        response_id: "r1", turn_id: "t1",
        usage: { ...usage(1000, 600, 100), cache_write_input_tokens: 50, reasoning_output_tokens: 60 },
      },
    },
    message("r1", 15),
    context("t1", "model-b", 16),
    context("t1", "model-a", 17),
    response("r2", 18),
    response("r2", 19),
    event("task_complete", 21, { turn_id: "t1", completed_at: 23 }),
    event("token_count", 22, { info: { total_token_usage: usage(4000, 1000, 300) } }),
    message("user-message", 23.5, "user"),
    event("task_started", 24, { turn_id: "empty" }),
    { ...response("r-empty", 25, "empty"), payload: { turn_id: "empty", usage: {} } },
    event("turn_aborted", 26),
    event("task_started", 27, { turn_id: "t2", started_at: 1_700_000_000_000 }),
    {
      type: "token_usage_record",
      payload: {
        response_id: "r3", turn_id: "t2",
        usage: {
          input_tokens: 10, output_tokens: 5, cached_input_tokens: -2,
          cache_write_input_tokens: "0", reasoning_output_tokens: null,
        },
      },
    },
    event("task_completed", 28, { completed_at: 1_700_000_005_000 }),
  ]) fold.apply(row);

  const stats = statsSchema.parse(fold.snapshot());
  assert.deepEqual(stats.turnUsages, [
    {
      turnId: "t1", turnNumber: 1, messageIds: ["assistant-1", "r1", "r2"],
      startedAtMs: 8000, completedAtMs: 23000,
      routes: [{ provider: "codex", model: "model-a" }, { provider: "codex", model: "model-b" }],
      steps: 2, inputTokens: 2000, uncachedInputTokens: 750, cachedTokens: 1200,
      cacheWriteTokens: 50, outputTokens: 200, reasoningTokens: 60, totalTokens: 2200,
    },
    {
      turnId: "t2", turnNumber: 2, messageIds: ["r3"],
      startedAtMs: 1_700_000_000_000, completedAtMs: 1_700_000_005_000,
      routes: [{ provider: "codex", model: "fallback-model" }],
      steps: 1, inputTokens: 10, uncachedInputTokens: 10, outputTokens: 5, totalTokens: 15,
    },
  ]);
  assert.equal(stats.steps, 4);
  assert.equal(stats.turns, 3);
  fold.apply(message("assistant-2", 29));
  assert.deepEqual(fold.stats.turnUsages[1].messageIds, ["r3", "assistant-2"]);
  assert.deepEqual(stats.turnUsages[1].messageIds, ["r3"]);
});

test("Legacy Codex turn usage carries optional deltas through missing reports, resets and upgrade", () => {
  const fold = new SessionFold("codex");
  const legacy = (seconds: number, input: number, output: number, optional = {}) =>
    event("token_count", seconds, {
      info: { total_token_usage: { input_tokens: input, output_tokens: output, ...optional } },
    });
  for (const row of [
    event("task_started", 1),
    legacy(2, 100, 20, { cached_input_tokens: 40, reasoning_output_tokens: 8 }),
    legacy(3, 200, 40),
    legacy(4, 300, 60, { cached_input_tokens: 70, reasoning_output_tokens: 24 }),
    legacy(5, 300, 60, { cached_input_tokens: 70, reasoning_output_tokens: 24 }),
    event("task_started", 6, { turn_id: "after-reset" }),
    legacy(7, 50, 10, { cached_input_tokens: 0, reasoning_output_tokens: 2 }),
    response("modern", 8, "after-reset"),
    legacy(9, 1050, 110),
  ]) fold.apply(row);

  const stats = statsSchema.parse(fold.stats);
  assert.deepEqual(stats.turnUsages, [
    {
      turnId: at(1), turnNumber: 1, messageIds: [], startedAtMs: 1000, completedAtMs: 5000, routes: [],
      steps: 3, inputTokens: 300, uncachedInputTokens: 230, cachedTokens: 70,
      outputTokens: 60, reasoningTokens: 24, totalTokens: 360,
    },
    {
      turnId: "after-reset", turnNumber: 2, messageIds: ["modern"],
      startedAtMs: 6000, completedAtMs: 9000, routes: [],
      steps: 2, inputTokens: 1050, uncachedInputTokens: 450, cachedTokens: 600,
      outputTokens: 110, reasoningTokens: 2, totalTokens: 1160,
    },
  ]);
  assert.equal(totalTokens(stats), 1520);
});

test("Legacy Codex uses distinct start timestamps for multiple tasks without turn IDs", () => {
  const fold = new SessionFold("codex");
  for (const row of [
    event("task_started", 1),
    event("token_count", 2, { info: { total_token_usage: usage(100, 20, 10) } }),
    event("task_started", 5),
    event("token_count", 6, { info: { total_token_usage: usage(300, 70, 40) } }),
  ]) fold.apply(row);

  const { turns, turnUsages } = statsSchema.parse(fold.snapshot());
  assert.equal(turns, 2);
  assert.deepEqual(turnUsages.map(({ turnId, turnNumber, totalTokens }) => ({
    turnId,
    turnNumber,
    totalTokens,
  })), [
    { turnId: at(1), turnNumber: 1, totalTokens: 110 },
    { turnId: at(5), turnNumber: 2, totalTokens: 230 },
  ]);
});

test("Codex retains start and model metadata when the turn ID first appears with usage", () => {
  const fold = new SessionFold("codex");
  fold.apply(event("task_started", 1));
  fold.apply({ type: "turn_context", timestamp: at(2), payload: { model: "late-id-model" } });
  fold.apply(response("r1", 3));
  const [turn] = statsSchema.parse(fold.stats).turnUsages;
  assert.equal(turn.turnId, "t1");
  assert.equal(turn.startedAtMs, 1000);
  assert.deepEqual(turn.routes, [{ provider: "codex", model: "late-id-model" }]);
});

test("Claude updates the original turn when streamed blocks arrive after a new prompt", () => {
  const fold = new SessionFold("claude", "fallback");
  const user = (uuid: string, seconds: number) => ({ type: "user", uuid, timestamp: at(seconds) });
  const assistant = (id: string, uuid: string, seconds: number, model: string, usage: object) => ({
    type: "assistant", uuid, timestamp: at(seconds), message: { id, model, usage },
  });
  for (const row of [
    user("first", 1),
    assistant("a", "a-0", 2, "model-a", {
      input_tokens: 100, cache_read_input_tokens: 600, cache_creation_input_tokens: 300,
      output_tokens: 10, output_tokens_details: { thinking_tokens: 3 },
    }),
    { ...user("result", 3), message: { content: [{ type: "tool_result" }] } },
    assistant("b", "b-0", 4, "model-b", { input_tokens: 20, output_tokens: 5 }),
    { ...user("meta", 5), isMeta: true },
    assistant("b", "b-1", 6, "model-b", { output_tokens: 10 }),
    user("second", 7),
    assistant("c", "c-0", 9, "", { input_tokens: 40, output_tokens: 20, cache_read_input_tokens: 0 }),
    assistant("a", "a-1", 10, "model-a", { output_tokens: 50, output_tokens_details: { thinking_tokens: 9 } }),
    assistant("a", "a-1", 10, "model-a", { output_tokens: 50 }),
    { ...assistant("side", "side-0", 11, "side", { input_tokens: 100 }), isSidechain: true },
    { ...assistant("error", "error-0", 11, "error", { input_tokens: 100 }), isApiErrorMessage: true },
    { type: "assistant", timestamp: at(12), uuid: "c-1", message: { id: "c" } },
    { type: "assistant", timestamp: at(13), uuid: "c-2", message: {} },
    assistant("synthetic", "synthetic-0", 14, "<synthetic>", { input_tokens: 0, output_tokens: 0 }),
  ]) fold.apply(row);

  const stats = statsSchema.parse(fold.snapshot());
  assert.deepEqual(stats.turnUsages, [
    {
      turnId: "first", turnNumber: 1, messageIds: ["a", "a-0", "b", "b-0", "b-1", "a-1"],
      startedAtMs: 1000, completedAtMs: 10000,
      routes: [{ provider: "claude", model: "model-a" }, { provider: "claude", model: "model-b" }],
      steps: 2, inputTokens: 1020, uncachedInputTokens: 120, cachedTokens: 600,
      cacheWriteTokens: 300, outputTokens: 60, reasoningTokens: 9, totalTokens: 1080,
    },
    {
      turnId: "second", turnNumber: 2, messageIds: ["c", "c-0", "c-1", "c-2"],
      startedAtMs: 7000, completedAtMs: 13000, routes: [{ provider: "claude", model: "fallback" }],
      steps: 1, inputTokens: 40, uncachedInputTokens: 40, cachedTokens: 0, outputTokens: 20, totalTokens: 60,
    },
  ]);
  assert.equal(stats.steps, 4);
});
