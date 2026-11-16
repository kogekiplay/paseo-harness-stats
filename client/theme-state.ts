import type { PluginTheme } from "@getpaseo/plugin";

let current: PluginTheme | null = null;
const listeners = new Set<() => void>();
export const getTheme = () => current;
export function publishTheme(theme: PluginTheme) {
  current = theme;
  for (const listener of listeners) listener();
}
export function subscribeTheme(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
