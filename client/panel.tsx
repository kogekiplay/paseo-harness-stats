import { useRpc, useTranslation, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Text, View, ScrollView } from "react-native";
import { formatRatePerMillion, formatUsd } from "../shared/pricing";
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

interface PanelSummaryRow {
  label: string;
  value: string;
  sublabel?: string;
}

interface TurnBreakdownRow {
  label: string;
  value: string;
  suffix?: string;
  usd?: number;
  rate?: number;
}

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
  const summaryRows: PanelSummaryRow[] = stats
    ? [
        { label: t("total"), value: `${totalTokens(stats).toLocaleString()} tok` },
        ...(stats.cost
          ? [
              {
                label: t("costLabel"),
                value: formatUsd(stats.cost.totalUsd, "detail"),
                sublabel: t(stats.cost.complete ? "costOfficialHint" : "costPartialHint"),
              },
            ]
          : []),
        { label: t("input"), value: stats.inputTokens.toLocaleString() },
        { label: t("cacheRead"), value: stats.cachedTokens.toLocaleString() },
        { label: t("cacheWrite"), value: stats.cacheWriteTokens.toLocaleString() },
        { label: t("output"), value: stats.outputTokens.toLocaleString() },
        { label: t("cache", { percent: cachePercent(stats) ?? "—" }), value: "" },
        {
          label: t("speed"),
          value: speed(stats) === null ? "—" : `${Math.round(speed(stats)!)} tok/s`,
        },
        { label: t("modelTime"), value: formatDuration(stats.modelMs, locale) },
        { label: t("toolTime"), value: formatDuration(stats.toolMs, locale) },
        {
          label: t("ttft"),
          value: averageTtft(stats) === null ? "—" : formatDuration(averageTtft(stats)!, locale),
        },
      ]
    : [];
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
            {summaryRows.map(({ label, value, sublabel }) => (
              <View
                key={label}
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: sublabel ? "flex-start" : "baseline",
                  gap: 16,
                  paddingVertical: 10,
                  borderBottomWidth: 1,
                  borderBottomColor: theme.colors.border,
                }}
              >
                <View style={{ flexShrink: 1, gap: 2 }}>
                  <Text style={muted}>{label}</Text>
                  {sublabel ? (
                    <Text style={{ ...muted, fontSize: 12, lineHeight: 16, opacity: 0.85 }}>
                      {sublabel}
                    </Text>
                  ) : null}
                </View>
                <Text
                  style={{
                    ...text,
                    fontVariant: ["tabular-nums"],
                    ...(sublabel ? { fontWeight: "600" as const } : {}),
                  }}
                >
                  {value}
                </Text>
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
                  const turnCost = turn.cost;
                  const metaRows: Array<[string, string]> = [
                    ...(modelLabel ? [[t("turnUsageModel"), modelLabel] as [string, string]] : []),
                    ...(hit !== null
                      ? [[t("turnUsageCacheHit"), `${hit}%`] as [string, string]]
                      : []),
                  ];
                  const breakdownRows: TurnBreakdownRow[] = [
                    {
                      label: t("turnUsageInput"),
                      value: `${formatExactTokens(turn.uncachedInputTokens)} tok`,
                      usd: turnCost?.uncachedInputUsd,
                      rate: turnCost?.ratesPerMillion?.uncachedInput,
                    },
                    ...(turn.cachedTokens !== undefined
                      ? [
                          {
                            label: t("turnUsageCacheRead"),
                            value: `${formatExactTokens(turn.cachedTokens)} tok`,
                            usd: turnCost?.cachedInputUsd,
                            rate: turnCost?.ratesPerMillion?.cachedInput,
                          },
                        ]
                      : []),
                    ...(turn.cacheWriteTokens !== undefined && turn.cacheWriteTokens > 0
                      ? [
                          {
                            label: t("turnUsageCacheWrite"),
                            value: `${formatExactTokens(turn.cacheWriteTokens)} tok`,
                            usd: turnCost?.cacheWriteUsd,
                            rate: turnCost?.ratesPerMillion?.cacheWrite,
                          },
                        ]
                      : []),
                    {
                      label: t("turnUsageOutput"),
                      value: `${formatExactTokens(turn.outputTokens)} tok`,
                      suffix:
                        turn.reasoningTokens !== undefined && turn.reasoningTokens > 0
                          ? t("turnUsageReasoning", {
                              tokens: `${formatExactTokens(turn.reasoningTokens)} tok`,
                            })
                          : undefined,
                      usd: turnCost?.outputUsd,
                      rate: turnCost?.ratesPerMillion?.output,
                    },
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
                          gap: 4,
                          paddingBottom: 10,
                          borderBottomWidth: 1,
                          borderBottomColor: theme.colors.border,
                        }}
                      >
                        <View
                          style={{
                            flexDirection: "row",
                            justifyContent: "space-between",
                            alignItems: "baseline",
                            gap: 12,
                          }}
                        >
                          <Text style={{ ...text, fontWeight: "600" }}>
                            {t("turnUsageItem", { turn: turn.turnNumber })}
                          </Text>
                          <Text
                            style={{ ...text, fontWeight: "600", fontVariant: ["tabular-nums"] }}
                          >
                            {turnCost
                              ? `${formatExactTokens(turn.totalTokens)} tok · ${formatUsd(turnCost.totalUsd, "detail")}`
                              : `${formatExactTokens(turn.totalTokens)} tok`}
                          </Text>
                        </View>
                        {turnCost && !turnCost.complete && (
                          <Text style={{ ...muted, fontSize: 11, lineHeight: 16 }}>
                            {t("costPartialHint")}
                          </Text>
                        )}
                      </View>
                      {metaRows.map(([label, value]) => (
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
                          </Text>
                        </View>
                      ))}
                      {breakdownRows.map(({ label, value, suffix, usd, rate }) =>
                        turnCost && usd !== undefined ? (
                          <View
                            key={label}
                            style={{
                              flexDirection: "row",
                              justifyContent: "space-between",
                              alignItems: "flex-start",
                              gap: 16,
                            }}
                          >
                            <View style={{ flexShrink: 1, gap: 2 }}>
                              <Text style={muted}>{label}</Text>
                              {rate !== undefined && (
                                <Text
                                  style={{
                                    ...muted,
                                    fontSize: 11,
                                    lineHeight: 16,
                                    opacity: 0.78,
                                    fontVariant: ["tabular-nums"],
                                  }}
                                >
                                  {formatRatePerMillion(rate)}
                                </Text>
                              )}
                            </View>
                            <View style={{ alignItems: "flex-end", gap: 2, flexShrink: 1 }}>
                              <Text
                                style={{
                                  ...text,
                                  fontWeight: "500",
                                  textAlign: "right",
                                  fontVariant: ["tabular-nums"],
                                }}
                              >
                                {formatUsd(usd, "detail")}
                              </Text>
                              <Text
                                style={{
                                  ...muted,
                                  fontSize: 12,
                                  lineHeight: 18,
                                  textAlign: "right",
                                  fontVariant: ["tabular-nums"],
                                }}
                              >
                                {value}
                                {suffix ? (
                                  <Text
                                    style={{
                                      ...muted,
                                      fontSize: 12,
                                      lineHeight: 18,
                                      opacity: 0.78,
                                    }}
                                  >
                                    {suffix}
                                  </Text>
                                ) : null}
                              </Text>
                            </View>
                          </View>
                        ) : (
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
                        ),
                      )}
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
