import { useRpc, useTranslation, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Text, View, ScrollView } from "react-native";
import {
  averageTtft,
  cachePercent,
  formatDuration,
  formatExactTokens,
  readStats,
  speed,
  totalTokens,
  turnCachePercent,
} from "../shared/stats";
import { messages } from "./messages";

export function StatsPanel({ agentId, theme, layout }: PluginAgentPanelProps) {
  const rpc = useRpc(readStats);
  const { t, locale } = useTranslation(messages);
  const query = useQuery({
    queryKey: ["harness-stats", agentId],
    queryFn: () => rpc({ agentId }),
    refetchInterval: 2000,
  });
  const text = { color: theme.colors.foreground, fontSize: 14 };
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 20 };
  const stats = query.data;
  const status = query.isError
    ? t("error")
    : !stats
      ? t("loading")
      : stats.source !== "session"
        ? t(stats.source)
        : null;
  return (
    <ScrollView contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 20 }}>
      <Text style={{ ...text, fontSize: 20, fontWeight: "600" }}>{t("title")}</Text>
      {status ? (
        <Text accessibilityRole="alert" style={muted}>
          {status}
        </Text>
      ) : (
        stats && (
          <>
            <Text style={{ ...text, fontSize: 18 }}>
              {t("counts", { turns: stats.turns, steps: stats.steps })}
            </Text>
            <Text style={muted}>{t("scope")}</Text>
            {[
              [t("total"), `${totalTokens(stats).toLocaleString()} tok`],
              [t("input"), stats.inputTokens.toLocaleString()],
              [t("cacheRead"), stats.cachedTokens.toLocaleString()],
              [t("cacheWrite"), stats.cacheWriteTokens.toLocaleString()],
              [t("output"), stats.outputTokens.toLocaleString()],
              [t("cache", { percent: cachePercent(stats) ?? "—" }), ""],
              [t("speed"), speed(stats) === null ? "—" : `${Math.round(speed(stats)!)} tok/s`],
              [t("modelTime"), formatDuration(stats.modelMs, locale)],
              [t("toolTime"), formatDuration(stats.toolMs, locale)],
              [
                t("ttft"),
                averageTtft(stats) === null ? "—" : formatDuration(averageTtft(stats)!, locale),
              ],
            ].map(([label, value]) => (
              <View
                key={label}
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  gap: 16,
                  paddingVertical: 10,
                  borderBottomWidth: 1,
                  borderBottomColor: theme.colors.border,
                }}
              >
                <Text style={muted}>{label}</Text>
                <Text style={text}>{value}</Text>
              </View>
            ))}
            {stats.turnUsages.length > 0 && (
              <View style={{ gap: 12, marginTop: 4 }}>
                <Text style={{ ...text, fontSize: 16, fontWeight: "600" }}>
                  {t("turnUsageSection")}
                </Text>
                {stats.turnUsages.map((turn) => {
                  const hit = turnCachePercent(turn);
                  const modelLabel =
                    turn.routes.length > 0
                      ? turn.routes.map((route) => `${route.provider}/${route.model}`).join(", ")
                      : null;
                  const turnRows: Array<[string, string, string?]> = [
                    ...(modelLabel ? [[t("turnUsageModel"), modelLabel] as [string, string]] : []),
                    ...(hit !== null
                      ? [[t("turnUsageCacheHit"), `${hit}%`] as [string, string]]
                      : []),
                    [t("turnUsageInput"), `${formatExactTokens(turn.uncachedInputTokens)} tok`],
                    ...(turn.cachedTokens !== undefined
                      ? [
                          [
                            t("turnUsageCacheRead"),
                            `${formatExactTokens(turn.cachedTokens)} tok`,
                          ] as [string, string],
                        ]
                      : []),
                    ...(turn.cacheWriteTokens !== undefined && turn.cacheWriteTokens > 0
                      ? [
                          [
                            t("turnUsageCacheWrite"),
                            `${formatExactTokens(turn.cacheWriteTokens)} tok`,
                          ] as [string, string],
                        ]
                      : []),
                    [
                      t("turnUsageOutput"),
                      `${formatExactTokens(turn.outputTokens)} tok`,
                      turn.reasoningTokens !== undefined && turn.reasoningTokens > 0
                        ? t("turnUsageReasoning", {
                            tokens: `${formatExactTokens(turn.reasoningTokens)} tok`,
                          })
                        : undefined,
                    ],
                  ];
                  return (
                    <View
                      key={`${turn.turnNumber}-${turn.turnId ?? ""}`}
                      style={{
                        backgroundColor: theme.colors.surface1,
                        borderColor: theme.colors.border,
                        borderWidth: 1,
                        borderRadius: 12,
                        padding: 14,
                        gap: 10,
                      }}
                    >
                      <View
                        style={{
                          flexDirection: "row",
                          justifyContent: "space-between",
                          alignItems: "baseline",
                          gap: 12,
                          paddingBottom: 10,
                          borderBottomWidth: 1,
                          borderBottomColor: theme.colors.border,
                        }}
                      >
                        <Text style={{ ...text, fontWeight: "600" }}>
                          {t("turnUsageItem", { turn: turn.turnNumber })}
                        </Text>
                        <Text style={{ ...text, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
                          {`${formatExactTokens(turn.totalTokens)} tok`}
                        </Text>
                      </View>
                      {turnRows.map(([label, value, suffix]) => (
                        <View
                          key={label}
                          style={{
                            flexDirection: "row",
                            justifyContent: "space-between",
                            alignItems: "baseline",
                            gap: 16,
                          }}
                        >
                          <Text style={muted}>{label}</Text>
                          <Text
                            style={{
                              ...text,
                              flexShrink: 1,
                              textAlign: "right",
                              fontVariant: ["tabular-nums"],
                            }}
                          >
                            {value}
                            {suffix ? <Text style={muted}>{suffix}</Text> : null}
                          </Text>
                        </View>
                      ))}
                    </View>
                  );
                })}
              </View>
            )}
          </>
        )
      )}
    </ScrollView>
  );
}
