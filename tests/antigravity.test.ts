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
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      INSERT INTO steps VALUES (0,14,NULL),(3,14,NULL)`);
    const step = db.prepare("INSERT INTO steps VALUES (?,?,?)");
    const gen = db.prepare("INSERT INTO gen_metadata VALUES (?,?)");
    const sec = (n: number) => message([1, n]);
    const usage = (id: string) => message(
      [2, 100], [3, 20], [4, 10], [5, 40], [9, 15], [10, 5], [11, new TextEncoder().encode(id)],
    );
    const generation = (index: number, id: string) => message(
      [1, message([4, usage(id)], [11, sec(1)], [12, sec(2)])],
      [2, Uint8Array.from(varint(index))],
    );
    step.run(1, 15, message([9, usage("one")]));
    step.run(2, 132, message([4, new Uint8Array()], [32, sec(100)], [8, sec(102)]));
    step.run(4, 15, message([9, usage("two")], [1, sec(104)], [6, sec(105)], [7, sec(107)]));
    step.run(5, 132, message([4, new Uint8Array()], [32, sec(108)]));
    gen.run(0, generation(1, "one"));
    gen.run(1, generation(1, "one"));

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

    const sessionHandle = `plugin:${JSON.stringify({ version: 1, data: { sessionId: id } })}`;
    assert.deepEqual(await reader.read("antigravity", sessionHandle, "/demo"), before);

    gen.run(2, generation(4, "two"));
    gen.run(3, generation(6, "three"));
    const after = await reader.read("antigravity", id, "/demo");
    assert.equal(after.steps, 3);
    assert.equal(totalTokens(after), 510);
    assert.equal((await reader.read("antigravity", "plugin:{", "/demo")).source, "unavailable");
    assert.equal((await reader.read("antigravity", "../outside", "/demo")).source, "unavailable");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
