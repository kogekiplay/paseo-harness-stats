import { emptyStats, type Stats, type TurnUsage } from "../shared/stats";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const reportedCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const count = (value: unknown): number => reportedCount(value) ?? 0;
const time = (value: unknown): number => (typeof value === "string" ? Date.parse(value) : NaN);
const epochMs = (value: unknown): number | undefined => {
  const timestamp = reportedCount(value);
  return timestamp !== undefined && timestamp < 1e12 ? timestamp * 1000 : timestamp;
};
const modelName = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const optionalTokens = ["cachedTokens", "cacheWriteTokens", "reasoningTokens"] as const;
type OptionalTokens = Partial<Pick<TurnUsage, (typeof optionalTokens)[number]>>;
type StepTokens = Pick<TurnUsage, "uncachedInputTokens" | "outputTokens"> & OptionalTokens;

/** Queues metadata as it arrives and supports replacing a streamed usage snapshot. */
export class TurnUsageAccumulator {
  private messageIds = new Set<string>();
  private models = new Set<string>();
  private reports = { cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  private usage: Omit<TurnUsage, "turnNumber" | "routes" | "messageIds">;

  constructor(turnId: string, private provider: string) {
    this.usage = {
      turnId,
      startedAtMs: null,
      completedAtMs: null,
      steps: 0,
      inputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
  }

  get billed() {
    return this.usage.steps > 0;
  }

  identify(turnId: string) {
    this.usage.turnId = turnId;
  }

  start(value: number | null) {
    if (value !== null && reportedCount(value) !== undefined) {
      this.usage.startedAtMs = Math.min(this.usage.startedAtMs ?? value, value);
    }
  }

  complete(value: number | null) {
    if (value !== null && reportedCount(value) !== undefined) {
      this.usage.completedAtMs = Math.max(this.usage.completedAtMs ?? value, value);
    }
  }

  addMessage(value: unknown) {
    if (typeof value === "string") this.messageIds.add(value);
  }

  addModel(value: unknown) {
    const model = modelName(value);
    if (model) this.models.add(model);
  }

  private adjustStep(step: StepTokens, direction: 1 | -1) {
    const input = step.uncachedInputTokens + (step.cachedTokens ?? 0) + (step.cacheWriteTokens ?? 0);
    if (input + step.outputTokens === 0) return;
    const usage = this.usage;
    usage.steps += direction;
    usage.uncachedInputTokens = Math.max(0, usage.uncachedInputTokens + direction * step.uncachedInputTokens);
    usage.outputTokens = Math.max(0, usage.outputTokens + direction * step.outputTokens);
    for (const field of optionalTokens) {
      const count = step[field];
      if (count === undefined) continue;
      this.reports[field] += direction;
      if (this.reports[field] === 0) delete usage[field];
      else usage[field] = Math.max(0, (usage[field] ?? 0) + direction * count);
    }
    usage.inputTokens = usage.uncachedInputTokens + (usage.cachedTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }

  addStep(step: StepTokens, previous?: StepTokens) {
    if (previous) this.adjustStep(previous, -1);
    this.adjustStep(step, 1);
  }

  snapshot(turnNumber: number, fallbackModel?: string | null): TurnUsage {
    const models = this.models.size > 0 ? [...this.models] : [modelName(fallbackModel)].filter(Boolean);
    return {
      ...this.usage,
      turnNumber,
      messageIds: [...this.messageIds],
      routes: models.map((model) => ({ provider: this.provider, model })),
    };
  }
}

export function withFallbackRoutes(stats: Stats, fallbackModel?: string | null): Stats {
  const model = modelName(fallbackModel);
  if (!model) return stats;
  for (const turn of stats.turnUsages) {
    if (turn.routes.length === 0) turn.routes.push({ provider: stats.provider, model });
  }
  return stats;
}

interface Usage {
  input: number;
  cached: number;
  write: number;
  output: number;
}
function codexUsage(value: unknown): { usage: Usage; optional: OptionalTokens } {
  const u = record(value);
  const optional = {
    cachedTokens: reportedCount(u.cached_input_tokens),
    cacheWriteTokens: reportedCount(u.cache_write_input_tokens),
    reasoningTokens: reportedCount(u.reasoning_output_tokens),
  };
  return {
    usage: {
      input: count(u.input_tokens),
      cached: optional.cachedTokens ?? 0,
      write: optional.cacheWriteTokens ?? 0,
      output: count(u.output_tokens),
    },
    optional,
  };
}

function codexStep(input: number, output: number, optional: OptionalTokens): StepTokens {
  return {
    ...optional,
    uncachedInputTokens: Math.max(0, input - (optional.cachedTokens ?? 0) - (optional.cacheWriteTokens ?? 0)),
    outputTokens: output,
  };
}

/** Folds complete JSONL lines; content and tool arguments are never retained. */
export class SessionFold {
  readonly stats: ReturnType<typeof emptyStats>;
  private turn = "initial";
  private codexTurn: string | symbol = Symbol();
  private turns = new Set<string>();
  private usageTurns = new Map<string | symbol, TurnUsageAccumulator>();
  private responses = new Map<string, TurnUsageAccumulator>();
  private modern = false;
  private legacySteps = 0;
  private legacyUsage: Usage = { input: 0, cached: 0, write: 0, output: 0 };
  private modernUsage: Usage = { input: 0, cached: 0, write: 0, output: 0 };
  private legacyResets: Usage = { input: 0, cached: 0, write: 0, output: 0 };
  private lastCumulative: Usage | null = null;
  private legacyReported: OptionalTokens = {};
  private boundary = NaN;
  private requestStart: number | null = null;
  private firstOutput: number | null = null;
  private firstKind: "text" | "tool" | null = null;
  private lastUsageAt = NaN;
  private pendingTools = new Map<string, number>();
  private claude = new Map<string, Usage>();
  private claudeMsgTurn = new Map<string, string>();
  private claudeSteps = new Map<string, StepTokens>();
  private claudeTimings = new Map<string, { tokens: number; ms: number }>();
  private chain = new Map<string, { parent: string | null; at: number; attachment: boolean }>();
  private claudeStarts = new Map<string, { start: number; first: number | null }>();
  private claudeTtft = new Set<string>();

  constructor(readonly provider: "codex" | "claude", fallbackModel?: string | null) {
    const fold = this;
    this.stats = {
      ...emptyStats(provider),
      get turnUsages() {
        const usages: TurnUsage[] = [];
        for (const turn of fold.usageTurns.values()) {
          if (turn.billed) usages.push(turn.snapshot(usages.length + 1, fallbackModel));
        }
        return usages;
      },
    };
  }

  snapshot(fallbackModel?: string | null): Stats {
    return withFallbackRoutes({ ...this.stats }, fallbackModel);
  }

  private usageTurn(key: string | symbol) {
    let turn = this.usageTurns.get(key);
    if (!turn) {
      turn = new TurnUsageAccumulator(typeof key === "string" ? key : "initial", this.provider);
      this.usageTurns.set(key, turn);
    }
    return turn;
  }

  private identifyCodexTurn(id: unknown) {
    if (typeof id !== "string") return;
    this.turn = id;
    // A task start can lack an ID until the first turn context or usage record.
    if (typeof this.codexTurn === "symbol" && !this.usageTurns.has(id)) {
      const provisional = this.usageTurns.get(this.codexTurn);
      if (provisional) {
        provisional.identify(id);
        this.usageTurns.delete(this.codexTurn);
        this.usageTurns.set(id, provisional);
      }
    }
    this.codexTurn = id;
  }

  private addTurn() {
    this.turns.add(this.turn);
    this.stats.turns = this.turns.size;
  }
  private timed(output: number, end: number) {
    const start = this.requestStart ?? this.boundary;
    const ms = end - start;
    if (Number.isFinite(ms) && ms >= 100 && ms <= 3_600_000 && output > 0) {
      this.stats.modelMs += ms;
      this.stats.timedOutputTokens += output;
      const first = this.firstOutput === null ? NaN : this.firstOutput - start;
      if (this.firstKind === "text" && first > 0 && first <= ms) {
        this.stats.ttftMs += first;
        this.stats.ttftSteps++;
      }
    }
    this.boundary = Math.max(end, Number.isFinite(this.boundary) ? this.boundary : end);
    this.lastUsageAt = end;
    this.requestStart = null;
    this.firstOutput = null;
    this.firstKind = null;
  }
  private setUsage(u: Usage) {
    this.stats.inputTokens = u.input;
    this.stats.cachedTokens = u.cached;
    this.stats.cacheWriteTokens = u.write;
    this.stats.outputTokens = u.output;
  }
  apply(value: unknown) {
    const row = record(value);
    if (this.provider === "codex") this.codex(row);
    else this.claudeRow(row);
  }
  private codex(row: RecordValue) {
    const p = record(row.payload),
      at = time(row.timestamp);
    if (row.type === "event_msg") {
      if (p.type === "task_started") {
        this.turn = typeof p.turn_id === "string" ? p.turn_id : String(row.timestamp);
        this.codexTurn = typeof p.turn_id === "string" ? p.turn_id : Symbol();
        const turn = this.usageTurn(this.codexTurn);
        if (typeof this.codexTurn === "symbol" && typeof row.timestamp === "string") {
          turn.identify(row.timestamp);
        }
        turn.start(epochMs(p.started_at) ?? at);
        this.boundary = at;
        this.pendingTools.clear();
        this.requestStart = null;
        this.firstOutput = null;
        this.firstKind = null;
      }
      if (p.type === "task_complete" || p.type === "task_completed" || p.type === "turn_aborted") {
        const turnId = typeof p.turn_id === "string" ? p.turn_id : this.codexTurn;
        this.usageTurn(turnId).complete(epochMs(p.completed_at) ?? at);
        this.boundary = NaN;
        this.pendingTools.clear();
        this.requestStart = null;
        this.firstOutput = null;
        this.firstKind = null;
      }
      if (p.type === "item_completed") {
        const item = record(p.item);
        if (
          (item.type === "Reasoning" || item.type === "AgentMessage") &&
          typeof p.started_at_ms === "number" &&
          Number.isFinite(p.started_at_ms)
        ) {
          this.requestStart ??= this.boundary;
          this.firstKind ??= "text";
          this.firstOutput = Math.min(this.firstOutput ?? p.started_at_ms, p.started_at_ms);
        }
      }
      if (p.type !== "token_count") return;
      const turn = this.usageTurn(this.codexTurn);
      turn.complete(at);
      if (this.modern) return;
      const info = record(p.info);
      if (!info.total_token_usage) return;
      const { usage: u, optional } = codexUsage(info.total_token_usage);
      const prev = this.lastCumulative;
      if (prev && u.input === prev.input && u.output === prev.output) return;
      // Old clients can reset their cumulative counters at compaction/resume.
      const reset = prev !== null && (u.input < prev.input || u.output < prev.output);
      if (reset) {
        for (const k of Object.keys(u) as (keyof Usage)[]) this.legacyResets[k] += prev[k];
        this.legacyReported = {};
      }
      for (const field of optionalTokens) {
        const value = optional[field];
        if (value === undefined) continue;
        const last = this.legacyReported[field] ?? 0;
        optional[field] = value >= last ? value - last : value;
        this.legacyReported[field] = value;
      }
      turn.addStep(codexStep(
        !prev || reset ? u.input : u.input - prev.input,
        !prev || reset ? u.output : u.output - prev.output,
        optional,
      ));
      this.lastCumulative = u;
      this.legacyUsage = {
        input: u.input + this.legacyResets.input,
        cached: u.cached + this.legacyResets.cached,
        write: u.write + this.legacyResets.write,
        output: u.output + this.legacyResets.output,
      };
      const output = prev && u.output >= prev.output ? u.output - prev.output : u.output;
      this.legacySteps++;
      this.stats.steps = this.legacySteps;
      this.addTurn();
      this.setUsage(this.legacyUsage);
      this.timed(output, at);
    }
    if (row.type === "turn_context") {
      this.identifyCodexTurn(p.turn_id);
      const turn = this.usageTurn(this.codexTurn);
      turn.start(at);
      turn.addModel(p.model);
      if (Number.isFinite(at)) this.boundary = at;
    }
    if (row.type === "token_usage_record") {
      const id =
        typeof p.response_id === "string" ? p.response_id : String(row.ordinal ?? row.timestamp);
      const previousTurn = this.responses.get(id);
      if (previousTurn) {
        previousTurn.complete(at);
        return;
      }
      if (!this.modern) {
        this.modern = true;
        // Preserve billed history when a session is resumed with a newer Codex.
        this.modernUsage = { ...this.legacyUsage };
      }
      this.identifyCodexTurn(p.turn_id);
      const turn = this.usageTurn(this.codexTurn);
      turn.addMessage(p.response_id);
      turn.complete(at);
      this.responses.set(id, turn);
      const { usage: u, optional } = codexUsage(p.usage);
      turn.addStep(codexStep(u.input, u.output, optional));
      for (const k of Object.keys(u) as (keyof Usage)[]) this.modernUsage[k] += u[k];
      this.stats.steps = this.legacySteps + this.responses.size;
      this.addTurn();
      this.setUsage(this.modernUsage);
      this.timed(u.output, at);
    }
    if (row.type === "response_item") {
      const userMessage = p.type === "message" && p.role !== "assistant";
      const assistantMessage = p.type === "message" && p.role === "assistant";
      if (!userMessage) {
        const turn = this.usageTurn(this.codexTurn);
        turn.complete(at);
        if (assistantMessage) turn.addMessage(p.id);
      }
      const output =
        p.type === "reasoning" ||
        assistantMessage ||
        p.type === "function_call" ||
        p.type === "custom_tool_call";
      if (
        output &&
        !(this.requestStart === null && at - this.lastUsageAt >= 0 && at - this.lastUsageAt <= 100)
      ) {
        this.requestStart ??= this.boundary;
        this.firstKind ??=
          p.type === "function_call" || p.type === "custom_tool_call" ? "tool" : "text";
      }
      if (userMessage && Number.isFinite(at)) this.boundary = at;
      if (
        (p.type === "function_call" || p.type === "custom_tool_call") &&
        typeof p.call_id === "string"
      ) {
        this.pendingTools.set(p.call_id, at);
      }
      if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        if (typeof p.call_id === "string") this.finishTool(p.call_id, at);
        // A parallel batch resumes inference after its last result, not its first.
        if (this.pendingTools.size === 0) this.boundary = at;
      }
    }
  }

  private finishTool(id: string, end: number) {
    const start = this.pendingTools.get(id);
    if (start !== undefined && Number.isFinite(end - start))
      this.stats.toolMs += Math.max(0, end - start);
    this.pendingTools.delete(id);
  }

  private claudeRow(row: RecordValue) {
    if (row.isSidechain === true || row.isApiErrorMessage === true) return;
    const msg = record(row.message),
      at = time(row.timestamp);
    if (typeof row.uuid === "string")
      this.chain.set(row.uuid, {
        parent: typeof row.parentUuid === "string" ? row.parentUuid : null,
        at,
        attachment: row.type === "attachment",
      });
    const content = Array.isArray(msg.content) ? msg.content.map(record) : [];
    if (row.type === "user") {
      for (const block of content) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string")
          this.finishTool(block.tool_use_id, at);
      }
      if (!content.some((c) => c.type === "tool_result") && row.isMeta !== true) {
        this.turn = typeof row.uuid === "string" ? row.uuid : String(row.timestamp);
        this.usageTurn(this.turn).start(at);
      }
      this.boundary = at;
    }
    if (row.type !== "assistant") return;
    const turnId = typeof msg.id === "string" ? this.claudeMsgTurn.get(msg.id) ?? this.turn : this.turn;
    const turn = this.usageTurn(turnId);
    const model = modelName(msg.model);
    if (model !== "<synthetic>") {
      turn.complete(at);
      turn.addMessage(msg.id);
      turn.addMessage(row.uuid);
      turn.addModel(model);
    }
    if (typeof msg.id !== "string") return;
    this.claudeMsgTurn.set(msg.id, turnId);
    if (!msg.usage) return;
    for (const block of content) {
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        !this.pendingTools.has(block.id)
      )
        this.pendingTools.set(block.id, at);
    }
    const raw = record(msg.usage);
    const previousStep = this.claudeSteps.get(msg.id);
    const reported = {
      uncachedInputTokens: reportedCount(raw.input_tokens),
      cachedTokens: reportedCount(raw.cache_read_input_tokens),
      cacheWriteTokens: reportedCount(raw.cache_creation_input_tokens),
      outputTokens: reportedCount(raw.output_tokens),
      reasoningTokens: reportedCount(record(raw.output_tokens_details).thinking_tokens),
    };
    // Streamed blocks can omit fields already reported by an earlier block.
    const step: StepTokens = {
      uncachedInputTokens: reported.uncachedInputTokens ?? previousStep?.uncachedInputTokens ?? 0,
      outputTokens: reported.outputTokens ?? previousStep?.outputTokens ?? 0,
      cachedTokens: reported.cachedTokens ?? previousStep?.cachedTokens,
      cacheWriteTokens: reported.cacheWriteTokens ?? previousStep?.cacheWriteTokens,
      reasoningTokens: reported.reasoningTokens ?? previousStep?.reasoningTokens,
    };
    this.claudeSteps.set(msg.id, step);
    turn.addStep(step, previousStep);
    const u: Usage = {
      input:
        (reported.uncachedInputTokens ?? 0) +
        (reported.cachedTokens ?? 0) +
        (reported.cacheWriteTokens ?? 0),
      cached: reported.cachedTokens ?? 0,
      write: reported.cacheWriteTokens ?? 0,
      output: reported.outputTokens ?? 0,
    };
    const prev = this.claude.get(msg.id);
    let timing = this.claudeStarts.get(msg.id);
    if (!timing) {
      let parent = typeof row.parentUuid === "string" ? row.parentUuid : null;
      let start = this.boundary;
      for (let hop = 0; parent && hop < 32; hop++) {
        const node = this.chain.get(parent);
        if (!node) break;
        if (!node.attachment) {
          start = node.at;
          break;
        }
        parent = node.parent;
      }
      const firstBlock = row.apiBlockIndex === undefined || row.apiBlockIndex === 0;
      const duration = count(row.thinkingDurationMs);
      const first =
        firstBlock && content[0]?.type === "thinking" && duration > 0 ? at - duration : null;
      timing = { start, first };
      this.claudeStarts.set(msg.id, timing);
    }
    this.claude.set(msg.id, u);
    this.stats.inputTokens += u.input - (prev?.input ?? 0);
    this.stats.cachedTokens += u.cached - (prev?.cached ?? 0);
    this.stats.cacheWriteTokens += u.write - (prev?.write ?? 0);
    this.stats.outputTokens += u.output - (prev?.output ?? 0);
    this.stats.steps = this.claude.size;
    this.addTurn();
    const prior = this.claudeTimings.get(msg.id);
    const ms = at - timing.start;
    if (Number.isFinite(ms) && ms > 0) {
      this.stats.modelMs += ms - (prior?.ms ?? 0);
      this.stats.timedOutputTokens += u.output - (prior?.tokens ?? 0);
      this.claudeTimings.set(msg.id, { tokens: u.output, ms });
    }
    const first = timing.first === null ? NaN : timing.first - timing.start;
    if (
      typeof msg.stop_reason === "string" &&
      !this.claudeTtft.has(msg.id) &&
      ms >= 100 &&
      ms <= 3_600_000 &&
      first > 0 &&
      first <= ms
    ) {
      this.claudeTtft.add(msg.id);
      this.stats.ttftMs += first;
      this.stats.ttftSteps++;
    }
  }
}
