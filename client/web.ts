import {
  averageTtft,
  cachePercent,
  formatDuration,
  formatTokens,
  speed,
  totalTokens,
  type Stats,
} from "../shared/stats";
import type { PluginTheme } from "@getpaseo/plugin";

// Desktop-only adapter. Keep browser globals here so the native entry stays portable.
interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}
interface Element {
  parentElement: Element | null;
  isConnected: boolean;
  textContent: string | null;
  style: Record<string, string>;
  title: string;
  type: string;
  id: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  querySelector(selector: string): Element | null;
  closest(selector: string): Element | null;
  contains(value: unknown): boolean;
  getClientRects(): ArrayLike<unknown>;
  getBoundingClientRect(): Rect;
  append(...elements: Element[]): void;
  replaceChildren(...elements: Element[]): void;
  remove(): void;
  focus(options?: { preventScroll: boolean }): void;
  addEventListener(name: string, listener: () => void): void;
}
interface DocEvent {
  target: unknown;
  key?: string;
  preventDefault(): void;
}
declare const document: {
  body: Element;
  hidden: boolean;
  documentElement: { clientWidth: number; clientHeight: number };
  querySelectorAll(selector: string): ArrayLike<Element>;
  createElement(tag: string): Element;
  createElementNS(namespace: string, tag: string): Element;
  addEventListener(name: string, fn: (event: DocEvent) => void, capture?: boolean): void;
  removeEventListener(name: string, fn: (event: DocEvent) => void, capture?: boolean): void;
};
declare const window: {
  addEventListener(name: string, fn: () => void): void;
  removeEventListener(name: string, fn: () => void): void;
};
declare function getComputedStyle(element: Element): {
  color: string;
  backgroundColor: string;
  fontFamily: string;
};
declare function setInterval(callback: () => void, ms: number): number;
declare function clearInterval(id: number): void;
declare class MutationObserver {
  constructor(callback: () => void);
  observe(target: Element, options: { childList: boolean; subtree: boolean }): void;
  disconnect(): void;
}

export interface FooterCopy {
  counts(turns: number | string, steps: number | string): string;
  cache(percent: string): string;
  loading: string;
  unavailable: string;
  unsupported: string;
  error: string;
  details: string;
  tokenTitle: string;
  uncached: string;
  cacheRead: string;
  cacheWrite: string;
  output: string;
  modelTime: string;
  toolTime: string;
  ttft: string;
  speed: string;
  cacheLabel: string;
  duration?(ms: number | null): string;
}
interface Options {
  isWeb: boolean;
  hasAgent(id: string): boolean;
  read(id: string): Promise<Stats>;
  copy(): FooterCopy;
  peek?(id: string): Stats | undefined;
  theme?(): PluginTheme | null;
  subscribeTheme?(listener: () => void): () => void;
}
type Kind = "activity" | "usage";
interface Reading {
  button: Element;
  label: Element;
  hovered: boolean;
}
interface Footer {
  row: Element;
  activity: Reading;
  usage: Reading;
  root: Element;
  agentId: string;
  busy: boolean;
  stats: Stats | null;
  error: string | null;
}
interface Popup {
  panel: Element;
  footer: Footer;
  anchor: Element;
  kind: Kind;
}
const visible = (element: Element) =>
  element.isConnected &&
  element.getClientRects().length > 0 &&
  !element.closest('[hidden], [aria-hidden="true"], [inert]');
function element(tag: string, text?: string, styles?: Record<string, string>) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (styles) Object.assign(node.style, styles);
  return node;
}
function glyph(kind: Kind) {
  const ns = "http://www.w3.org/2000/svg",
    svg = document.createElementNS(ns, "svg");
  for (const [key, value] of Object.entries({
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.6",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }))
    svg.setAttribute(key, value);
  const paths =
    kind === "activity"
      ? ["M3.3 17a10 10 0 1 1 17.4 0", "m12 13 4-5", "M12 13h.01"]
      : [
          "M20 6c0 2.2-3.6 4-8 4S4 8.2 4 6s3.6-4 8-4 8 1.8 8 4Z",
          "M4 6v12c0 2.2 3.6 4 8 4s8-1.8 8-4V6",
          "M4 12c0 2.2 3.6 4 8 4s8-1.8 8-4",
        ];
  for (const d of paths) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
function colors(root: Element) {
  const input = root.querySelector('textarea, [contenteditable="true"], input');
  const foreground = getComputedStyle(input ?? root).color;
  let parent: Element | null = root;
  while (parent) {
    const background = getComputedStyle(parent).backgroundColor;
    if (background && background !== "transparent" && background !== "rgba(0, 0, 0, 0)")
      return {
        foreground,
        background,
        muted: foreground,
        border: "color-mix(in srgb, currentColor 12%, transparent)",
        selected: "color-mix(in srgb, currentColor 8%, transparent)",
      };
    parent = parent.parentElement;
  }
  return {
    foreground,
    background: "Canvas",
    muted: foreground,
    border: "color-mix(in srgb, currentColor 12%, transparent)",
    selected: "color-mix(in srgb, currentColor 8%, transparent)",
  };
}

export function installFooter(options: Options): () => void {
  if (!options.isWeb || typeof document === "undefined") return () => {};
  const footers = new Map<Element, Footer>();
  let disposed = false,
    popup: Popup | null = null,
    nextId = 0;
  // Reserve the footer in CSS before any session/list/RPC result arrives. The
  // reading is absolutely positioned in that space, so fetching never moves input.
  const reservation = element(
    "style",
    '[data-testid="message-input-root"] { margin-bottom: 28px !important; } div:has(> [data-testid="message-input-root"]) { position: relative; }',
  );
  reservation.setAttribute("data-harness-stats-reservation", "");
  document.body.append(reservation);
  function palette(root: Element) {
    const theme = options.theme?.();
    return theme
      ? {
          foreground: theme.colors.foreground,
          background: theme.colors.surface1,
          muted: theme.colors.foregroundMuted,
          border: theme.colors.border,
          selected: theme.colors.surface2,
        }
      : colors(root);
  }
  function paintButtons(footer: Footer) {
    const theme = palette(footer.root);
    for (const reading of [footer.activity, footer.usage]) {
      const open = popup?.anchor === reading.button;
      const highlighted = open || reading.hovered;
      reading.button.style.background = highlighted ? theme.selected : "transparent";
      reading.button.style.color = highlighted ? theme.foreground : "inherit";
      reading.button.setAttribute("data-state", open ? "open" : "closed");
    }
  }
  function close(restoreFocus = false) {
    if (!popup) return;
    const { panel, anchor, footer } = popup;
    popup = null;
    panel.remove();
    anchor.setAttribute("aria-expanded", "false");
    anchor.removeAttribute("aria-controls");
    paintButtons(footer);
    if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
  }
  function position() {
    if (!popup) return;
    if (!visible(popup.anchor)) {
      close();
      return;
    }
    const { panel, anchor } = popup;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(380, Math.max(0, document.documentElement.clientWidth - 24));
    panel.style.width = `${width}px`;
    const bounds = panel.getBoundingClientRect();
    const left = Math.max(
      12,
      Math.min(rect.left, document.documentElement.clientWidth - width - 12),
    );
    const preferredTop = rect.top - bounds.height - 8;
    const top =
      preferredTop >= 12
        ? preferredTop
        : Math.max(
            12,
            Math.min(rect.bottom + 8, document.documentElement.clientHeight - bounds.height - 12),
          );
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }
  function renderPopup() {
    if (!popup) return;
    const { panel, footer, kind } = popup,
      copy = options.copy(),
      stats = footer.stats;
    const theme = palette(footer.root);
    panel.style.color = theme.foreground;
    panel.style.background = theme.background;
    panel.style.borderColor = theme.border;
    paintButtons(footer);
    const input = footer.root.querySelector('textarea, [contenteditable="true"], input');
    panel.style.fontFamily = getComputedStyle(input ?? footer.root).fontFamily;
    const heading = element("div", undefined, {
      display: "flex",
      alignItems: "center",
      gap: "9px",
      paddingBottom: "16px",
      marginBottom: "15px",
      borderBottom: `1px solid ${theme.border}`,
    });
    const title = element("span", kind === "activity" ? copy.details : copy.tokenTitle, {
      flex: "1",
      fontWeight: "600",
    });
    title.id = `${panel.id}-title`;
    const value =
      stats && !footer.error
        ? kind === "activity"
          ? copy.counts(stats.turns, stats.steps)
          : `${totalTokens(stats).toLocaleString()} tok`
        : "";
    heading.append(
      glyph(kind),
      title,
      element("span", value, { fontWeight: "600", whiteSpace: "nowrap" }),
    );
    panel.setAttribute("aria-labelledby", title.id);
    const body = element("div", undefined, {
      display: "flex",
      flexDirection: "column",
      gap: "14px",
      color: theme.muted,
      fontSize: "13px",
    });
    if (!stats || footer.error) body.append(element("span", footer.error ?? copy.loading));
    else {
      const tps = speed(stats),
        cache = cachePercent(stats),
        ttft = averageTtft(stats);
      const rows =
        kind === "activity"
          ? [
              [copy.modelTime, (copy.duration ?? formatDuration)(stats.modelMs)],
              [copy.toolTime, (copy.duration ?? formatDuration)(stats.toolMs)],
              [copy.ttft, ttft === null ? "—" : (copy.duration ?? formatDuration)(ttft)],
              [copy.speed, tps === null ? "—" : `${Math.round(tps)} tok/s`],
            ]
          : [
              [copy.cacheLabel, cache === null ? "—" : `${cache}%`],
              [
                copy.uncached,
                `${Math.max(0, stats.inputTokens - stats.cachedTokens - stats.cacheWriteTokens).toLocaleString()} tok`,
              ],
              [copy.cacheRead, `${stats.cachedTokens.toLocaleString()} tok`],
              ...(stats.cacheWriteTokens > 0
                ? [[copy.cacheWrite, `${stats.cacheWriteTokens.toLocaleString()} tok`]]
                : []),
              [copy.output, `${stats.outputTokens.toLocaleString()} tok`],
            ];
      for (const [label, reading] of rows) {
        const row = element("div", undefined, {
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: "16px",
        });
        row.append(
          element("span", label),
          element("span", reading, {
            textAlign: "right",
            whiteSpace: "nowrap",
            fontVariantNumeric: "tabular-nums",
          }),
        );
        body.append(row);
      }
    }
    panel.replaceChildren(heading, body);
    position();
  }
  function toggle(footer: Footer, kind: Kind) {
    const anchor = footer[kind].button;
    if (popup?.anchor === anchor) {
      close(true);
      return;
    }
    close();
    const panel = element("div", undefined, {
      position: "fixed",
      zIndex: "10000",
      boxSizing: "border-box",
      borderRadius: "18px",
      padding: "20px",
      border: "1px solid color-mix(in srgb, currentColor 8%, transparent)",
      boxShadow: "0 6px 30px rgb(0 0 0 / 10%)",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      fontSize: "14px",
      lineHeight: "20px",
      maxHeight: "calc(100dvh - 24px)",
      overflowY: "auto",
    });
    panel.id = `harness-stats-popup-${++nextId}`;
    panel.setAttribute("data-harness-stats-popup", kind);
    panel.setAttribute("role", "dialog");
    panel.setAttribute("tabindex", "-1");
    anchor.setAttribute("aria-expanded", "true");
    anchor.setAttribute("aria-controls", panel.id);
    anchor.title = "";
    document.body.append(panel);
    popup = { panel, footer, anchor, kind };
    renderPopup();
    panel.focus({ preventScroll: true });
  }
  function create(root: Element, agentId: string): Footer {
    const row = element("div", undefined, {
      position: "absolute",
      bottom: "0",
      left: "0",
      display: "flex",
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      flexWrap: "nowrap",
      columnGap: "16px",
      width: "100%",
      height: "24px",
      boxSizing: "border-box",
      padding: "0 8px",
      fontSize: "12px",
      lineHeight: "18px",
      fontFamily: "inherit",
      fontVariantNumeric: "tabular-nums",
      flexShrink: "0",
    });
    row.setAttribute("data-harness-stats", agentId);
    row.setAttribute("role", "group");
    const reading = (kind: Kind): Reading => {
      const button = element("button", undefined, {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "7px",
        padding: "3px 6px",
        margin: "0",
        color: "inherit",
        background: "transparent",
        border: "0",
        borderRadius: "7px",
        font: "inherit",
        cursor: "pointer",
        whiteSpace: "nowrap",
        minWidth: "0",
        maxWidth: "65%",
        flexShrink: "1",
        userSelect: "none",
      });
      button.type = "button";
      button.setAttribute("aria-haspopup", "dialog");
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("data-harness-stats-button", kind);
      const label = element("span", undefined, {
        overflow: "hidden",
        textOverflow: "ellipsis",
        minWidth: "0",
      });
      const icon = glyph(kind);
      icon.style.flexShrink = "0";
      button.append(icon, label);
      button.addEventListener("click", () => toggle(footer, kind));
      const reading: Reading = { button, label, hovered: false };
      button.setAttribute("data-state", "closed");
      button.addEventListener("mouseenter", () => {
        reading.hovered = true;
        paintButtons(footer);
      });
      button.addEventListener("mouseleave", () => {
        reading.hovered = false;
        paintButtons(footer);
      });
      return reading;
    };
    const activity = reading("activity"),
      usage = reading("usage");
    const footer: Footer = {
      root,
      row,
      agentId,
      activity,
      usage,
      busy: false,
      stats: null,
      error: null,
    };
    row.append(activity.button, usage.button);
    root.parentElement?.append(row);
    const cached = options.peek?.(agentId);
    if (cached) paint(footer, cached);
    else row.style.visibility = "hidden";
    return footer;
  }
  function paint(footer: Footer, stats: Stats) {
    const copy = options.copy();
    footer.row.style.visibility = "visible";
    footer.row.style.color = palette(footer.root).muted;
    paintButtons(footer);
    footer.stats = stats;
    footer.error = stats.source === "session" ? null : copy[stats.source];
    if (footer.error) {
      footer.activity.label.textContent = footer.error;
      footer.usage.button.style.display = "none";
    } else {
      const tps = speed(stats),
        cache = cachePercent(stats);
      const activity =
        copy.counts(stats.turns, stats.steps) + (tps === null ? "" : ` · ${Math.round(tps)} tok/s`);
      const usage =
        `${formatTokens(totalTokens(stats))} tok` +
        (cache === null ? "" : ` · ${copy.cache(cache)}`);
      if (footer.activity.label.textContent !== activity)
        footer.activity.label.textContent = activity;
      if (footer.usage.label.textContent !== usage) footer.usage.label.textContent = usage;
      if (popup?.anchor !== footer.activity.button) footer.activity.button.title = activity;
      if (popup?.anchor !== footer.usage.button)
        footer.usage.button.title = `${usage}\n${totalTokens(stats).toLocaleString()} tok`;
      footer.usage.button.style.display = "inline-flex";
    }
  }
  async function update(footer: Footer) {
    if (footer.busy) return;
    footer.busy = true;
    const copy = options.copy();
    footer.row.style.color = palette(footer.root).muted;
    footer.row.setAttribute("aria-label", copy.details);
    try {
      const stats = await options.read(footer.agentId);
      if (disposed || !footer.row.isConnected) return;
      paint(footer, stats);
    } catch {
      if (!disposed && footer.row.isConnected) {
        footer.row.style.visibility = "visible";
        footer.error = copy.error;
        footer.activity.label.textContent = copy.error;
        footer.usage.button.style.display = "none";
      }
    } finally {
      footer.busy = false;
      if (popup?.footer === footer) renderPopup();
    }
  }
  function tick(refresh = true) {
    if (disposed || document.hidden) return;
    const active = new Set<Element>();
    for (const root of Array.from(
      document.querySelectorAll('[data-testid="message-input-root"]'),
    )) {
      if (!visible(root)) continue;
      const pane = root.closest('[data-testid^="workspace-pane-"]');
      const tab = pane?.querySelector(
        '[data-testid^="workspace-tab-agent_"][aria-selected="true"]',
      );
      const agentId = tab?.getAttribute("data-testid")?.slice("workspace-tab-agent_".length);
      if (!agentId || !options.hasAgent(agentId)) continue;
      active.add(root);
      let footer = footers.get(root);
      if (footer && (footer.agentId !== agentId || !footer.row.isConnected)) {
        if (popup?.footer === footer) close();
        footer.row.remove();
        footers.delete(root);
        footer = undefined;
      }
      const created = !footer;
      if (!footer) {
        footer = create(root, agentId);
        footers.set(root, footer);
      }
      if (refresh || created) void update(footer);
    }
    for (const [root, footer] of footers)
      if (!active.has(root)) {
        if (popup?.footer === footer) close();
        footer.row.remove();
        footers.delete(root);
      }
  }
  const outside = (event: DocEvent) => {
    if (popup && !popup.panel.contains(event.target) && !popup.anchor.contains(event.target))
      close();
  };
  const keydown = (event: DocEvent) => {
    if (event.key === "Escape" && popup) {
      event.preventDefault();
      close(true);
    }
  };
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", keydown);
  document.addEventListener("scroll", position, true);
  window.addEventListener("resize", position);
  const observer = new MutationObserver(() => tick(false));
  observer.observe(document.body, { childList: true, subtree: true });
  const timer = setInterval(() => tick(), 2000);
  tick();
  const removeTheme = options.subscribeTheme?.(() => {
    for (const footer of footers.values()) {
      footer.row.style.color = palette(footer.root).muted;
      paintButtons(footer);
    }
    renderPopup();
  });
  return () => {
    disposed = true;
    clearInterval(timer);
    observer.disconnect();
    removeTheme?.();
    close();
    reservation.remove();
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", keydown);
    document.removeEventListener("scroll", position, true);
    window.removeEventListener("resize", position);
    for (const footer of footers.values()) footer.row.remove();
    footers.clear();
  };
}
