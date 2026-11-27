import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { SessionReader } from "./server/sessions";
import { TurnUsagePublisher } from "./server/turn-usage-row";
import { preferences } from "./shared/preferences";
import { readStats, type Stats } from "./shared/stats";

export default function contribute(server: PluginServerContext) {
  const reader = new SessionReader();
  async function readAgentStats(
    agentId: string,
    paseo: PluginHandlerContext["paseo"],
  ): Promise<Stats | null> {
    const result = await paseo.agents.ref(agentId).refresh();
    if (!result) return null;
    const agent = result.agent;
    return reader.read(
      agent.provider,
      agent.persistence?.nativeHandle ??
        agent.persistence?.sessionId ??
        agent.runtimeInfo?.sessionId ??
        null,
      agent.cwd,
      agent.model ?? agent.runtimeInfo?.model ?? null,
    );
  }

  const settings = server.registerSettings(preferences);
  const publisher = new TurnUsagePublisher({ settings, readStats: readAgentStats });
  void publisher.start();
  server.handle(readStats, async ({ agentId }, { paseo }) => {
    const result = await readAgentStats(agentId, paseo);
    if (!result) throw new Error("Agent is no longer available");
    return result;
  });
  const removeTurnBefore = server.addHook("agent.turn.before", async (event, context) =>
    publisher.onTurnBefore(event, context),
  );
  const removeTurnAfter = server.addHook("agent.turn.after", async (event, context) =>
    publisher.onTurnAfter(event, context),
  );
  const removeAgentArchive = server.addHook("agent.archive.after", async ({ agent }) => {
    publisher.onAgentArchived(agent.id);
  });

  return async () => {
    removeTurnBefore();
    removeTurnAfter();
    removeAgentArchive();
    try {
      await publisher.dispose();
    } finally {
      reader.clear();
    }
  };
}
