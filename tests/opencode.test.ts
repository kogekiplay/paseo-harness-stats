import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OpenCodeReader } from "../server/opencode";
import { SessionReader } from "../server/sessions";
import { statsSchema } from "../shared/stats";

const session = "ses_fixture";
const now = 1_800_000_000_000;

function createV1(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    INSERT INTO session VALUES ('ses_fixture'), ('ses_other');
  `);
}

function insertMessage(db: DatabaseSync, id: string, ms: number, data: object, sessionId = session) {
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(id, sessionId, now + ms, JSON.stringify(data));
}

function insertPart(db: DatabaseSync, id: string, messageId: string, ms: number, data: object) {
  db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run(id, messageId, session, now + ms, JSON.stringify(data));
}

test("OpenCode V1 counts tool steps under their user turn without double-counting cache or reasoning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-opencode-"));
  const path = join(dir, "opencode.db");
  const db = new DatabaseSync(path);
  try {
    createV1(db);
    insertMessage(db, "msg_user", 0, { role: "user" });
    insertMessage(db, "msg_step1", 100, {
      role: "assistant", parentID: "msg_user", modelID: "qwen3.8-27b-heretic", time: { completed: now + 1200 },
      tokens: { input: 80, cache: { read: 20, write: 5 }, output: 24, reasoning: 16, total: 145 },
    });
    insertPart(db, "part_reasoning", "msg_step1", 175, { type: "reasoning", time: { start: now + 175 } });
    insertPart(db, "part_tool1", "msg_step1", 300, { type: "tool", state: { time: { start: now + 300, end: now + 600 } } });
    insertPart(db, "part_tool2", "msg_step1", 500, { type: "tool", state: { time: { start: now + 500, end: now + 800 } } });
    insertPart(db, "part_finish", "msg_step1", 1000, { type: "step-finish", tokens: { input: 80, output: 24 } });
    insertMessage(db, "msg_next_user", 1400, { role: "user" });
    // The explicit parent ID still supplies the turn when a newer prompt intervenes.
    insertMessage(db, "msg_step2", 1500, {
      role: "assistant", parentID: "msg_user", modelID: "qwen3.8-27b-heretic", time: { completed: now + 1650 },
      tokens: { input: 7, output: 13 },
    });
    insertMessage(db, "msg_incomplete", 1750, { role: "assistant", parentID: "msg_next_user", tokens: { input: 0, output: 0 } });
    insertMessage(db, "msg_other_session", 1750, { role: "assistant", tokens: { input: 1000, output: 300 } }, "ses_other");

    const reader = new SessionReader({ codex: dir, claude: dir, opencode: path });
    const stats = statsSchema.parse(await reader.read("opencode", session, dir));
    assert.equal(stats.source, "session");
    assert.equal(stats.turns, 1);
    assert.equal(stats.steps, 2);
    assert.equal(stats.inputTokens, 112);
    assert.equal(stats.outputTokens, 53);
    assert.equal(stats.cachedTokens, 20);
    assert.equal(stats.cacheWriteTokens, 5);
    assert.equal(stats.modelMs, 550);
    assert.equal(stats.timedOutputTokens, 53);
    assert.equal(stats.toolMs, 500);
    assert.equal(stats.ttftMs, 75);
    assert.equal(stats.ttftSteps, 1);
    assert.equal(stats.cost, undefined);
    assert.deepEqual(stats.turnUsages, [{
      turnNumber: 1, turnId: "msg_user", messageIds: ["msg_step1", "msg_step2"],
      startedAtMs: now, completedAtMs: now + 1650,
      routes: [{ provider: "opencode", model: "qwen3.8-27b-heretic" }],
      steps: 2, inputTokens: 112, uncachedInputTokens: 87, cachedTokens: 20, cacheWriteTokens: 5,
      outputTokens: 53, reasoningTokens: 16, totalTokens: 165,
    }]);
    reader.clear();
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("OpenCode V2 reads the ordered projection once and uses provider stream end for model timing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-opencode-v2-"));
  const path = join(dir, "opencode.db");
  const db = new DatabaseSync(path);
  try {
    createV1(db);
    insertMessage(db, "msg_duplicate", 200, { role: "assistant", tokens: { input: 1000, output: 200 } });
    db.exec("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)");
    const add = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)");
    add.run("msg_user", session, "user", 1, now + 100, "{}");
    add.run("msg_assistant", session, "assistant", 2, now + 200, JSON.stringify({
      model: { id: "qwen3.8-27b-heretic", providerID: "local" },
      time: { created: now + 200, streamed: now + 650, completed: now + 950 },
      tokens: { input: 90, output: 30, reasoning: 7, cache: { read: 20, write: 30 } },
      content: [{ type: "text", text: "fixture" }, { type: "tool", time: { ran: now + 620, completed: now + 900 } }],
    }));
    add.run("msg_bad_json", session, "assistant", 3, now + 1000, "not json");

    const stats = statsSchema.parse(await new OpenCodeReader(path).read(session));
    assert.equal(stats.turns, 1);
    assert.equal(stats.steps, 1);
    assert.equal(stats.inputTokens, 140);
    assert.equal(stats.outputTokens, 37);
    assert.equal(stats.modelMs, 450);
    assert.equal(stats.toolMs, 280);
    assert.equal(stats.ttftSteps, 0);
    assert.equal(stats.turnUsages[0].turnId, "msg_user");
    assert.deepEqual(stats.turnUsages[0].messageIds, ["msg_assistant"]);
    assert.deepEqual(stats.turnUsages[0].routes, [{ provider: "opencode", model: "qwen3.8-27b-heretic" }]);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("OpenCode refreshes its cached session on WAL writes and handles missing sessions and paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-opencode-wal-"));
  const path = join(dir, "opencode.db");
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    createV1(db);
    insertMessage(db, "msg_user", 0, { role: "user" });
    insertMessage(db, "msg_response", 20, { role: "assistant", parentID: "msg_user", tokens: { input: 0, output: 0 } });
    const reader = new OpenCodeReader(path);
    assert.equal((await reader.read(session)).steps, 0);
    db.prepare("UPDATE message SET data = ? WHERE id = ?").run(JSON.stringify({
      role: "assistant", parentID: "msg_user", tokens: { input: 5, output: 7 },
    }), "msg_response");
    const result = await reader.read(session, "qwen-fallback");
    assert.equal(result.steps, 1);
    assert.equal(result.modelMs, null);
    assert.deepEqual(result.turnUsages[0].routes, [{ provider: "opencode", model: "qwen-fallback" }]);
    result.turnUsages[0].messageIds.push("changed");
    assert.deepEqual((await reader.read(session)).turnUsages[0].messageIds, ["msg_response"]);
    assert.equal((await reader.read("ses_missing")).source, "unavailable");
    assert.equal((await reader.read("../ses_fixture")).source, "unavailable");
    assert.equal((await new OpenCodeReader(join(dir, "missing.db")).read(session)).source, "unavailable");
    assert.equal((await new OpenCodeReader(":memory:").read(session)).source, "unavailable");
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("OpenCode honors XDG data paths, channel databases, and relative database overrides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-opencode-paths-"));
  const root = join(dir, "opencode");
  const oldData = process.env.XDG_DATA_HOME;
  const oldDb = process.env.OPENCODE_DB;
  try {
    process.env.XDG_DATA_HOME = dir;
    delete process.env.OPENCODE_DB;
    await mkdir(root);
    const db = new DatabaseSync(join(root, "opencode-nightly.db"));
    try {
      createV1(db);
    } finally {
      db.close();
    }
    assert.equal((await new OpenCodeReader().read(session)).source, "session");
    process.env.OPENCODE_DB = "opencode-nightly.db";
    assert.equal((await new OpenCodeReader().read(session)).source, "session");
  } finally {
    if (oldData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = oldData;
    if (oldDb === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = oldDb;
    await rm(dir, { recursive: true, force: true });
  }
});
