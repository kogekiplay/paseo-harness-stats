import { useState } from "react";
import { useRpc, useTranslation, type PluginButtonContentProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import { formatRatePerMillion, formatUsd } from "../shared/pricing";
import {
  averageTtft,
  cachePercent,
  formatDuration,
  formatExactTokens,
  formatTokens,
  readStats,
  speed,
  totalTokens,
} from "../shared/stats";
import { messages } from "./messages";
import { TurnUsageBreakdown } from "./turn-usage-row";

interface CostRow {
  label: string;
  rate?: number;
  usd: number;
  tokens: string;
}

function StatsPopover(props: PluginButtonContentProps & { kind: "activity" | "usage" }) {
  const rpc = useRpc(readStats),
    { t, locale } = useTranslation(messages);
  const [tab, setTab] = useState<"session" | "turns">("session");
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
  const usageCost = !activity && stats && !status ? stats.cost : undefined;
  const hasTurns = Boolean(!activity && stats && !status && stats.turnUsages.length > 0);
  const activeTab = hasTurns ? tab : "session";
  const latestTurn = hasTurns && stats ? stats.turnUsages[stats.turnUsages.length - 1] : null;
  const orderedTurns = hasTurns && stats ? [...stats.turnUsages].reverse() : [];
  const uncachedTokens = stats
    ? Math.max(0, stats.inputTokens - stats.cachedTokens - stats.cacheWriteTokens)
    : 0;
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
          [t("uncached"), `${uncachedTokens.toLocaleString()} tok`],
          [t("cacheRead"), `${stats.cachedTokens.toLocaleString()} tok`],
          ...(stats.cacheWriteTokens > 0
            ? [[t("cacheWrite"), `${stats.cacheWriteTokens.toLocaleString()} tok`]]
            : []),
          [t("output"), `${stats.outputTokens.toLocaleString()} tok`],
        ];
  const costRows: CostRow[] =
    stats && usageCost
      ? [
          {
            label: t("uncached"),
            rate: usageCost.ratesPerMillion?.uncachedInput,
            usd: usageCost.uncachedInputUsd,
            tokens: `${formatExactTokens(uncachedTokens)} tok`,
          },
          {
            label: t("cacheRead"),
            rate: usageCost.ratesPerMillion?.cachedInput,
            usd: usageCost.cachedInputUsd,
            tokens: `${formatExactTokens(stats.cachedTokens)} tok`,
          },
          ...(stats.cacheWriteTokens > 0
            ? [
                {
                  label: t("cacheWrite"),
                  rate: usageCost.ratesPerMillion?.cacheWrite,
                  usd: usageCost.cacheWriteUsd,
                  tokens: `${formatExactTokens(stats.cacheWriteTokens)} tok`,
                },
              ]
            : []),
          {
            label: t("output"),
            rate: usageCost.ratesPerMillion?.output,
            usd: usageCost.outputUsd,
            tokens: `${formatExactTokens(stats.outputTokens)} tok`,
          },
        ]
      : [];
  const cacheHit = stats ? cachePercent(stats) : null;
  return (
    <View
      style={{ padding: props.layout.compact ? 16 : 20, gap: 16, backgroundColor: colors.surface1 }}
    >
      <View
        style={{
          gap: usageCost ? 4 : 0,
          paddingBottom: 16,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
          <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "600" }}>
            {t(activity ? "title" : "tokenTitle")}
          </Text>
          {stats && !status && (
            <Text
              style={{
                color: colors.foreground,
                fontSize: 14,
                fontWeight: "600",
                fontVariant: ["tabular-nums"],
              }}
            >
              {activity
                ? t("counts", { turns: stats.turns, steps: stats.steps })
                : usageCost
                  ? formatUsd(usageCost.totalUsd, "detail")
                  : `${totalTokens(stats).toLocaleString()} tok`}
            </Text>
          )}
        </View>
        {stats && usageCost && (
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "baseline",
              gap: 12,
            }}
          >
            <Text style={{ color: colors.foregroundMuted, fontSize: 12, flexShrink: 1 }}>
              {t(usageCost.complete ? "costOfficialHint" : "costPartialHint")}
            </Text>
            <Text
              style={{
                color: colors.foregroundMuted,
                fontSize: 12,
                fontVariant: ["tabular-nums"],
              }}
            >
              {`${formatExactTokens(totalTokens(stats))} tok`}
            </Text>
          </View>
        )}
      </View>
      {hasTurns && stats && (
        <View
          accessibilityRole="tablist"
          style={{
            flexDirection: "row",
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: 10,
            padding: 3,
            gap: 4,
          }}
        >
          {(
            [
              ["session", t("popoverSessionTab")],
              ["turns", t("popoverTurnsTab", { count: stats.turnUsages.length })],
            ] as const
          ).map(([key, label]) => {
            const selected = activeTab === key;
            return (
              <Pressable
                key={key}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                onPress={() => setTab(key)}
                style={{
                  flex: 1,
                  paddingVertical: 6,
                  paddingHorizontal: 10,
                  borderRadius: 7,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: selected ? colors.surface2 : "transparent",
                }}
              >
                <Text
                  numberOfLines={1}
                  style={{
                    color: selected ? colors.foreground : colors.foregroundMuted,
                    fontSize: 13,
                    fontWeight: selected ? "600" : "500",
                  }}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
      {status ? (
        <Text accessibilityRole="alert" style={{ color: colors.foregroundMuted }}>
          {status}
        </Text>
      ) : activeTab === "turns" ? (
        <ScrollView
          style={{ maxHeight: props.layout.compact ? 360 : 420 }}
          contentContainerStyle={{ gap: 12 }}
        >
          {orderedTurns.map((turn) => {
            const turnCost = turn.cost;
            return (
              <View
                key={`${turn.turnNumber}-${turn.turnId ?? ""}`}
                style={{
                  backgroundColor: colors.surface0,
                  borderColor: colors.border,
                  borderWidth: 1,
                  borderRadius: 12,
                  padding: 12,
                  gap: 10,
                }}
              >
                <View
                  style={{
                    gap: 4,
                    paddingBottom: 10,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.border,
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
                    <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>
                      {t("turnUsageItem", { turn: turn.turnNumber })}
                    </Text>
                    <Text
                      style={{
                        color: colors.foreground,
                        fontSize: 13,
                        fontWeight: "600",
                        flexShrink: 1,
                        textAlign: "right",
                        fontVariant: ["tabular-nums"],
                      }}
                    >
                      {turnCost
                        ? `${formatExactTokens(turn.totalTokens)} tok · ${formatUsd(turnCost.totalUsd, "detail")}`
                        : `${formatExactTokens(turn.totalTokens)} tok`}
                    </Text>
                  </View>
                  {turnCost && !turnCost.complete && (
                    <Text style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>
                      {t("costPartialHint")}
                    </Text>
                  )}
                </View>
                <TurnUsageBreakdown turn={turn} theme={props.theme} />
              </View>
            );
          })}
        </ScrollView>
      ) : usageCost ? (
        <>
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "baseline",
              gap: 16,
            }}
          >
            <Text style={{ color: colors.foregroundMuted, fontSize: 14, flexShrink: 1 }}>
              {t("cacheLabel")}
            </Text>
            <Text
              style={{
                color: colors.foreground,
                fontSize: 14,
                fontVariant: ["tabular-nums"],
              }}
            >
              {cacheHit === null ? "—" : `${cacheHit}%`}
            </Text>
          </View>
          {costRows.map((row) => (
            <View
              key={row.label}
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 16,
              }}
            >
              <View style={{ flexShrink: 1, gap: 2 }}>
                <Text style={{ color: colors.foregroundMuted, fontSize: 14 }}>{row.label}</Text>
                {row.rate !== undefined && (
                  <Text
                    style={{
                      color: colors.foregroundMuted,
                      fontSize: 11,
                      opacity: 0.78,
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {formatRatePerMillion(row.rate)}
                  </Text>
                )}
              </View>
              <View style={{ alignItems: "flex-end", gap: 2 }}>
                <Text
                  style={{
                    color: colors.foreground,
                    fontSize: 14,
                    fontWeight: "500",
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {formatUsd(row.usd, "detail")}
                </Text>
                <Text
                  style={{
                    color: colors.foregroundMuted,
                    fontSize: 12,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {row.tokens}
                </Text>
              </View>
            </View>
          ))}
        </>
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
      {activeTab === "session" && latestTurn && (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: colors.border,
            paddingTop: 10,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${t("popoverLatestTurn", { turn: latestTurn.turnNumber })} · ${t("popoverViewTurns")}`}
            onPress={() => setTab("turns")}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              paddingVertical: 6,
              paddingHorizontal: 8,
              marginHorizontal: -8,
              borderRadius: 8,
              backgroundColor: pressed ? colors.surface2 : "transparent",
            })}
          >
            <Text style={{ color: colors.foregroundMuted, fontSize: 13, flexShrink: 1 }}>
              {t("popoverLatestTurn", { turn: latestTurn.turnNumber })}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 }}>
              <Text
                style={{
                  color: colors.foreground,
                  fontSize: 13,
                  fontWeight: "500",
                  fontVariant: ["tabular-nums"],
                }}
              >
                {`${formatTokens(latestTurn.totalTokens)} tok${
                  latestTurn.cost ? ` · ${formatUsd(latestTurn.cost.totalUsd, "compact")}` : ""
                }`}
              </Text>
              <Icon name="ChevronRight" size={14} color={colors.foregroundMuted} />
            </View>
          </Pressable>
        </View>
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
