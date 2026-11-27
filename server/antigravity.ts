import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type * as Sqlite from "node:sqlite";
import { aggregateSessionCost } from "../shared/pricing";
import { emptyStats, type Stats } from "../shared/stats";
import { fields, firstIndex, milliseconds } from "./antigravity-protobuf";
import { TurnUsageAccumulator } from "./fold";
import { builtinSqlite, databaseFingerprint } from "./session-database";

const provider = "antigravity";
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const decoder = new TextDecoder();
const userStep = 14;
const plannerStep = 15;
const toolStep = 132;

function conversationId(handle: string | null): string | null {
  if (!handle) return null;
  if (uuid.test(handle)) return handle;
  if (!handle.startsWith("plugin:")) return null;
  try {
    const value = JSON.parse(handle.slice("plugin:".length));
    if (value?.version !== 1) return null;
    const id = value.data?.sessionId ?? value.data?.conversationId;
    return typeof id === "string" && uuid.test(id) ? id : null;
  } catch {
    return null;
  }
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function text(value: unknown): string | undefined {
  return value instanceof Uint8Array ? decoder.decode(value) : undefined;
}

function responseUsage(raw: number | Uint8Array | undefined) {
  if (!(raw instanceof Uint8Array)) return undefined;
  const usage = new Map(fields(raw));
  const reasoningTokens = usage.has(9) ? tokens(usage.get(9)) : undefined;
  return {
    id: text(usage.get(11)),
    tokens: {
      uncachedInputTokens: tokens(usage.get(2)),
      cachedTokens: usage.has(5) ? tokens(usage.get(5)) : undefined,
      cacheWriteTokens: usage.has(4) ? tokens(usage.get(4)) : undefined,
      // The total already includes thinking when the CLI reports it.
      outputTokens: usage.has(3) ? tokens(usage.get(3)) : (reasoningTokens ?? 0) + tokens(usage.get(10)),
      reasoningTokens,
    },
  };
}

interface PlannerStep {
  startedAtMs: number | null;
  firstAtMs: number | null;
  completedAtMs: number | null;
  messageId: string | undefined;
  usage: ReturnType<typeof responseUsage>;
}

interface SessionSummary {
  stats: Stats;
  turns: TurnUsageAccumulator[];
}

/** Reads aggregate fields from the CLI's generator and step metadata. */
function summarize(db: Sqlite.DatabaseSync): SessionSummary {
  const stats: Stats = emptyStats(provider);
  stats.modelMs = null;
  const turns = new Set<number>();
  const responses = new Set<string>();
  const generationSteps = new Set<number>();
  const prompts: { idx: number; usage: TurnUsageAccumulator }[] = [];
  const fallback = new TurnUsageAccumulator("initial", provider);
  for (const row of db.prepare(
    `SELECT idx, metadata FROM steps WHERE step_type = ${userStep} ORDER BY idx`,
  ).iterate()) {
    const idx = Number(row.idx);
    const usage = new TurnUsageAccumulator(String(idx), provider);
    if (row.metadata instanceof Uint8Array) {
      usage.start(milliseconds(new Map(fields(row.metadata)).get(1)));
    }
    prompts.push({ idx, usage });
  }

  const planners = new Map<number, PlannerStep>();
  let hasTools = false;
  let toolMs: number | null = null;
  for (const row of db.prepare(
    `SELECT idx, step_type, metadata FROM steps WHERE step_type IN (${plannerStep}, ${toolStep}) ORDER BY idx`,
  ).iterate()) {
    if (!(row.metadata instanceof Uint8Array)) continue;
    const metadata = new Map(fields(row.metadata));
    if (row.step_type === plannerStep) {
      planners.set(Number(row.idx), {
        startedAtMs: milliseconds(metadata.get(1)),
        firstAtMs: milliseconds(metadata.get(6)),
        completedAtMs: milliseconds(metadata.get(7)),
        messageId: text(metadata.get(12)),
        usage: responseUsage(metadata.get(9)),
      });
    } else if (metadata.has(4)) {
      hasTools = true;
      const start = milliseconds(metadata.get(32));
      const end = milliseconds(metadata.get(8));
      if (start !== null && start > 0 && end !== null && end >= start)
        toolMs = (toolMs ?? 0) + (end - start);
    }
  }

  function addResponse(
    usage: ReturnType<typeof responseUsage>,
    index: number | undefined,
    ttft: number | null,
    modelMs: number | null,
    model?: string,
  ) {
    if (!usage) return false;
    const { id } = usage;
    if (id && responses.has(id)) return true;

    const { uncachedInputTokens, cachedTokens, cacheWriteTokens, outputTokens } = usage.tokens;
    const input = uncachedInputTokens + (cachedTokens ?? 0) + (cacheWriteTokens ?? 0);
    const output = outputTokens;
    if (input + output === 0) return false;
    if (id) responses.add(id);
    stats.steps++;
    const prompt = index === undefined ? undefined : prompts.findLast(({ idx }) => idx < index);
    if (prompt) turns.add(prompt.idx);
    const turn = prompt?.usage ?? fallback;
    const planner = index === undefined ? undefined : planners.get(index);
    if (planner) {
      if (!prompt) turn.start(planner.startedAtMs);
      turn.complete(planner.completedAtMs);
      turn.addMessage(planner.messageId);
      turn.addMessage(planner.usage?.id);
    }
    turn.addMessage(id);
    turn.addModel(model);
    turn.addStep({
      ...usage.tokens,
      model,
      timestampMs: planner?.completedAtMs ?? planner?.startedAtMs ?? null,
    });
    stats.inputTokens += input;
    stats.cachedTokens += cachedTokens ?? 0;
    stats.cacheWriteTokens += cacheWriteTokens ?? 0;
    stats.outputTokens += output;
    if (ttft !== null && ttft > 0 && (modelMs === null || ttft <= modelMs)) {
      stats.ttftMs += ttft;
      stats.ttftSteps++;
    }
    if (modelMs !== null && modelMs > 0 && output > 0) {
      stats.modelMs = (stats.modelMs ?? 0) + modelMs;
      stats.timedOutputTokens += output;
    }
    return true;
  }

  for (const row of db.prepare("SELECT data FROM gen_metadata ORDER BY idx").iterate()) {
    if (!(row.data instanceof Uint8Array)) continue;
    let chat: Uint8Array | undefined;
    let index: number | undefined;
    for (const [tag, value] of fields(row.data)) {
      if (tag === 1 && value instanceof Uint8Array) chat = value;
      if (tag === 2 && index === undefined) index = firstIndex(value);
    }
    if (!chat) continue;
    const metadata = new Map(fields(chat));
    const ttft = milliseconds(metadata.get(11));
    const stream = milliseconds(metadata.get(12));
    const model = text(metadata.get(19));
    const counted = addResponse(
      responseUsage(metadata.get(4)),
      index,
      ttft,
      ttft !== null && stream !== null ? ttft + stream : null,
      model && !/[^ -~]/.test(model) ? model : undefined,
    );
    if (index !== undefined && counted) generationSteps.add(index);
  }

  for (const [index, planner] of planners) {
    if (generationSteps.has(index)) continue;
    // A completed planner response can reach the step table before its generator record.
    const { startedAtMs: start, firstAtMs: first, completedAtMs: finish } = planner;
    addResponse(
      planner.usage,
      index,
      start !== null && first !== null ? first - start : null,
      start !== null && finish !== null ? finish - start : null,
    );
  }
  stats.turns = turns.size;
  stats.toolMs = hasTools ? toolMs : 0;
  return { stats, turns: [fallback, ...prompts.map(({ usage }) => usage)].filter((turn) => turn.billed) };
}

function snapshot({ stats, turns }: SessionSummary, fallbackModel?: string | null): Stats {
  const turnUsages = turns.map((turn, index) => turn.snapshot(index + 1, fallbackModel));
  const cost = aggregateSessionCost(turnUsages);
  return { ...stats, turnUsages, ...(cost && { cost }) };
}

export class AntigravityReader {
  private cache = new Map<string, { signature: string; summary: SessionSummary }>();

  constructor(private root = join(homedir(), ".gemini", "antigravity-cli")) {}

  async read(handle: string | null, fallbackModel?: string | null): Promise<Stats> {
    const id = conversationId(handle);
    const sqlite = builtinSqlite();
    if (!id || !sqlite) return emptyStats(provider, "unavailable");
    const path = join(this.root, "conversations", `${id}.db`);
    const [main, wal] = await Promise.all([databaseFingerprint(path), databaseFingerprint(`${path}-wal`)]);
    if (!main) return emptyStats(provider, "unavailable");
    const directory = await realpath(join(this.root, "conversations"));
    const file = join(directory, `${id}.db`);
    if (await realpath(path) !== file) return emptyStats(provider, "unavailable");
    const signature = `${main}/${wal ?? ""}`;
    const cached = this.cache.get(file);
    if (cached?.signature === signature) return snapshot(cached.summary, fallbackModel);

    const db = new sqlite.DatabaseSync(file, { readOnly: true });
    try {
      // One snapshot keeps prompt boundaries, tools and generations in sync while agy writes.
      db.exec("BEGIN");
      const summary = summarize(db);
      this.cache.delete(file);
      this.cache.set(file, { signature, summary });
      if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!);
      return snapshot(summary, fallbackModel);
    } finally {
      db.close();
    }
  }

  clear() {
    this.cache.clear();
  }
}
