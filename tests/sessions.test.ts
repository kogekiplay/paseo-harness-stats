import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionReader } from "../server/sessions";
import { statsSchema } from "../shared/stats";

test("Incremental reads wait for complete lines, share concurrent reads, and handle truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-stats-"));
  try {
    const id = "11111111-2222-3333-4444-555555555555";
    const dir = join(root, "sessions", "2026", "11", "16");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `rollout-2026-11-16T12-00-00-${id}.jsonl`);
    const row = (response: string) =>
      JSON.stringify({
        type: "token_usage_record",
        payload: {
          response_id: response,
          turn_id: "t",
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      });
    const first = row("r1");
    await writeFile(path, first.slice(0, 40));
    const reader = new SessionReader({ codex: root, claude: root });
    assert.equal((await reader.read("codex", id, "/x")).steps, 0);
    await appendFile(path, first.slice(40) + "\n");
    const results = await Promise.all([
      reader.read("codex", id, "/x", "fallback-a"),
      reader.read("codex", id, "/x", "fallback-b"),
    ]);
    assert.deepEqual(
      results.map((s) => s.steps),
      [1, 1],
    );
    assert.deepEqual(results.map((s) => s.turnUsages[0].routes[0].model), ["fallback-a", "fallback-b"]);
    results[0].turnUsages[0].messageIds.push("changed");
    results[0].turnUsages[0].routes[0].model = "changed";
    results[0].turnUsages.push(results[0].turnUsages[0]);
    const latest = statsSchema.parse(await reader.read("codex", id, "/x", "fallback-c"));
    assert.deepEqual(latest.turnUsages[0].messageIds, ["r1"]);
    assert.deepEqual(latest.turnUsages[0].routes, [{ provider: "codex", model: "fallback-c" }]);
    assert.equal(latest.turnUsages.length, 1);
    assert.deepEqual((await reader.read("codex", id, "/x")).turnUsages[0].routes, []);

    const context = JSON.stringify({ type: "turn_context", payload: { turn_id: "t", model: "known" } });
    await appendFile(path, context + "\n" + row("r2") + "\n");
    const appended = statsSchema.parse(await reader.read("codex", id, "/x", "fallback-d"));
    assert.equal(appended.steps, 2);
    assert.deepEqual(appended.turnUsages[0].messageIds, ["r1", "r2"]);
    assert.deepEqual(appended.turnUsages[0].routes, [{ provider: "codex", model: "known" }]);
    assert.deepEqual(latest.turnUsages[0].messageIds, ["r1"]);
    assert.equal(latest.turnUsages[0].steps, 1);
    assert.deepEqual(results[1].turnUsages[0].messageIds, ["r1"]);
    assert.deepEqual(results[1].turnUsages[0].routes, [{ provider: "codex", model: "fallback-b" }]);
    await writeFile(path, row("r3") + "\n");
    const truncated = statsSchema.parse(await reader.read("codex", id, "/x", "fallback-e"));
    assert.equal(truncated.steps, 1);
    assert.deepEqual(truncated.turnUsages[0].messageIds, ["r3"]);
    assert.deepEqual(truncated.turnUsages[0].routes, [{ provider: "codex", model: "fallback-e" }]);
    await appendFile(path, row("r4") + "\ninvalid JSON\n");
    await Promise.all([
      assert.rejects(reader.read("codex", id, "/x"), /invalid JSON line/),
      assert.rejects(reader.read("codex", id, "/x"), /invalid JSON line/),
    ]);
    await writeFile(path, row("r3") + "\n" + row("r4") + "\n");
    const recovered = statsSchema.parse(await reader.read("codex", id, "/x"));
    assert.deepEqual(recovered.turnUsages[0].messageIds, ["r3", "r4"]);
    assert.equal(recovered.steps, 2);
    assert.equal((await reader.read("codex", "../../outside", "/x")).source, "unavailable");
    assert.equal((await reader.read("other", id, "/x")).source, "unsupported");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
