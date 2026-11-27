import { useSettings, useTranslation } from "@getpaseo/plugin/client";
import {
  SettingsCard,
  SettingsRow,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { preferences, type HarnessPreferences } from "../shared/preferences";
import { messages } from "./messages";

export function HarnessSettings() {
  const settings = useSettings(preferences);
  const { t } = useTranslation(messages);
  function save(patch: Partial<HarnessPreferences>) {
    if (settings.status !== "ready" || settings.saving) return;
    const values = { ...settings.values, ...patch };
    void settings.save(values, settings.revision);
  }
  return (
    <SettingsCard>
      {settings.status === "ready" ? (
        <>
          <SettingsSwitch
            label={t("settingsEnabled")}
            hint={t("settingsEnabledHint")}
            value={settings.values.enabled}
            disabled={settings.saving}
            onValueChange={(value) => save({ enabled: value })}
            testID="harness-stats-enabled"
          />
          <SettingsSwitch
            label={t("settingsTurnUsageEnabled")}
            hint={t("settingsTurnUsageEnabledHint")}
            value={settings.values.turnUsageEnabled}
            disabled={settings.saving}
            onValueChange={(value) => save({ turnUsageEnabled: value })}
            testID="harness-stats-turn-usage-enabled"
          />
          <SettingsSelect
            label={t("settingsMobilePlacement")}
            hint={t("settingsMobilePlacementHint")}
            value={settings.values.mobilePlacement}
            disabled={settings.saving}
            options={[
              { value: "footer", label: t("settingsFooter") },
              { value: "track", label: t("settingsTrack") },
            ]}
            onValueChange={(value) => save({ mobilePlacement: value })}
            testID="harness-stats-mobile-placement"
          />
        </>
      ) : (
        <SettingsRow
          label={settings.status === "loading" ? t("loading") : t("unavailable")}
          error={settings.status === "loading" ? undefined : settings.error}
        />
      )}
      {settings.saveError ? (
        <SettingsRow label={t("settingsUnsaved")} error={settings.saveError} />
      ) : null}
    </SettingsCard>
  );
}
