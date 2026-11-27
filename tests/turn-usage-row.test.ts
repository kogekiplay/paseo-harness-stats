import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PluginHandlerContext,
  PluginHookAgent,
  PluginHookContext,
  PluginHookEvents,
  PluginServerContext,
  PluginSettings,
  PluginSettingsState,
  PluginTurnOutcome,
} from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { SessionReader } from "../server/sessions";
import { TurnUsagePublisher } from "../server/turn-usage-row";
import { preferences, valuesSchema } from "../shared/preferences";
import { emptyStats, readStats, type Stats, type TurnUsage } from "../shared/stats";
import {
  TURN_USAGE_ROW_KIND,
  TURN_USAGE_ROW_VERSION,
  turnUsageRowSchema,
} from "../shared/turn-usage-row";

const now = 1_700_000_000_000;
const agent: PluginHookAgent = {
  id: "agent-a",
  workspaceId: null,
  parentAgentId: null,
  provider: "codex",
  cwd: "/workspace",
  title: null,
};
const completed: PluginTurnOutcome = { kind: "completed" };

function turn(overrides: Partial<TurnUsage> = {}): TurnUsage {
  return {
    turnNumber: 1,
    turnId: "provider-turn-1",
    messageIds: ["message-1"],
    startedAtMs: now,
    completedAtMs: now + 1_000,
    routes: [{ provider: "codex", model: "gpt-5" }],
    steps: 1,
    inputTokens: 100,
    uncachedInputTokens: 60,
    cachedTokens: 40,
    outputTokens: 20,
    totalTokens: 120,
    ...overrides,
  };
}

function session(...turnUsages: TurnUsage[]): Stats {
  return { ...emptyStats("codex"), turns: turnUsages.length, turnUsages };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type SettingsState = PluginSettingsState<typeof valuesSchema>;
type AgentApi = ReturnType<PluginHookContext["paseo"]["agents"]["ref"]>;
type Append = AgentApi["timeline"]["append"];
type PublisherOptions = ConstructorParameters<typeof TurnUsagePublisher>[0];

function settingsState(turnUsageEnabled: boolean): SettingsState {
  return {
    status: "ready",
    revision: String(turnUsageEnabled),
    values: valuesSchema.parse({ turnUsageEnabled }),
  };
}

function fixture(
  options: Partial<Omit<PublisherOptions, "settings">> & {
    readSettings?: () => Promise<SettingsState>;
    append?: Append;
  } = {},
) {
  let listener: Parameters<PluginSettings<typeof valuesSchema>["subscribe"]>[0] | undefined;
  let settingsReads = 0;
  const settings: PluginSettings<typeof valuesSchema> = {
    read: async () => {
      settingsReads++;
      return options.readSettings ? options.readSettings() : settingsState(true);
    },
    subscribe: (callback) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
  };
  const rows: { agentId: string; item: Parameters<Append>[0] }[] = [];
  const signal = new AbortController();
  const context: PluginHookContext = {
    signal: signal.signal,
    paseo: {
      agents: {
        ref: (agentId: string) => ({
          timeline: {
            append: async (item: Parameters<Append>[0]) => {
              rows.push({ agentId, item });
              return options.append ? options.append(item) : { seq: rows.length, epoch: "epoch" };
            },
          },
        }),
      },
    } as unknown as PluginHookContext["paseo"],
  };
  let stats: Stats | null = null;
  const publisher = new TurnUsagePublisher({
    settings,
    readStats: options.readStats ?? (async () => stats),
    now: options.now ?? (() => now),
    retryDelaysMs: "retryDelaysMs" in options ? options.retryDelaysMs : [],
    sleep: options.sleep,
  });
  void publisher.start();
  return {
    publisher,
    rows,
    signal,
    before: (turnId: string | null = null) => publisher.onTurnBefore({ agent, turnId }, context),
    after: (turnId: string | null = null, outcome = completed) =>
      publisher.onTurnAfter({ agent, turnId, outcome, timeline: [] }, context),
    changeSettings: (enabled: boolean) => listener?.(settingsState(enabled)),
    hasSubscription: () => listener !== undefined,
    settingsReads: () => settingsReads,
    setStats: (next: Stats | null) => {
      stats = next;
    },
  };
}

test("appends a schema-validated plugin item with cost for the exact completed turn", async () => {
  const example = fixture();
  await example.before("provider-turn-1");
  const billed = turn({
    completedAtMs: now - 11_000,
    cost: {
      currency: "USD",
      totalUsd: 0.002,
      uncachedInputUsd: 0.001,
      cachedInputUsd: 0.0001,
      cacheWriteUsd: 0,
      outputUsd: 0.0009,
      complete: true,
      ratesPerMillion: { uncachedInput: 2, cachedInput: 0.5, output: 10 },
    },
  });
  example.setStats(session(billed, turn({ turnNumber: 2, turnId: "other-provider-turn" })));
  await example.after("provider-turn-1");

  assert.equal(TURN_USAGE_ROW_KIND, "harness-turn-usage");
  assert.equal(TURN_USAGE_ROW_VERSION, 1);
  assert.deepEqual(example.rows, [
    {
      agentId: agent.id,
      item: {
        type: "plugin",
        id: "turn-usage-1-provider-turn-1",
        kind: TURN_USAGE_ROW_KIND,
        version: TURN_USAGE_ROW_VERSION,
        data: { turn: billed },
      },
    },
  ]);
  assert.deepEqual(turnUsageRowSchema.parse(example.rows[0].item.data), { turn: billed });
});

test("retries when a recent historical turn is unchanged from the baseline", async () => {
  const previous = turn({ completedAtMs: now - 500 });
  const next = turn({ turnNumber: 2, turnId: "provider-turn-2" });
  const snapshots = [session(previous), session(previous), session(previous, next)];
  const sleeps: number[] = [];
  const readAgents: string[] = [];
  const example = fixture({
    readStats: async (agentId) => {
      readAgents.push(agentId);
      return snapshots.shift() ?? null;
    },
    retryDelaysMs: [150, 350, 700],
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await example.before("paseo-turn-2");
  await example.after("paseo-turn-2");

  assert.deepEqual(readAgents, [agent.id, agent.id, agent.id]);
  assert.deepEqual(sleeps, [150]);
  assert.deepEqual(example.rows.map(({ item }) => item.data), [{ turn: next }]);
});

test("retries null snapshots and read failures and uses the configured default delays", async () => {
  const billed = turn();
  let reads = 0;
  const sleeps: number[] = [];
  const example = fixture({
    retryDelaysMs: undefined,
    readStats: async () => {
      reads++;
      if (reads <= 2) throw new Error("session not readable yet");
      if (reads === 3) return null;
      if (reads === 4) return emptyStats("codex", "unavailable");
      return session(billed);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await example.before();
  await example.after();

  assert.equal(reads, 5);
  assert.deepEqual(sleeps, [150, 350, 700]);
  assert.deepEqual(example.rows.map(({ item }) => item.data), [{ turn: billed }]);
});

test("accepts changed provider identifiers or a fresh update to counters after the baseline", async (t) => {
  const baseline = turn({ completedAtMs: now - 30_000 });
  for (const [name, billed] of [
    ["provider turn ID", turn({ turnId: "changed-id", completedAtMs: null })],
    ["fresh counters", turn({ totalTokens: 140, outputTokens: 40, completedAtMs: now - 1_500 })],
    ["fresh completion", turn({ completedAtMs: now - 1_000 })],
  ] as const) {
    await t.test(name, async () => {
      const example = fixture();
      example.setStats(session(baseline));
      await example.before("paseo-turn");
      example.setStats(session(billed));
      await example.after("paseo-turn");
      assert.deepEqual(example.rows.map(({ item }) => item.data), [{ turn: billed }]);
    });
  }
});

test("without a start hook, uses the completion time window or an unknown completion time", async (t) => {
  for (const [name, completedAtMs, publishes] of [
    ["recent completion", now - 10_000, true],
    ["old completion", now - 10_001, false],
    ["unknown completion", null, true],
  ] as const) {
    await t.test(name, async () => {
      const example = fixture();
      const billed = turn({ turnId: undefined, completedAtMs });
      example.setStats(session(billed));
      await example.after();
      assert.deepEqual(
        example.rows.map(({ item }) => item.id),
        publishes ? [`turn-usage-1-${now}`] : [],
      );
    });
  }
});

test("a new start immediately cancels the old retry and rejects a late completion with the old ID", async () => {
  const waiting = deferred<AbortSignal>();
  const example = fixture({
    retryDelaysMs: [150],
    sleep: (_ms, signal) =>
      new Promise<void>((_, reject) => {
        assert.ok(signal);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        waiting.resolve(signal);
      }),
  });
  const stale = turn({ completedAtMs: now - 20_000 });
  example.setStats(session(stale));
  await example.before("old-turn");
  const oldCompletion = example.after("old-turn");
  const retrySignal = await waiting.promise;
  await example.before("new-turn");

  assert.equal(retrySignal.aborted, true);
  const billed = turn({ turnId: "new-turn", turnNumber: 2 });
  example.setStats(session(stale, billed));
  await oldCompletion;
  await example.after("old-turn");
  assert.equal(example.rows.length, 0);
  await example.after("new-turn");
  assert.deepEqual(example.rows.map(({ item }) => item.data), [{ turn: billed }]);
});

test("captures the start before settings resolve and skips a superseded completion", async () => {
  const initial = deferred<SettingsState>();
  const example = fixture({ readSettings: () => initial.promise });
  await example.before();
  example.setStats(session(turn()));
  const oldCompletion = example.after();
  await example.before();
  initial.resolve(settingsState(true));
  await oldCompletion;
  assert.deepEqual(example.rows, []);
});

test("a pending baseline does not delay an exact ID match or overwrite the next start", async () => {
  const oldBaseline = deferred<Stats>();
  const previous = turn({ completedAtMs: now - 20_000 });
  const first = turn({ turnId: "turn-2", turnNumber: 2 });
  const second = turn({ turnId: "turn-3", turnNumber: 3 });
  const snapshots = [
    oldBaseline.promise,
    Promise.resolve(session(previous, first)),
    Promise.resolve(session(previous, first)),
    Promise.resolve(session(previous, first, second)),
  ];
  const example = fixture({ readStats: async () => (await snapshots.shift()) ?? null });
  const oldStart = example.before("turn-2");
  await example.after("turn-2");
  await example.before("paseo-turn-3");
  oldBaseline.resolve(session(turn({ turnNumber: 9, turnId: second.turnId })));
  await oldStart;
  await example.after("paseo-turn-3");
  assert.deepEqual(example.rows.map(({ item }) => item.data), [{ turn: first }, { turn: second }]);
});

test("honors the initial disabled setting and resumes on a subscribed update", async () => {
  const initial = deferred<SettingsState>();
  const example = fixture({ readSettings: () => initial.promise });
  const billed = turn();
  example.setStats(session(billed));
  const pending = example.after(billed.turnId);
  assert.deepEqual(example.rows, []);
  initial.resolve(settingsState(false));
  await pending;
  assert.deepEqual(example.rows, []);
  await example.changeSettings(true);
  await example.after(billed.turnId);
  assert.equal(example.rows.length, 1);
  assert.equal(example.settingsReads(), 1);
});

test("a newer settings subscription value wins over a stale initial read", async () => {
  const initial = deferred<SettingsState>();
  const example = fixture({ readSettings: () => initial.promise });
  example.setStats(session(turn()));
  await example.changeSettings(false);
  initial.resolve(settingsState(true));
  await example.after();
  assert.deepEqual(example.rows, []);
});

test("a failed initial settings read keeps the enabled default", async () => {
  const example = fixture({
    readSettings: async () => {
      throw new Error("temporary settings error");
    },
  });
  example.setStats(session(turn()));
  await example.after();
  assert.equal(example.rows.length, 1);
});

test("rechecks settings and hook cancellation when an in-flight stats read resolves", async (t) => {
  for (const action of ["disable", "abort", "dispose"] as const) {
    await t.test(action, async () => {
      const reading = deferred<void>();
      const result = deferred<Stats>();
      const example = fixture({
        readStats: () => {
          reading.resolve();
          return result.promise;
        },
      });
      const pending = example.after();
      await reading.promise;
      switch (action) {
        case "disable":
          await example.changeSettings(false);
          break;
        case "abort":
          example.signal.abort();
          break;
        case "dispose":
          assert.equal(example.hasSubscription(), true);
          await example.publisher.dispose();
          assert.equal(example.hasSubscription(), false);
          break;
      }
      result.resolve(session(turn()));
      await pending;
      assert.deepEqual(example.rows, []);
    });
  }
});

test("concurrent and repeated completions reserve one row, with no replay on an unbilled turn", async () => {
  const appendStarted = deferred<void>();
  const appendResult = deferred<Awaited<ReturnType<Append>>>();
  const example = fixture({
    append: () => {
      appendStarted.resolve();
      return appendResult.promise;
    },
  });
  const billed = turn();
  await example.before("paseo-turn");
  example.setStats(session(billed));
  const first = example.after("paseo-turn");
  await appendStarted.promise;
  await example.after("paseo-turn");
  assert.equal(example.rows.length, 1);
  appendResult.resolve({ seq: 1, epoch: "epoch" });
  await first;
  await example.after("paseo-turn");
  await example.before("paseo-unbilled");
  await example.after("paseo-unbilled");
  assert.equal(example.rows.length, 1);
});

test("deduplicates older provider and hook IDs after later turns have published", async () => {
  const example = fixture();
  const first = turn();
  const second = turn({ turnNumber: 2, turnId: "provider-turn-2" });
  const third = turn({ turnNumber: 3, turnId: "provider-turn-3" });
  await example.before();
  example.setStats(session(first));
  await example.after("paseo-turn-1");
  await example.before();
  example.setStats(session(first, second));
  await example.after("paseo-turn-2");
  await example.before();
  example.setStats(session(first, second, third));
  await example.after(first.turnId);
  await example.after("paseo-turn-1");
  assert.equal(example.rows.length, 2);
  await example.after("paseo-turn-3");
  assert.deepEqual(example.rows.map(({ item }) => item.data), [
    { turn: first },
    { turn: second },
    { turn: third },
  ]);
});

test("canceled and failed turns skip reads, and unsupported and zero-token snapshots skip append", async () => {
  let reads = 0;
  const example = fixture({
    readStats: async () => {
      reads++;
      return reads === 1
        ? { ...session(turn()), source: "unsupported" }
        : session(turn(), turn({ turnId: "zero", turnNumber: 2, totalTokens: 0 }));
    },
  });
  await example.after("provider-turn-1", { kind: "canceled", reason: "interrupted" });
  await example.after("provider-turn-1", { kind: "failed", error: { message: "provider error" } });
  assert.equal(reads, 0);
  await example.after("provider-turn-1");
  await example.after("zero");
  assert.equal(reads, 2);
  assert.deepEqual(example.rows, []);
});

test("ignores missing-agent append errors, logs other errors, and clears deduplication on archive", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const errors = [new Error("Unknown agent"), new Error("Timeline not found"), new Error("write failed")];
  const example = fixture({
    append: async () => {
      const error = errors.shift();
      if (error) throw error;
      return { seq: 1, epoch: "epoch" };
    },
  });
  const billed = turn();
  example.setStats(session(billed));
  await example.before(billed.turnId);
  await example.after(billed.turnId);
  await example.after(billed.turnId);
  assert.equal(example.rows.length, 1);
  assert.equal(log.mock.callCount(), 0);

  example.publisher.onAgentArchived(agent.id);
  await example.after(billed.turnId);
  assert.equal(example.rows.length, 2);
  assert.equal(log.mock.callCount(), 0);

  example.publisher.onAgentArchived(agent.id);
  await example.after(billed.turnId);
  assert.equal(example.rows.length, 3);
  assert.equal(log.mock.callCount(), 1);
  assert.match(String(log.mock.calls[0].arguments[2]), /write failed/);
});

test("archiving aborts a retry even when the start hook did not run", async () => {
  const waiting = deferred<AbortSignal>();
  const example = fixture({
    retryDelaysMs: [150],
    sleep: (_ms, signal) =>
      new Promise<void>((_, reject) => {
        assert.ok(signal);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        waiting.resolve(signal);
      }),
  });
  const pending = example.after();
  const retrySignal = await waiting.promise;
  example.publisher.onAgentArchived(agent.id);
  assert.equal(retrySignal.aborted, true);
  example.setStats(session(turn()));
  await pending;
  assert.deepEqual(example.rows, []);
});

test("server wires the stats RPC and all lifecycle hooks and releases their resources", async (t) => {
  type Notify = "agent.turn.before" | "agent.turn.after" | "agent.archive.after";
  type Hook = (event: PluginHookEvents[Notify], context: PluginHookContext) => Promise<void>;
  type Read = (input: { agentId: string }, context: PluginHandlerContext) => Promise<Stats>;
  const hooks = new Map<Notify, Hook>();
  let rpc: Read | undefined;
  const unsubscribe = t.mock.fn();
  const settings: PluginSettings<typeof valuesSchema> = {
    read: async () => settingsState(true),
    subscribe: () => unsubscribe,
  };
  const server = {
    registerSettings(definition: typeof preferences) {
      assert.equal(definition, preferences);
      return settings;
    },
    handle(contract: typeof readStats, handler: Read) {
      assert.equal(contract, readStats);
      rpc = handler;
    },
    addHook(name: Notify, handler: Hook) {
      hooks.set(name, handler);
      return () => hooks.delete(name);
    },
  } as unknown as PluginServerContext;
  let available = false;
  let stats = session();
  const read = t.mock.method(SessionReader.prototype, "read", async () => stats);
  const clear = t.mock.method(SessionReader.prototype, "clear");
  const append = t.mock.fn<Append>(async () => ({ seq: 1, epoch: "epoch" }));
  const context: PluginHookContext = {
    signal: new AbortController().signal,
    paseo: {
      agents: {
        ref: () => ({
          refresh: async () =>
            available ? { agent: { ...agent, persistence: { nativeHandle: "session" }, model: "gpt-5" } } : null,
          timeline: { append },
        }),
      },
    } as unknown as PluginHookContext["paseo"],
  };

  const cleanup = contribute(server);
  try {
    const before = hooks.get("agent.turn.before");
    const after = hooks.get("agent.turn.after");
    const archive = hooks.get("agent.archive.after");
    assert.ok(rpc && before && after && archive);
    await assert.rejects(rpc({ agentId: agent.id }, context), /Agent is no longer available/);
    available = true;
    assert.deepEqual(await rpc({ agentId: agent.id }, context), stats);
    const turnId = "exact-turn";
    const billed = turn({ turnId });
    await before({ agent, turnId }, context);
    stats = session(billed);
    const completion = { agent, turnId, outcome: completed, timeline: [] };
    await after(completion, context);
    assert.equal(append.mock.callCount(), 1);
    assert.deepEqual(append.mock.calls[0].arguments[0].data, { turn: billed });
    await archive({ agent, archivedAt: new Date(now).toISOString() }, context);
    await after(completion, context);
    assert.equal(append.mock.callCount(), 2);
    assert.deepEqual(read.mock.calls.map(({ arguments: args }) => args), [
      ["codex", "session", agent.cwd, "gpt-5"],
      ["codex", "session", agent.cwd, "gpt-5"],
      ["codex", "session", agent.cwd, "gpt-5"],
      ["codex", "session", agent.cwd, "gpt-5"],
    ]);
  } finally {
    await cleanup();
  }
  assert.equal(hooks.size, 0);
  assert.equal(unsubscribe.mock.callCount(), 1);
  assert.equal(clear.mock.callCount(), 1);
});
