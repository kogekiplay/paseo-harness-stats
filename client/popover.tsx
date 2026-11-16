import { useRpc, useTranslation, type PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import {
  averageTtft,
  cachePercent,
  formatDuration,
  readStats,
  speed,
  totalTokens,
} from "../shared/stats";
import { messages } from "./messages";

function StatsPopover(props: PluginButtonContentProps & { kind: "activity" | "usage" }) {
  const rpc = useRpc(readStats),
    { t, locale } = useTranslation(messages);
  const agentId = props.context === "agent" ? props.agentId : null;
  const query = useQuery({
    queryKey: ["harness-stats", agentId],
    queryFn: () => rpc({ agentId: agentId! }),
    enabled: agentId !== null,
    refetchInterval: 2000,
  });
  const stats = query.data,
    { colors } = props.theme;
  const status = query.isError
    ? t("error")
    : !stats
      ? t("loading")
      : stats.source !== "session"
        ? t(stats.source)
        : null;
  const activity = props.kind === "activity";
  const rows = !stats
    ? []
    : activity
      ? [
          [t("modelTime"), formatDuration(stats.modelMs, locale)],
          [t("toolTime"), formatDuration(stats.toolMs, locale)],
          [
            t("ttft"),
            averageTtft(stats) === null ? "—" : formatDuration(averageTtft(stats)!, locale),
          ],
          [t("speed"), speed(stats) === null ? "—" : `${Math.round(speed(stats)!)} tok/s`],
        ]
      : [
          [t("cacheLabel"), cachePercent(stats) === null ? "—" : `${cachePercent(stats)}%`],
          [
            t("uncached"),
            `${Math.max(0, stats.inputTokens - stats.cachedTokens - stats.cacheWriteTokens).toLocaleString()} tok`,
          ],
          [t("cacheRead"), `${stats.cachedTokens.toLocaleString()} tok`],
          ...(stats.cacheWriteTokens > 0
            ? [[t("cacheWrite"), `${stats.cacheWriteTokens.toLocaleString()} tok`]]
            : []),
          [t("output"), `${stats.outputTokens.toLocaleString()} tok`],
        ];
  return (
    <View
      style={{ padding: props.layout.compact ? 16 : 20, gap: 16, backgroundColor: colors.surface1 }}
    >
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          gap: 12,
          paddingBottom: 16,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}
      >
        <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "600" }}>
          {t(activity ? "title" : "tokenTitle")}
        </Text>
        {stats && !status && (
          <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>
            {activity
              ? t("counts", { turns: stats.turns, steps: stats.steps })
              : `${totalTokens(stats).toLocaleString()} tok`}
          </Text>
        )}
      </View>
      {status ? (
        <Text accessibilityRole="alert" style={{ color: colors.foregroundMuted }}>
          {status}
        </Text>
      ) : (
        rows.map(([label, value]) => (
          <View
            key={label}
            style={{ flexDirection: "row", justifyContent: "space-between", gap: 16 }}
          >
            <Text style={{ color: colors.foregroundMuted, fontSize: 14, flexShrink: 1 }}>
              {label}
            </Text>
            <Text style={{ color: colors.foregroundMuted, fontSize: 14 }}>{value}</Text>
          </View>
        ))
      )}
    </View>
  );
}
export const ActivityPopover = (props: PluginButtonContentProps) => (
  <StatsPopover {...props} kind="activity" />
);
export const UsagePopover = (props: PluginButtonContentProps) => (
  <StatsPopover {...props} kind="usage" />
);
