import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type * as Sqlite from "node:sqlite";
import { emptyStats, type Stats } from "../shared/stats";
import { fields, firstIndex, milliseconds } from "./antigravity-protobuf";

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

/** Reads aggregate fields from the CLI's generator and step metadata. */
function summarize(db: Sqlite.DatabaseSync): Stats {
  const stats: Stats = emptyStats(provider);
  stats.modelMs = null;
  const turns = new Set<number>();
  const responses = new Set<string>();
  const generationSteps = new Set<number>();
  const prompts: number[] = [];
  for (const row of db.prepare(`SELECT idx FROM steps WHERE step_type = ${userStep} ORDER BY idx`).iterate())
    prompts.push(Number(row.idx));

  function addResponse(
    rawUsage: number | Uint8Array | undefined,
    index: number | undefined,
    ttft: number | null,
    modelMs: number | null,
  ) {
    if (!(rawUsage instanceof Uint8Array)) return;
    const usage = new Map(fields(rawUsage));
    const responseId = usage.get(11);
    const id = responseId instanceof Uint8Array ? decoder.decode(responseId) : "";
    if (id && responses.has(id)) return;

    // The CLI reports uncached input separately. Total output already includes thinking.
    const cacheRead = tokens(usage.get(5));
    const cacheWrite = tokens(usage.get(4));
    const input = tokens(usage.get(2)) + cacheRead + cacheWrite;
    const output = usage.has(3) ? tokens(usage.get(3)) : tokens(usage.get(9)) + tokens(usage.get(10));
    if (input + output === 0) return;
    if (id) responses.add(id);
    stats.steps++;
    if (index !== undefined) {
      const prompt = prompts.findLast((prompt) => prompt < index);
      if (prompt !== undefined) turns.add(prompt);
    }
    stats.inputTokens += input;
    stats.cachedTokens += cacheRead;
    stats.cacheWriteTokens += cacheWrite;
    stats.outputTokens += output;
    if (ttft !== null && ttft > 0 && (modelMs === null || ttft <= modelMs)) {
      stats.ttftMs += ttft;
      stats.ttftSteps++;
    }
    if (modelMs !== null && modelMs > 0 && output > 0) {
      stats.modelMs = (stats.modelMs ?? 0) + modelMs;
      stats.timedOutputTokens += output;
    }
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
    addResponse(metadata.get(4), index, ttft, ttft !== null && stream !== null ? ttft + stream : null);
    if (index !== undefined && metadata.get(4) instanceof Uint8Array) generationSteps.add(index);
  }

  let hasTools = false;
  let toolMs: number | null = null;
  for (const row of db.prepare(
    `SELECT idx, step_type, metadata FROM steps WHERE step_type IN (${plannerStep}, ${toolStep})`,
  ).iterate()) {
    const index = Number(row.idx);
    if (row.step_type === plannerStep && generationSteps.has(index)) continue;
    if (!(row.metadata instanceof Uint8Array)) continue;
    const metadata = new Map(fields(row.metadata));
    if (row.step_type === plannerStep) {
      // A completed planner response can reach the step table before its generator record.
      const start = milliseconds(metadata.get(1));
      const first = milliseconds(metadata.get(6));
      const finish = milliseconds(metadata.get(7));
      addResponse(
        metadata.get(9),
        index,
        start !== null && first !== null ? first - start : null,
        start !== null && finish !== null ? finish - start : null,
      );
    } else if (metadata.has(4)) {
      hasTools = true;
      const start = milliseconds(metadata.get(32));
      const end = milliseconds(metadata.get(8));
      if (start !== null && start > 0 && end !== null && end >= start)
        toolMs = (toolMs ?? 0) + (end - start);
    }
  }
  stats.turns = turns.size;
  stats.toolMs = hasTools ? toolMs : 0;
  return stats;
}

async function fingerprint(path: string): Promise<string | null> {
  try {
    const file = await stat(path, { bigint: true });
    return file.isFile() ? `${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}` : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class AntigravityReader {
  private cache = new Map<string, { signature: string; stats: Stats }>();

  constructor(private root = join(homedir(), ".gemini", "antigravity-cli")) {}

  async read(handle: string | null): Promise<Stats> {
    const id = conversationId(handle);
    const sqlite = process.getBuiltinModule?.("node:sqlite") as typeof Sqlite | undefined;
    if (!id || !sqlite) return emptyStats(provider, "unavailable");
    const path = join(this.root, "conversations", `${id}.db`);
    const [main, wal] = await Promise.all([fingerprint(path), fingerprint(`${path}-wal`)]);
    if (!main) return emptyStats(provider, "unavailable");
    const directory = await realpath(join(this.root, "conversations"));
    const file = join(directory, `${id}.db`);
    if (await realpath(path) !== file) return emptyStats(provider, "unavailable");
    const signature = `${main}/${wal ?? ""}`;
    const cached = this.cache.get(file);
    if (cached?.signature === signature) return { ...cached.stats };

    const db = new sqlite.DatabaseSync(file, { readOnly: true });
    try {
      // One snapshot keeps prompt boundaries, tools and generations in sync while agy writes.
      db.exec("BEGIN");
      const stats = summarize(db);
      this.cache.delete(file);
      this.cache.set(file, { signature, stats });
      if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!);
      return { ...stats };
    } finally {
      db.close();
    }
  }

  clear() {
    this.cache.clear();
  }
}
