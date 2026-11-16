import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionFold } from "../server/fold";
import { cachePercent, formatDuration, totalTokens } from "../shared/stats";

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
  fold.apply(event("task_started", 10, { turn_id: "new" }));
  fold.apply(response("new-1", 12, "new"));
  assert.equal(fold.stats.steps, 2);
  assert.equal(fold.stats.turns, 2);
  assert.equal(totalTokens(fold.stats), 2200);
});
