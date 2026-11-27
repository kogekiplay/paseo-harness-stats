import type { HarnessPreferences } from "../shared/preferences";

let current: HarnessPreferences = {
  enabled: true,
  turnUsageEnabled: true,
  mobilePlacement: "footer",
};
const listeners = new Set<(value: HarnessPreferences) => void>();

export function getPreferences() {
  return current;
}
export function setPreferences(value: HarnessPreferences) {
  if (
    current.enabled === value.enabled &&
    current.turnUsageEnabled === value.turnUsageEnabled &&
    current.mobilePlacement === value.mobilePlacement
  )
    return;
  current = value;
  for (const listener of listeners) listener(value);
}
export function subscribePreferences(listener: (value: HarnessPreferences) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
