import type {
  PluginButtonRegistration,
  PluginClientContext,
  PluginComposerPillContribution,
  PluginText,
} from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import { StatsPanel } from "./client/panel";
import { installFooter } from "./client/web";
import { messages } from "./client/messages";
import {
  cachePercent,
  formatDuration,
  formatTokens,
  readStats,
  speed,
  totalTokens,
  type Stats,
} from "./shared/stats";
import { ActivityPopover, UsagePopover } from "./client/popover";
import { ThemeBridge } from "./client/theme-bridge";
import { getTheme, subscribeTheme } from "./client/theme-state";
import { StatsCache } from "./client/cache";
import { statIcon } from "./client/native-icon";
import { HarnessSettings } from "./client/settings";
import { getPreferences, subscribePreferences } from "./client/preferences";
import type { HarnessPreferences } from "./shared/preferences";

export default function contribute(client: PluginClientContext) {
  const lifetime = new AbortController();
  const agents = new Map<string, string>();
  const cache = new StatsCache((agentId) => client.rpc(readStats, { agentId }));
  const pills = new Map<string, PluginButtonRegistration>();
  let currentPreferences = getPreferences();
  const removeSettings = client.addSettingsScreen({
    id: "settings",
    title: messages.message("title"),
    icon: "Gauge",
    Component: HarnessSettings,
  });
  const removeThemeBridge = client.addSidebarFooterItem({
    id: "theme",
    title: messages.message("title"),
    Component: ThemeBridge,
  });
  const removePanel = client.addWorkspacePanel({
    id: "stats",
    title: messages.message("title"),
    icon: "Gauge",
    context: "agent",
    Component: StatsPanel,
  });
  const removeCommand = client.addCommandCenterItem({
    id: "stats",
    title: messages.message("title"),
    icon: "Gauge",
    context: "agent",
    onSelect: ({ openPanel }) => openPanel("stats"),
  });
  const createFooter = () =>
    installFooter({
      isWeb: Platform.OS === "web" && currentPreferences.enabled,
      hasAgent: (id) => agents.has(id),
      read: (agentId) => cache.read(agentId),
      peek: (agentId) => cache.peek(agentId),
      theme: getTheme,
      subscribeTheme,
      copy: () => ({
        counts: (turns, steps) => client.i18n.t(messages, "counts", { turns, steps }),
        cache: (percent) => client.i18n.t(messages, "cache", { percent }),
        loading: client.i18n.t(messages, "loading"),
        unavailable: client.i18n.t(messages, "unavailable"),
        unsupported: client.i18n.t(messages, "unsupported"),
        error: client.i18n.t(messages, "error"),
        details: client.i18n.t(messages, "details"),
        tokenTitle: client.i18n.t(messages, "tokenTitle"),
        uncached: client.i18n.t(messages, "uncached"),
        cacheRead: client.i18n.t(messages, "cacheRead"),
        cacheWrite: client.i18n.t(messages, "cacheWrite"),
        output: client.i18n.t(messages, "output"),
        modelTime: client.i18n.t(messages, "modelTime"),
        toolTime: client.i18n.t(messages, "toolTime"),
        ttft: client.i18n.t(messages, "ttft"),
        speed: client.i18n.t(messages, "speed"),
        cacheLabel: client.i18n.t(messages, "cacheLabel"),
        duration: (ms) => formatDuration(ms, client.i18n.locale),
      }),
    });
  let removeFooter = createFooter();
  const removePreferences = subscribePreferences((value) => {
    const changedPlacement = currentPreferences.mobilePlacement !== value.mobilePlacement;
    const changedEnabled = currentPreferences.enabled !== value.enabled;
    currentPreferences = value;
    if (changedEnabled) {
      removeFooter();
      removeFooter = createFooter();
    }
    if (!value.enabled || changedPlacement) {
      for (const pill of pills.values()) pill.remove();
      pills.clear();
    }
    if (value.enabled) for (const [id, workspaceId] of agents) register({ id, workspaceId });
  });
  function removePills(id: string) {
    for (const kind of ["activity", "usage"]) {
      pills.get(`${id}:${kind}`)?.remove();
      pills.delete(`${id}:${kind}`);
    }
  }
  function removeAgent(id: string) {
    agents.delete(id);
    removePills(id);
  }
  function register(agent: {
    id: string;
    workspaceId?: string | null;
    archivedAt?: string | null;
  }) {
    if (!agent.workspaceId || agent.archivedAt) {
      removeAgent(agent.id);
      return;
    }
    const newlySeen = !agents.has(agent.id);
    if (agents.get(agent.id) !== agent.workspaceId) removePills(agent.id);
    agents.set(agent.id, agent.workspaceId);
    if (!currentPreferences.enabled) {
      removePills(agent.id);
      return;
    }
    if (newlySeen) cache.prefetch(agent.id);
    if (Platform.OS !== "web" && !pills.has(`${agent.id}:activity`)) {
      const updateLabels = (stats: Stats) => {
        if (lifetime.signal.aborted || stats.source !== "session") return;
        const tps = speed(stats),
          cacheHit = cachePercent(stats);
        pills
          .get(`${agent.id}:activity`)
          ?.update({
            label:
              client.i18n.t(messages, "counts", { turns: stats.turns, steps: stats.steps }) +
              (tps === null ? "" : ` · ${Math.round(tps)} tok/s`),
          });
        pills
          .get(`${agent.id}:usage`)
          ?.update({
            label:
              `${formatTokens(totalTokens(stats))} tok` +
              (cacheHit === null
                ? ""
                : ` · ${client.i18n.t(messages, "cache", { percent: cacheHit })}`),
          });
      };
      // The source patch adds this optional field. Older clients keep their track placement.
      const addPill = (
        input: PluginComposerPillContribution<PluginText> & {
          placement: HarnessPreferences["mobilePlacement"];
        },
      ) => client.addComposerPill(input);
      pills.set(
        `${agent.id}:activity`,
        addPill({
          id: "activity",
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          placement: currentPreferences.mobilePlacement,
          button: {
            title: messages.message("details"),
            label: messages.message("title"),
            icon: statIcon("activity", updateLabels, () => cache.peek(agent.id)),
            behavior: { kind: "popover", Content: ActivityPopover },
          },
        }),
      );
      pills.set(
        `${agent.id}:usage`,
        addPill({
          id: "usage",
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          placement: currentPreferences.mobilePlacement,
          button: {
            title: messages.message("tokenTitle"),
            label: messages.message("tokenTitle"),
            icon: statIcon("usage", updateLabels, () => cache.peek(agent.id)),
            behavior: { kind: "popover", Content: UsagePopover },
          },
        }),
      );
      const cached = cache.peek(agent.id);
      if (cached) updateLabels(cached);
    }
  }
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      if (lifetime.signal.aborted) return;
      subscription.subscribe({
        snapshot: ({ entries }) => {
          const present = new Set(entries.map(({ agent }) => agent.id));
          for (const id of agents.keys()) if (!present.has(id)) removeAgent(id);
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (lifetime.signal.aborted || message.type !== "agent_update") return;
          const change = message.payload;
          if (change.kind === "upsert") register(change.agent);
          else removeAgent(change.agentId);
        },
      });
    })
    .catch((error) => {
      if (!lifetime.signal.aborted)
        console.error("[harness-stats] Agent observation failed", error);
    });
  return () => {
    lifetime.abort();
    cache.clear();
    removeFooter();
    removeThemeBridge();
    removePreferences();
    removeSettings();
    removeCommand();
    removePanel();
    for (const pill of pills.values()) pill.remove();
    pills.clear();
    agents.clear();
  };
}
