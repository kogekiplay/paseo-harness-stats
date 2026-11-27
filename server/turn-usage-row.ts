import type { PluginHookContext, PluginHookEvents, PluginSettings } from "@getpaseo/plugin/server";
import { setTimeout } from "node:timers/promises";
import type { valuesSchema } from "../shared/preferences";
import type { Stats, TurnUsage } from "../shared/stats";
import {
  TURN_USAGE_ROW_KIND,
  TURN_USAGE_ROW_VERSION,
  turnUsageRowSchema,
} from "../shared/turn-usage-row";

type PaseoApi = PluginHookContext["paseo"];
type TurnIdentity = Pick<TurnUsage, "turnNumber" | "turnId">;
type TurnBaseline = TurnIdentity & Pick<TurnUsage, "steps" | "totalTokens" | "completedAtMs">;

interface TurnStart {
  sequence: number;
  controller: AbortController;
  turnStartedAt?: number;
  turnId?: string | null;
  // Undefined while the read is pending, null when there is no historical usage.
  baseline?: TurnBaseline | null;
  published?: boolean;
}

interface PublishedTurns {
  latest: TurnIdentity;
  ids: Set<string>;
}

interface TurnUsagePublisherOptions {
  settings: PluginSettings<typeof valuesSchema>;
  readStats: (agentId: string, paseo: PaseoApi) => Promise<Stats | null>;
  retryDelaysMs?: readonly number[];
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function selectTurn(
  stats: Stats | null,
  turnId: string | null,
  turnStartedAt: number,
  baseline: TurnBaseline | null | undefined,
  lastPublished: TurnIdentity | undefined,
): TurnUsage | undefined {
  if (stats?.source !== "session") return;

  if (turnId) {
    const exact = stats.turnUsages.find((turn) => turn.turnId === turnId && turn.totalTokens > 0);
    if (exact) return exact;
  }

  const latest = stats.turnUsages.at(-1);
  if (!latest || latest.totalTokens <= 0 || baseline === undefined) return;
  if (latest.turnNumber === lastPublished?.turnNumber && latest.turnId === lastPublished.turnId) {
    return;
  }

  if (!baseline) {
    if (latest.completedAtMs === null || latest.completedAtMs >= turnStartedAt - 10_000) {
      return latest;
    }
    return;
  }

  if (latest.turnNumber > baseline.turnNumber || (latest.turnId && latest.turnId !== baseline.turnId)) {
    return latest;
  }

  // An unchanged baseline may still be within two seconds of a rapid follow-up.
  const changed =
    latest.steps !== baseline.steps ||
    latest.totalTokens !== baseline.totalTokens ||
    latest.completedAtMs !== baseline.completedAtMs;
  if (changed && latest.completedAtMs !== null && latest.completedAtMs >= turnStartedAt - 2_000) {
    return latest;
  }
}

export class TurnUsagePublisher {
  private readonly retryDelaysMs: readonly number[];
  private readonly now: () => number;
  private readonly sleep: NonNullable<TurnUsagePublisherOptions["sleep"]>;
  private readonly starts = new Map<string, TurnStart>();
  private readonly publishedTurns = new Map<string, PublishedTurns>();
  private startSeq = 0;
  private enabled = true;
  private stopped = false;
  private settingsReady?: Promise<void>;
  private unsubscribe?: () => void | Promise<void>;

  constructor(private readonly options: TurnUsagePublisherOptions) {
    this.retryDelaysMs = options.retryDelaysMs ?? [150, 350, 700];
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms, signal) => setTimeout(ms, undefined, { signal }));
  }

  start(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return (this.settingsReady ??= this.readSettings());
  }

  private async readSettings(): Promise<void> {
    const { settings } = this.options;
    let receivedUpdate = false;
    this.unsubscribe = settings.subscribe((state) => {
      if (this.stopped || state.status !== "ready") return;
      receivedUpdate = true;
      this.enabled = state.values.turnUsageEnabled;
    });
    try {
      const state = await settings.read();
      if (!this.stopped && !receivedUpdate && state.status === "ready") {
        this.enabled = state.values.turnUsageEnabled;
      }
    } catch {
      // Keep the default or the most recent valid settings update.
    }
  }

  private async readStats(agentId: string, paseo: PaseoApi): Promise<Stats | null> {
    try {
      return await this.options.readStats(agentId, paseo);
    } catch {
      return null;
    }
  }

  async onTurnBefore(
    event: PluginHookEvents["agent.turn.before"],
    context: PluginHookContext,
  ): Promise<void> {
    if (this.stopped) return;
    const agentId = event.agent.id;
    const previous = this.starts.get(agentId);
    const start: TurnStart = {
      sequence: ++this.startSeq,
      turnStartedAt: this.now(),
      turnId: event.turnId,
      controller: new AbortController(),
    };
    this.starts.set(agentId, start);
    previous?.controller.abort();

    const stats = context.signal.aborted ? null : await this.readStats(agentId, context.paseo);
    if (start.controller.signal.aborted) return;
    const latest = stats?.source === "session" ? stats.turnUsages.at(-1) : undefined;
    start.baseline = latest
      ? {
          turnNumber: latest.turnNumber,
          turnId: latest.turnId,
          steps: latest.steps,
          totalTokens: latest.totalTokens,
          completedAtMs: latest.completedAtMs,
        }
      : null;
  }

  async onTurnAfter(
    event: PluginHookEvents["agent.turn.after"],
    context: PluginHookContext,
  ): Promise<void> {
    if (event.outcome.kind !== "completed" || this.stopped || context.signal.aborted) return;
    const agentId = event.agent.id;
    const { turnId } = event;
    let start = this.starts.get(agentId);
    if (!start) {
      start = { sequence: ++this.startSeq, controller: new AbortController(), baseline: null };
      this.starts.set(agentId, start);
    }
    const startsBefore = start;
    const turnStartedAt = startsBefore.turnStartedAt ?? this.now();
    if (turnId && startsBefore.turnId && turnId !== startsBefore.turnId) return;

    const signal = AbortSignal.any([context.signal, startsBefore.controller.signal]);
    const canPublish = () => {
      const published = this.publishedTurns.get(agentId);
      return (
        this.enabled &&
        !this.stopped &&
        !signal.aborted &&
        this.starts.get(agentId)?.sequence === startsBefore.sequence &&
        !startsBefore.published &&
        !(turnId && published?.ids.has(turnId))
      );
    };

    await this.settingsReady;
    for (const delay of [null, ...this.retryDelaysMs]) {
      if (!canPublish()) return;
      if (delay !== null) {
        try {
          await this.sleep(delay, signal);
        } catch {
          return;
        }
        if (!canPublish()) return;
      }

      const stats = await this.readStats(agentId, context.paseo);
      if (!canPublish()) return;
      const published = this.publishedTurns.get(agentId);
      const turn = selectTurn(
        stats,
        turnId,
        turnStartedAt,
        startsBefore.baseline,
        published?.latest,
      );
      if (!turn) continue;

      try {
        const data = turnUsageRowSchema.parse({ turn });
        const id = `turn-usage-${turn.turnNumber}-${turn.turnId ?? this.now()}`;
        if (!canPublish()) return;
        const ids = published?.ids ?? new Set<string>();
        if (turn.turnId) ids.add(turn.turnId);
        if (turnId) ids.add(turnId);
        this.publishedTurns.set(agentId, {
          latest: { turnNumber: turn.turnNumber, turnId: turn.turnId },
          ids,
        });
        if (startsBefore.turnStartedAt !== undefined) startsBefore.published = true;
        await context.paseo.agents.ref(agentId).timeline.append({
          type: "plugin",
          id,
          kind: TURN_USAGE_ROW_KIND,
          version: TURN_USAGE_ROW_VERSION,
          data,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/unknown agent|not found/i.test(message)) {
          console.error("Failed to append turn usage for agent", agentId, error);
        }
      }
      return;
    }
  }

  onAgentArchived(agentId: string): void {
    const start = this.starts.get(agentId);
    this.starts.delete(agentId);
    this.publishedTurns.delete(agentId);
    start?.controller.abort();
  }

  async dispose(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const start of this.starts.values()) start.controller.abort();
    this.starts.clear();
    this.publishedTurns.clear();
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    await unsubscribe?.();
  }
}
