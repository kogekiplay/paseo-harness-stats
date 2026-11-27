import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import {
  useSettings,
  useTranslation,
  type PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { formatRatePerMillion, formatUsd } from "../shared/pricing";
import { preferences } from "../shared/preferences";
import {
  formatExactTokens,
  formatTokens,
  turnCachePercent,
  type TurnUsage,
} from "../shared/stats";
import type { TurnUsageRowData } from "../shared/turn-usage-row";
import { messages } from "./messages";
import { getPreferences } from "./preferences";

interface TurnBreakdownRow {
  label: string;
  tokens: string;
  suffix?: string;
  usd?: number;
  rate?: number;
}

export function TurnUsageBreakdown({ turn, theme }: { turn: TurnUsage; theme: PluginTheme }) {
  const { t } = useTranslation(messages);
  const { colors } = theme;
  const turnCost = turn.cost;
  const hit = turnCachePercent(turn);
  const modelLabel =
    turn.routes.length > 0
      ? turn.routes.map((route) => `${route.provider}/${route.model}`).join(", ")
      : null;

  const metaRows: Array<[string, string]> = [
    ...(modelLabel ? [[t("turnUsageModel"), modelLabel] as [string, string]] : []),
    ...(hit !== null ? [[t("turnUsageCacheHit"), `${hit}%`] as [string, string]] : []),
  ];

  const breakdownRows: TurnBreakdownRow[] = [
    {
      label: t("turnUsageInput"),
      tokens: `${formatExactTokens(turn.uncachedInputTokens)} tok`,
      usd: turnCost?.uncachedInputUsd,
      rate: turnCost?.ratesPerMillion?.uncachedInput,
    },
    ...(turn.cachedTokens !== undefined
      ? [
          {
            label: t("turnUsageCacheRead"),
            tokens: `${formatExactTokens(turn.cachedTokens)} tok`,
            usd: turnCost?.cachedInputUsd,
            rate: turnCost?.ratesPerMillion?.cachedInput,
          },
        ]
      : []),
    ...(turn.cacheWriteTokens !== undefined && turn.cacheWriteTokens > 0
      ? [
          {
            label: t("turnUsageCacheWrite"),
            tokens: `${formatExactTokens(turn.cacheWriteTokens)} tok`,
            usd: turnCost?.cacheWriteUsd,
            rate: turnCost?.ratesPerMillion?.cacheWrite,
          },
        ]
      : []),
    {
      label: t("turnUsageOutput"),
      tokens: `${formatExactTokens(turn.outputTokens)} tok`,
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
    <>
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
          <Text style={{ color: colors.foregroundMuted, fontSize: 13, flexShrink: 0 }}>
            {label}
          </Text>
          <Text
            style={{
              color: colors.foreground,
              fontSize: 13,
              flexShrink: 1,
              textAlign: "right",
              fontVariant: ["tabular-nums"],
            }}
          >
            {value}
          </Text>
        </View>
      ))}
      {breakdownRows.map(({ label, tokens, suffix, usd, rate }) =>
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
              <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{label}</Text>
              {rate !== undefined && (
                <Text
                  style={{
                    color: colors.foregroundMuted,
                    fontSize: 11,
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
                  color: colors.foreground,
                  fontSize: 13,
                  fontWeight: "500",
                  textAlign: "right",
                  fontVariant: ["tabular-nums"],
                }}
              >
                {formatUsd(usd, "detail")}
              </Text>
              <Text
                style={{
                  color: colors.foregroundMuted,
                  fontSize: 12,
                  textAlign: "right",
                  fontVariant: ["tabular-nums"],
                }}
              >
                {tokens}
                {suffix ? (
                  <Text style={{ color: colors.foregroundMuted, fontSize: 12, opacity: 0.78 }}>
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
            <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{label}</Text>
            <Text
              style={{
                color: colors.foreground,
                fontSize: 13,
                flexShrink: 1,
                textAlign: "right",
                fontVariant: ["tabular-nums"],
              }}
            >
              {tokens}
              {suffix ? (
                <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{suffix}</Text>
              ) : null}
            </Text>
          </View>
        ),
      )}
    </>
  );
}

export function TurnUsageRow({ item, theme, layout }: PluginTimelineItemProps<TurnUsageRowData>) {
  const [open, setOpen] = useState(false);
  const settings = useSettings(preferences);
  const { t } = useTranslation(messages);

  if (layout.platform === "web") return null;

  const turnUsageEnabled =
    settings.status === "ready"
      ? settings.values.turnUsageEnabled
      : getPreferences().turnUsageEnabled;
  if (!turnUsageEnabled) return null;

  const turn = item.data.turn;
  if (turn.totalTokens <= 0) return null;

  const { colors } = theme;
  const turnCost = turn.cost;
  const baseTriggerText = t("turnUsageConsumed", {
    total: `${formatTokens(turn.totalTokens)} tok`,
  });
  const triggerText = turnCost
    ? `${baseTriggerText} · ${formatUsd(turnCost.totalUsd, "compact")}`
    : baseTriggerText;
  const exactTotalText = `${formatExactTokens(turn.totalTokens)} tok`;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${t("turnUsageTitle")}: ${triggerText}`}
        onPress={() => setOpen(true)}
        style={({ pressed }) => ({
          alignSelf: "flex-start",
          height: 28,
          borderRadius: 14,
          paddingHorizontal: 10,
          backgroundColor: pressed ? colors.surface2 : colors.surface1,
          borderWidth: 1,
          borderColor: colors.border,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          marginTop: 4,
        })}
      >
        <Icon name="Database" size={13} color={colors.foregroundMuted} />
        <Text
          numberOfLines={1}
          style={{
            color: colors.foregroundMuted,
            fontSize: 12,
            fontWeight: "500",
            fontVariant: ["tabular-nums"],
          }}
        >
          {triggerText}
        </Text>
        <Icon name="ChevronRight" size={12} color={colors.foregroundMuted} />
      </Pressable>
      <Modal
        title={t("turnUsageTitle")}
        icon={<Icon name="Database" size={16} color={colors.foreground} />}
        open={open}
        onOpenChange={setOpen}
      >
        <Modal.Content>
          <View
            style={{
              gap: turnCost ? 4 : 0,
              paddingBottom: 14,
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
              <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "600" }}>
                {t("turnUsageItem", { turn: turn.turnNumber })}
              </Text>
              <Text
                style={{
                  color: colors.foreground,
                  fontSize: turnCost ? 16 : 15,
                  fontWeight: "600",
                  fontVariant: ["tabular-nums"],
                }}
              >
                {turnCost ? formatUsd(turnCost.totalUsd, "detail") : exactTotalText}
              </Text>
            </View>
            {turnCost && (
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: 12,
                }}
              >
                <Text style={{ color: colors.foregroundMuted, fontSize: 12, flexShrink: 1 }}>
                  {t(turnCost.complete ? "costOfficialHint" : "costPartialHint")}
                </Text>
                <Text
                  style={{
                    color: colors.foregroundMuted,
                    fontSize: 12,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {exactTotalText}
                </Text>
              </View>
            )}
          </View>
          <View style={{ gap: 14 }}>
            <TurnUsageBreakdown turn={turn} theme={theme} />
          </View>
        </Modal.Content>
      </Modal>
    </>
  );
}
