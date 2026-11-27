import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as Sqlite from "node:sqlite";
import { SessionReader } from "../server/sessions";
import { averageTtft, cachePercent, speed, statsSchema, totalTokens } from "../shared/stats";

function varint(n: number): number[] {
  return n < 128 ? [n] : [n % 128 + 128, ...varint(Math.floor(n / 128))];
}

function field(tag: number, value: number | Uint8Array): number[] {
  return typeof value === "number"
    ? [...varint(tag * 8), ...varint(value)]
    : [...varint(tag * 8 + 2), ...varint(value.length), ...value];
}

function message(...entries: [number, number | Uint8Array][]): Uint8Array {
  return Uint8Array.from(entries.flatMap(([tag, value]) => field(tag, value)));
}

test("Antigravity reads wrapped sessions, normalizes usage, and refreshes from the WAL", async (t) => {
  const sqlite = process.getBuiltinModule?.("node:sqlite") as typeof Sqlite | undefined;
  if (!sqlite) return t.skip("Node SQLite is unavailable");
  const root = await mkdtemp(join(tmpdir(), "harness-stats-agy-"));
  const id = "11111111-2222-3333-4444-555555555555";
  const dir = join(root, "conversations");
  await mkdir(dir);
  const db = new sqlite.DatabaseSync(join(dir, `${id}.db`));
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)`);
    const step = db.prepare("INSERT INTO steps VALUES (?,?,?)");
    const gen = db.prepare("INSERT INTO gen_metadata VALUES (?,?)");
    const sec = (n: number) => message([1, n]);
    const text = (value: string) => new TextEncoder().encode(value);
    const usage = (id: string) => message(
      [2, 100], [3, 20], [4, 10], [5, 40], [9, 15], [10, 5], [11, text(id)],
    );
    const generation = (index: number, id: string, model = "") => message(
      [1, message([4, usage(id)], [11, sec(1)], [12, sec(2)], [19, text(model)])],
      [2, Uint8Array.from(varint(index))],
    );
    step.run(0, 14, message([1, sec(95)]));
    step.run(1, 15, message([1, sec(96)], [7, sec(99)], [9, usage("planner-one")], [12, text("step-one")]));
    step.run(2, 132, message([4, new Uint8Array()], [32, sec(100)], [8, sec(102)]));
    step.run(3, 14, message([1, sec(103)]));
    step.run(4, 15, message([9, usage("two")], [1, sec(104)], [6, sec(105)], [7, sec(107)], [12, text("step-two")]));
    step.run(5, 132, message([4, new Uint8Array()], [32, sec(108)]));
    gen.run(0, generation(1, "one", "gemini-4-neon"));
    gen.run(1, generation(1, "one"));
    gen.run(2, message([1, message([4, message()])], [2, 4]));

    const reader = new SessionReader({ codex: root, claude: root }, root);
    const handle = `plugin:${JSON.stringify({ version: 1, data: { conversationId: id } })}`;
    const before = statsSchema.parse(await reader.read("antigravity", handle, "/demo"));
    assert.equal(before.source, "session");
    assert.equal(before.turns, 2);
    assert.equal(before.steps, 2);
    assert.equal(totalTokens(before), 340);
    assert.equal(before.cacheWriteTokens, 20);
    assert.equal(cachePercent(before), "27");
    assert.equal(before.modelMs, 6000);
    assert.equal(before.toolMs, 2000);
    assert.equal(averageTtft(before), 1000);
    assert.equal(speed(before), 40 / 6);
    assert.deepEqual(before.turnUsages, [
      {
        turnId: "0", turnNumber: 1, messageIds: ["step-one", "planner-one", "one"],
        startedAtMs: 95000, completedAtMs: 99000,
        routes: [{ provider: "antigravity", model: "gemini-4-neon" }],
        steps: 1, inputTokens: 150, uncachedInputTokens: 100, cachedTokens: 40,
        cacheWriteTokens: 10, outputTokens: 20, reasoningTokens: 15, totalTokens: 170,
      },
      {
        turnId: "3", turnNumber: 2, messageIds: ["step-two", "two"], startedAtMs: 103000,
        completedAtMs: 107000, routes: [],
        steps: 1, inputTokens: 150, uncachedInputTokens: 100, cachedTokens: 40,
        cacheWriteTokens: 10, outputTokens: 20, reasoningTokens: 15, totalTokens: 170,
      },
    ]);

    const sessionHandle = `plugin:${JSON.stringify({ version: 1, data: { sessionId: id } })}`;
    assert.deepEqual(await reader.read("antigravity", sessionHandle, "/demo"), before);
    const withFallback = await reader.read("antigravity", id, "/demo", "fallback-one");
    assert.equal(withFallback.turnUsages[0].routes[0].model, "gemini-4-neon");
    assert.equal(withFallback.turnUsages[1].routes[0].model, "fallback-one");
    withFallback.turnUsages[0].routes[0].model = "changed";
    withFallback.turnUsages[1].messageIds.push("changed");
    const newFallback = await reader.read("antigravity", id, "/demo", "fallback-two");
    assert.equal(newFallback.turnUsages[0].routes[0].model, "gemini-4-neon");
    assert.equal(newFallback.turnUsages[1].routes[0].model, "fallback-two");
    assert.deepEqual(newFallback.turnUsages[1].messageIds, ["step-two", "two"]);

    gen.run(3, generation(4, "two", "gemini-4-second"));
    gen.run(4, generation(6, "three"));
    const after = statsSchema.parse(await reader.read("antigravity", id, "/demo", "fallback-two"));
    assert.equal(after.steps, 3);
    assert.equal(totalTokens(after), 510);
    assert.deepEqual(after.turnUsages[1], {
      ...before.turnUsages[1],
      messageIds: ["step-two", "two", "three"],
      routes: [{ provider: "antigravity", model: "gemini-4-second" }],
      steps: 2, inputTokens: 300, uncachedInputTokens: 200, cachedTokens: 80,
      cacheWriteTokens: 20, outputTokens: 40, reasoningTokens: 30, totalTokens: 340,
    });

    // A generator entry without a prompt index still carries billed usage.
    gen.run(5, message([1, message([4, message([2, 10], [9, 2], [10, 3], [11, text("no-index")])], [19, text("invalid\nmodel")])]));
    gen.run(6, message(
      [1, message([4, message([2, 5], [3, 4], [5, 0], [11, text("before-prompt")])])],
      [2, 0],
    ));
    const unassigned = statsSchema.parse(await reader.read("antigravity", id, "/demo", "fallback-two"));
    assert.equal(unassigned.turns, 2);
    assert.deepEqual(unassigned.turnUsages.map((turn) => turn.turnNumber), [1, 2, 3]);
    assert.deepEqual(unassigned.turnUsages[0], {
      turnId: "initial", turnNumber: 1, messageIds: ["no-index", "before-prompt"],
      startedAtMs: null, completedAtMs: null,
      routes: [{ provider: "antigravity", model: "fallback-two" }],
      steps: 2, inputTokens: 15, uncachedInputTokens: 15, cachedTokens: 0,
      outputTokens: 9, reasoningTokens: 2, totalTokens: 24,
    });
    assert.equal((await reader.read("antigravity", "plugin:{", "/demo")).source, "unavailable");
    assert.equal((await reader.read("antigravity", "../outside", "/demo")).source, "unavailable");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
