import { useSettings, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useLayoutEffect } from "react";
import { publishTheme } from "./theme-state";
import { preferences } from "../shared/preferences";
import { setPreferences } from "./preferences";

/** Receives the active host palette through a public surface; renders no sidebar row. */
export function ThemeBridge({ theme }: PluginSidebarItemProps) {
  const settings = useSettings(preferences);
  const values = settings.status === "ready" ? settings.values : null;
  useLayoutEffect(() => {
    publishTheme(theme);
  }, [theme]);
  useLayoutEffect(() => {
    if (values) setPreferences(values);
  }, [values]);
  return null;
}
