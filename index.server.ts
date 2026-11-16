import type { PluginServerContext } from "@getpaseo/plugin/server";
import { SessionReader } from "./server/sessions";
import { readStats } from "./shared/stats";
import { preferences } from "./shared/preferences";

export default function contribute(server: PluginServerContext) {
  const reader = new SessionReader();
  server.registerSettings(preferences);
  server.handle(readStats, async ({ agentId }, { paseo }) => {
    const result = await paseo.agents.ref(agentId).refresh();
    if (!result) throw new Error("Agent is no longer available");
    const agent = result.agent;
    return reader.read(
      agent.provider,
      agent.persistence?.nativeHandle ??
        agent.persistence?.sessionId ??
        agent.runtimeInfo?.sessionId ??
        null,
      agent.cwd,
    );
  });
  return () => reader.clear();
}
