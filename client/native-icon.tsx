import { useEffect } from "react";
import { useRpc, useTranslation, type PluginButtonIconProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { readStats, type Stats } from "../shared/stats";
import { messages } from "./messages";

/** The host mounts button icons only for the visible composer, which bounds polling. */
export function statIcon(
  kind: "activity" | "usage",
  onStats: (stats: Stats) => void,
  peek: () => Stats | undefined,
) {
  return function NativeStatIcon(props: PluginButtonIconProps) {
    const rpc = useRpc(readStats),
      { locale } = useTranslation(messages);
    const agentId = props.context === "agent" ? props.agentId : null;
    const query = useQuery({
      queryKey: ["harness-stats", agentId],
      queryFn: () => rpc({ agentId: agentId! }),
      enabled: agentId !== null,
      initialData: peek,
      refetchInterval: 2000,
    });
    useEffect(() => {
      if (query.data) onStats(query.data);
    }, [query.data, locale]);
    return (
      <Icon
        name={kind === "activity" ? "Gauge" : "Database"}
        size={props.size}
        color={props.color}
      />
    );
  };
}
