import { test } from "node:test";
import assert from "node:assert/strict";
import { StatsCache } from "../client/cache";
import { emptyStats, type Stats } from "../shared/stats";

test("Prefetch is bounded, shares foreground requests and preserves stats across mounts", async () => {
  const finish = new Map<string, (stats: Stats) => void>();
  const calls: string[] = [];
  const cache = new StatsCache((id) => {
    calls.push(id);
    return new Promise((resolve) => {
      finish.set(id, resolve);
    });
  });
  cache.prefetch("a");
  cache.prefetch("b");
  cache.prefetch("c");
  assert.deepEqual(calls, ["a", "b"]);
  const visible = cache.read("a");
  assert.deepEqual(calls, ["a", "b"]);
  const stats = { ...emptyStats("codex"), turns: 5, steps: 66 };
  finish.get("a")!(stats);
  await visible;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cache.peek("a")?.steps, 66);
  assert.deepEqual(calls, ["a", "b", "c"]);
  cache.prefetch("a");
  assert.equal(calls.length, 3);
  finish.get("b")!(stats);
  finish.get("c")!(stats);
  await new Promise((resolve) => setImmediate(resolve));
  cache.clear();
  assert.equal(cache.peek("a"), undefined);
});
