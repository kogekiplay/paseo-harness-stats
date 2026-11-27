import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type * as Sqlite from "node:sqlite";
import { aggregateSessionCost } from "../shared/pricing";
import { emptyStats, type Stats } from "../shared/stats";
import { TurnUsageAccumulator } from "./fold";
import { builtinSqlite, databaseFingerprint } from "./session-database";

const provider = "opencode";
const sessionIdPattern = /^ses_[a-zA-Z0-9_-]+$/;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const tokenColumns = `
  json_extract(data, '$.tokens.input') AS input,
  json_extract(data, '$.tokens.output') AS output,
  json_extract(data, '$.tokens.reasoning') AS reasoning,
  json_extract(data, '$.tokens.cache.read') AS cache_read,
  json_extract(data, '$.tokens.cache.write') AS cache_write
`;

type Span = readonly [start: number, end: number];
interface Timing {
  first?: number;
  finish?: number;
  tools: Span[];
  missingToolTime: boolean;
}

interface Summary {
  stats: Stats;
  turns: TurnUsageAccumulator[];
}

function spanDuration(spans: readonly Span[], lower = 0, upper = Infinity): number {
  let duration = 0;
  let end = lower;
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    const start = Math.max(from, end);
    const finish = Math.min(to, upper);
    if (finish <= start) continue;
    duration += finish - start;
    end = finish;
  }
  return duration;
}

function readTimings(db: Sqlite.DatabaseSync, sessionId: string, v2: boolean, hasParts: boolean) {
  const timings = new Map<string, Timing>();
  if (!v2 && !hasParts) return timings;
  const rows = v2
    ? db.prepare(`
        SELECT m.id AS message_id, 'tool' AS type,
          json_extract(part.value, '$.time.ran') AS start,
          json_extract(part.value, '$.time.completed') AS finish
        FROM session_message AS m,
          json_each(CASE WHEN json_valid(m.data) THEN m.data ELSE '{}' END, '$.content') AS part
        WHERE m.session_id = ? AND m.type = 'assistant' AND json_valid(m.data)
          AND part.type = 'object' AND json_extract(part.value, '$.type') = 'tool'
      `).iterate(sessionId)
    : db.prepare(`
        SELECT message_id, json_extract(data, '$.type') AS type, time_created,
          json_extract(data, '$.time.start') AS first,
          json_extract(data, '$.state.time.start') AS start,
          json_extract(data, '$.state.time.end') AS finish
        FROM part
        WHERE session_id = ? AND json_valid(data)
          AND json_extract(data, '$.type') IN ('text', 'reasoning', 'step-finish', 'tool')
      `).iterate(sessionId);

  for (const row of rows) {
    if (typeof row.message_id !== "string") continue;
    let timing = timings.get(row.message_id);
    if (!timing) {
      timing = { tools: [], missingToolTime: false };
      timings.set(row.message_id, timing);
    }
    if (row.type === "tool") {
      const start = count(row.start);
      const end = count(row.finish);
      if (start !== undefined && end !== undefined && end >= start) timing.tools.push([start, end]);
      else timing.missingToolTime = true;
    } else if (row.type === "step-finish") {
      const finish = count(row.time_created);
      if (finish !== undefined) timing.finish = Math.max(timing.finish ?? finish, finish);
    } else {
      const first = count(row.first);
      if (first !== undefined) timing.first = Math.min(timing.first ?? first, first);
    }
  }
  return timings;
}

function summarize(db: Sqlite.DatabaseSync, sessionId: string): Summary | null {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name));
  if (!tables.has("session") || !db.prepare("SELECT 1 FROM session WHERE id = ?").get(sessionId)) return null;
  const v2 = tables.has("session_message") && Boolean(db.prepare(`
    SELECT 1 FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant') LIMIT 1
  `).get(sessionId));
  if (!v2 && !tables.has("message")) return null;

  // Read metrics in SQLite, so message text and tool arguments never reach the plugin.
  const messages = v2
    ? db.prepare(`
        SELECT id, type AS role, time_created, json_extract(data, '$.model.id') AS model,
          json_extract(data, '$.time.completed') AS completed, json_extract(data, '$.time.streamed') AS streamed,
          ${tokenColumns}
        FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant') AND json_valid(data)
        ORDER BY seq
      `).iterate(sessionId)
    : db.prepare(`
        SELECT id, json_extract(data, '$.role') AS role, time_created,
          json_extract(data, '$.parentID') AS parent, json_extract(data, '$.modelID') AS model,
          json_extract(data, '$.time.completed') AS completed, ${tokenColumns}
        FROM message WHERE session_id = ? AND json_valid(data) ORDER BY time_created, id
      `).iterate(sessionId);

  const timings = readTimings(db, sessionId, v2, tables.has("part"));
  const stats: Stats = emptyStats(provider);
  stats.modelMs = null;
  const initial = new TurnUsageAccumulator("initial", provider);
  const turns = new Map<string, TurnUsageAccumulator>();
  let currentTurn = initial;
  for (const row of messages) {
    if (typeof row.id !== "string") continue;
    const start = count(row.time_created);
    if (row.role === "user") {
      currentTurn = new TurnUsageAccumulator(row.id, provider);
      turns.set(row.id, currentTurn);
      currentTurn.start(start ?? null);
      continue;
    }
    if (row.role !== "assistant") continue;

    const uncachedInputTokens = count(row.input) ?? 0;
    const cachedTokens = count(row.cache_read);
    const cacheWriteTokens = count(row.cache_write);
    const reasoningTokens = count(row.reasoning);
    // OpenCode stores visible output separately from reasoning.
    const outputTokens = (count(row.output) ?? 0) + (reasoningTokens ?? 0);
    const input = uncachedInputTokens + (cachedTokens ?? 0) + (cacheWriteTokens ?? 0);
    if (input + outputTokens === 0) continue;

    const model = typeof row.model === "string" ? row.model : undefined;
    const timing = timings.get(row.id);
    const completed = count(row.completed) ?? timing?.finish;
    const streamed = count(row.streamed);
    const finish = streamed ?? timing?.finish ?? completed;
    const turn = (typeof row.parent === "string" ? turns.get(row.parent) : undefined) ?? currentTurn;
    turn.start(start ?? null);
    turn.complete(completed ?? null);
    turn.addMessage(row.id);
    turn.addModel(model);
    turn.addStep({ uncachedInputTokens, cachedTokens, cacheWriteTokens, outputTokens, reasoningTokens,
      model, timestampMs: completed ?? start });

    stats.steps++;
    stats.inputTokens += input;
    stats.cachedTokens += cachedTokens ?? 0;
    stats.cacheWriteTokens += cacheWriteTokens ?? 0;
    stats.outputTokens += outputTokens;
    if (start !== undefined && finish !== undefined && finish > start) {
      if (outputTokens > 0 && (streamed !== undefined || !timing?.missingToolTime)) {
        const toolMs = streamed !== undefined ? 0 : spanDuration(timing?.tools ?? [], start, finish);
        const modelMs = finish - start - toolMs;
        if (modelMs > 0) {
          stats.modelMs = (stats.modelMs ?? 0) + modelMs;
          stats.timedOutputTokens += outputTokens;
        }
      }
      const first = timing?.first;
      if (first !== undefined && first > start && first <= finish) {
        stats.ttftMs += first - start;
        stats.ttftSteps++;
      }
    }
  }

  const toolSpans = [...timings.values()].flatMap((timing) => timing.tools);
  stats.toolMs = toolSpans.length ? spanDuration(toolSpans)
    : [...timings.values()].some((timing) => timing.missingToolTime) ? null : 0;
  const billed = [initial, ...turns.values()].filter((turn) => turn.billed);
  stats.turns = billed.length;
  return { stats, turns: billed };
}

function snapshot({ stats, turns }: Summary, fallbackModel?: string | null): Stats {
  const turnUsages = turns.map((turn, index) => turn.snapshot(index + 1, fallbackModel));
  const cost = aggregateSessionCost(turnUsages);
  return { ...stats, turnUsages, ...(cost && { cost }) };
}

export class OpenCodeReader {
  private readonly cache = new Map<string, { path: string; signature: string; summary: Summary }>();
  private readonly root = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode");

  constructor(private readonly database = process.env.OPENCODE_DB) {}

  async read(id: string | null, fallbackModel?: string | null): Promise<Stats> {
    const sqlite = builtinSqlite();
    if (!id || !sessionIdPattern.test(id) || !sqlite || this.database === ":memory:") {
      return emptyStats(provider, "unavailable");
    }

    const main = !this.database ? join(this.root, "opencode.db")
      : isAbsolute(this.database) ? this.database : join(this.root, this.database);
    const cachedPath = this.cache.get(id)?.path;
    for (const path of new Set([cachedPath ?? main, main])) {
      const summary = await this.readDatabase(sqlite, path, id);
      if (summary) return snapshot(summary, fallbackModel);
    }
    if (!this.database) {
      let files: string[] = [];
      try {
        files = await readdir(this.root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const file of files.filter((name) => /^opencode-[a-zA-Z0-9._-]+\.db$/.test(name)).sort()) {
        const path = join(this.root, file);
        if (path === cachedPath) continue;
        const summary = await this.readDatabase(sqlite, path, id);
        if (summary) return snapshot(summary, fallbackModel);
      }
    }
    return emptyStats(provider, "unavailable");
  }

  private async readDatabase(sqlite: typeof Sqlite, path: string, id: string): Promise<Summary | null> {
    const [file, wal] = await Promise.all([databaseFingerprint(path), databaseFingerprint(`${path}-wal`)]);
    if (!file) return null;
    const signature = `${file}/${wal ?? ""}`;
    const cached = this.cache.get(id);
    if (cached?.path === path && cached.signature === signature) return cached.summary;

    const db = new sqlite.DatabaseSync(path, { readOnly: true });
    try {
      db.exec("BEGIN");
      const summary = summarize(db, id);
      if (summary) {
        this.cache.delete(id);
        this.cache.set(id, { path, signature, summary });
        if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!);
      }
      return summary;
    } finally {
      db.close();
    }
  }

  clear() {
    this.cache.clear();
  }
}
