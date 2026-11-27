import { formatRatePerMillion, formatUsd } from "../shared/pricing";
import {
  averageTtft,
  cachePercent,
  formatDuration,
  formatExactTokens,
  formatTokens,
  speed,
  totalTokens,
  turnCachePercent,
  type CostBreakdown,
  type Stats,
  type TurnUsage,
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
  firstElementChild: Element | null;
  nextElementSibling: Element | null;
  isConnected: boolean;
  textContent: string | null;
  style: Record<string, string>;
  title: string;
  type: string;
  id: string;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  querySelector(selector: string): Element | null;
  querySelectorAll(selector: string): ArrayLike<Element>;
  closest(selector: string): Element | null;
  contains(value: unknown): boolean;
  getClientRects(): ArrayLike<unknown>;
  getBoundingClientRect(): Rect;
  append(...elements: Element[]): void;
  insertBefore(node: Element, child: Element | null): Element;
  replaceChildren(...elements: Element[]): void;
  remove(): void;
  focus(options?: { preventScroll: boolean }): void;
  addEventListener(name: string, listener: (event: DocEvent) => void): void;
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
  display?: string;
};
declare function setInterval(callback: () => void, ms: number): number;
declare function clearInterval(id: number): void;
declare class MutationObserver {
  constructor(callback: () => void);
  observe(target: Element, options: { childList: boolean; subtree: boolean }): void;
  disconnect(): void;
  takeRecords?(): unknown[];
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
  turnTitle?: string;
  turnConsumed?(total: string): string;
  turnModel?: string;
  turnCacheHit?: string;
  turnInput?: string;
  turnCacheRead?: string;
  turnCacheWrite?: string;
  turnOutput?: string;
  turnReasoning?(tokens: string): string;
  costOfficialHint?: string;
  costPartialHint?: string;
}
interface Options {
  isWeb: boolean;
  showFooter?: boolean;
  showTurnUsage?: boolean;
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
interface TurnButtonEntry {
  footerEl: Element;
  button: Element;
  label: Element;
  turn: TurnUsage;
  hovered: boolean;
}
interface Footer {
  row: Element | null;
  activity: Reading | null;
  usage: Reading | null;
  root: Element;
  pane: Element | null;
  agentId: string;
  turnButtons: Map<Element, TurnButtonEntry>;
  busy: boolean;
  stats: Stats | null;
  error: string | null;
}
type Popup =
  | {
      panel: Element;
      footer: Footer;
      anchor: Element;
      kind: Kind;
    }
  | {
      panel: Element;
      footer: Footer;
      anchor: Element;
      kind: "turn-usage";
      entry: TurnButtonEntry;
    };

function hasDisplayNone(element: Element, stopAt?: Element | null): boolean {
  if (typeof getComputedStyle !== "function") return false;
  let cur: Element | null = element;
  while (cur) {
    if (getComputedStyle(cur)?.display === "none") return true;
    if (cur === stopAt || cur === document.body) break;
    cur = cur.parentElement;
  }
  return false;
}

function isElementVisible(element: Element, stopAt?: Element | null): boolean {
  return (
    element.isConnected &&
    element.getClientRects().length > 0 &&
    !element.closest('[hidden], [aria-hidden="true"], [inert]') &&
    !hasDisplayNone(element, stopAt)
  );
}

const visible = (element: Element) => isElementVisible(element);

function findChatContainer(root: Element, pane: Element | null): Element | null {
  const ancestors: Element[] = [];
  let node: Element | null = root.parentElement;
  while (node) {
    ancestors.push(node);
    if (node === pane || node === document.body) break;
    node = node.parentElement;
  }
  if (pane && !ancestors.includes(pane)) {
    ancestors.push(pane);
  }
  for (const ancestor of ancestors) {
    const scroll = Array.from(
      ancestor.querySelectorAll('[data-testid="agent-chat-scroll"]'),
    ).find((el) => isElementVisible(el, pane));
    if (scroll) return scroll;
  }
  for (const ancestor of ancestors) {
    const turnFooter = Array.from(
      ancestor.querySelectorAll('[data-testid="turn-footer"]'),
    ).find((el) => isElementVisible(el, pane));
    if (turnFooter) return ancestor;
  }
  return pane;
}

function element(tag: string, text?: string, styles?: Record<string, string>) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (styles) Object.assign(node.style, styles);
  return node;
}

function glyph(kind: Kind, size = 16) {
  const ns = "http://www.w3.org/2000/svg",
    svg = document.createElementNS(ns, "svg");
  for (const [key, value] of Object.entries({
    width: String(size),
    height: String(size),
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

function baseMessageId(id: string): string {
  const index = id.indexOf(":segment:");
  return index >= 0 ? id.slice(0, index) : id;
}

function isWorkingFooter(footerEl: Element): boolean {
  return Boolean(
    footerEl.querySelector(
      '[data-testid="turn-working-indicator"], [data-testid="turn-working-elapsed"]',
    ),
  );
}

interface RowRef {
  rowId: string | null;
  messageId: string | null;
}

interface FooterCandidate {
  el: Element;
  rowId: string | null;
  messageId: string | null;
  fallbackRows: RowRef[];
  isAuxiliary: boolean;
  isVirtualized: boolean;
}

function isUserHistoryRow(row: Element): boolean {
  const rowId = row.getAttribute("data-history-row-id");
  if (rowId && rowId.startsWith("user_")) return true;
  return (
    row.getAttribute("data-testid") === "user-message" ||
    row.querySelector('[data-testid="user-message"]') !== null
  );
}

function candidateRowRefs(candidate: FooterCandidate): RowRef[] {
  if (!candidate.isAuxiliary) {
    return candidate.rowId || candidate.messageId
      ? [{ rowId: candidate.rowId, messageId: candidate.messageId }]
      : [];
  }
  return candidate.fallbackRows;
}

function collectRowIds(row: RowRef): string[] {
  const ids: string[] = [];
  if (row.rowId) {
    ids.push(row.rowId);
    const base = baseMessageId(row.rowId);
    if (base !== row.rowId) ids.push(base);
  }
  if (row.messageId) {
    ids.push(row.messageId);
    const base = baseMessageId(row.messageId);
    if (base !== row.messageId) ids.push(base);
  }
  return ids;
}

function matchTurnsToFooters(
  container: Element,
  turns: TurnUsage[],
  previousMatched?: Map<Element, TurnUsage>,
): { matched: Map<Element, TurnUsage>; working: Element[] } {
  const matched = new Map<Element, TurnUsage>();
  const working: Element[] = [];
  const candidates: FooterCandidate[] = [];
  let recentRows: Element[] = [];
  const nodes = Array.from(
    container.querySelectorAll('[data-history-row-id], [data-testid="turn-footer"]'),
  );
  for (const el of nodes) {
    if (hasDisplayNone(el, container)) continue;
    if (el.getAttribute("data-testid") === "turn-footer") {
      if (isWorkingFooter(el)) {
        working.push(el);
        recentRows = [];
        continue;
      }
      const row = el.closest("[data-history-row-id]");
      const isAuxiliary = !row;
      const fallbackRows: RowRef[] = [];
      if (isAuxiliary) {
        for (let r = recentRows.length - 1; r >= 0; r--) {
          const recent = recentRows[r];
          if (isUserHistoryRow(recent)) continue;
          fallbackRows.push({
            rowId: recent.getAttribute("data-history-row-id"),
            messageId: recent.getAttribute("data-message-id"),
          });
        }
      }
      candidates.push({
        el,
        rowId: row?.getAttribute("data-history-row-id") ?? null,
        messageId: row?.getAttribute("data-message-id") ?? null,
        fallbackRows,
        isAuxiliary,
        isVirtualized: Boolean(row?.hasAttribute("data-index")),
      });
      recentRows = [];
    } else if (el.hasAttribute("data-history-row-id")) {
      recentRows.push(el);
    }
  }
  if (candidates.length === 0 || turns.length === 0) return { matched, working };

  const assigned = new Map<number, number>();
  const usedTurns = new Set<number>();

  // Pass 1: exact ID matching (rowId / messageId, with and without :segment: suffix)
  const turnIdSets = turns.map((turn) => {
    const ids = new Set<string>();
    for (const id of turn.messageIds) {
      ids.add(id);
      ids.add(baseMessageId(id));
    }
    return ids;
  });
  for (let i = 0; i < candidates.length; i++) {
    const rows = candidateRowRefs(candidates[i]);
    for (const row of rows) {
      const candidateIds = collectRowIds(row);
      if (candidateIds.length === 0) continue;
      let hit = false;
      for (let tIdx = 0; tIdx < turns.length; tIdx++) {
        if (usedTurns.has(tIdx)) continue;
        const idSet = turnIdSets[tIdx];
        if (candidateIds.some((id) => idSet.has(id))) {
          assigned.set(i, tIdx);
          usedTurns.add(tIdx);
          hit = true;
          break;
        }
      }
      if (hit) break;
    }
  }

  // Pass 2: timestamp matching for assistant_<ts>_ / tool_<ts>_ row IDs (monotonic)
  for (let i = 0; i < candidates.length; i++) {
    if (assigned.has(i)) continue;
    const rows = candidateRowRefs(candidates[i]);
    if (rows.length === 0) continue;

    let tBefore = -1;
    for (let j = 0; j < i; j++) {
      const matchedBefore = assigned.get(j);
      if (matchedBefore !== undefined && matchedBefore > tBefore) tBefore = matchedBefore;
    }
    let tAfter = turns.length;
    for (let k = i + 1; k < candidates.length; k++) {
      const matchedAfter = assigned.get(k);
      if (matchedAfter !== undefined && matchedAfter < tAfter) tAfter = matchedAfter;
    }
    if (tBefore + 1 >= tAfter) continue;

    for (const row of rows) {
      const rowId = row.rowId;
      if (!rowId) continue;
      const m = /^(?:assistant|tool)_(\d+)_/.exec(rowId);
      if (!m) continue;
      const ts = Number(m[1]);
      if (!Number.isFinite(ts)) continue;

      let bestInWindow = -1;
      let bestInWindowDist = Infinity;
      let bestNear = -1;
      let bestNearDist = Infinity;
      for (let tIdx = tBefore + 1; tIdx < tAfter; tIdx++) {
        if (usedTurns.has(tIdx)) continue;
        const turn = turns[tIdx];
        if (
          turn.startedAtMs !== null &&
          turn.completedAtMs !== null &&
          ts >= turn.startedAtMs - 5_000 &&
          ts <= turn.completedAtMs + 5_000
        ) {
          const dist = Math.abs(ts - turn.completedAtMs);
          if (dist < bestInWindowDist) {
            bestInWindowDist = dist;
            bestInWindow = tIdx;
          }
        }
        if (turn.completedAtMs !== null) {
          const dist = Math.abs(ts - turn.completedAtMs);
          if (dist <= 30_000 && dist < bestNearDist) {
            bestNearDist = dist;
            bestNear = tIdx;
          }
        }
      }
      const chosen = bestInWindow >= 0 ? bestInWindow : bestNear;
      if (chosen >= 0) {
        assigned.set(i, chosen);
        usedTurns.add(chosen);
        break;
      }
    }
  }

  const hasVirtualization = Array.from(container.querySelectorAll("[data-index]")).some(
    (el) => !hasDisplayNone(el, container),
  );

  // Pass 3 / 4: unified trailing alignment (idle) and working-turn protection
  if (working.length === 0) {
    let turnCursor = turns.length - 1;
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (candidates[i].isVirtualized) break;
      const existing = assigned.get(i);
      if (existing !== undefined) {
        turnCursor = Math.min(turnCursor, existing - 1);
        continue;
      }
      let minAllowed = -1;
      for (let j = 0; j < i; j++) {
        const matchedBefore = assigned.get(j);
        if (matchedBefore !== undefined && matchedBefore > minAllowed) minAllowed = matchedBefore;
      }
      while (turnCursor > minAllowed && usedTurns.has(turnCursor)) turnCursor--;
      if (turnCursor <= minAllowed) break;
      assigned.set(i, turnCursor);
      usedTurns.add(turnCursor);
      turnCursor--;
    }
  } else {
    if (previousMatched && previousMatched.size > 0) {
      const turnIndexByNumber = new Map<number, number>();
      for (let tIdx = 0; tIdx < turns.length; tIdx++) {
        turnIndexByNumber.set(turns[tIdx].turnNumber, tIdx);
      }
      for (let i = 0; i < candidates.length; i++) {
        if (assigned.has(i)) continue;
        const prevTurn = previousMatched.get(candidates[i].el);
        if (!prevTurn) continue;
        const tIdx = turnIndexByNumber.get(prevTurn.turnNumber);
        if (tIdx === undefined || usedTurns.has(tIdx)) continue;
        let tBefore = -1;
        for (let j = 0; j < i; j++) {
          const matchedBefore = assigned.get(j);
          if (matchedBefore !== undefined && matchedBefore > tBefore) tBefore = matchedBefore;
        }
        let tAfter = turns.length;
        for (let k = i + 1; k < candidates.length; k++) {
          const matchedAfter = assigned.get(k);
          if (matchedAfter !== undefined && matchedAfter < tAfter) tAfter = matchedAfter;
        }
        if (tIdx <= tBefore || tIdx >= tAfter) continue;
        assigned.set(i, tIdx);
        usedTurns.add(tIdx);
      }
    }

    if (!hasVirtualization) {
      const unmatchedCandidates: number[] = [];
      for (let i = 0; i < candidates.length; i++) {
        if (!assigned.has(i)) unmatchedCandidates.push(i);
      }
      const unmatchedTurns: number[] = [];
      for (let tIdx = 0; tIdx < turns.length; tIdx++) {
        if (!usedTurns.has(tIdx)) unmatchedTurns.push(tIdx);
      }
      if (
        unmatchedCandidates.length > 0 &&
        unmatchedCandidates.every((idx) => !candidates[idx].isVirtualized) &&
        (unmatchedCandidates.length === unmatchedTurns.length ||
          unmatchedCandidates.length === unmatchedTurns.length - 1)
      ) {
        const provisional = new Map(assigned);
        for (let k = 0; k < unmatchedCandidates.length; k++) {
          provisional.set(unmatchedCandidates[k], unmatchedTurns[k]);
        }
        let monotonic = true;
        let prevTurnIdx = -1;
        for (let i = 0; i < candidates.length; i++) {
          const tIdx = provisional.get(i);
          if (tIdx === undefined) continue;
          if (tIdx <= prevTurnIdx) {
            monotonic = false;
            break;
          }
          prevTurnIdx = tIdx;
        }
        if (monotonic) {
          for (let k = 0; k < unmatchedCandidates.length; k++) {
            assigned.set(unmatchedCandidates[k], unmatchedTurns[k]);
            usedTurns.add(unmatchedTurns[k]);
          }
        }
      }
    }
  }

  for (const [candidateIndex, turnIndex] of assigned) {
    matched.set(candidates[candidateIndex].el, turns[turnIndex]);
  }
  return { matched, working };
}

function mountTurnButton(footerEl: Element, button: Element) {
  const timingLabel = footerEl.querySelector('[data-testid="turn-footer-timing-label"]');
  const labelButton = timingLabel?.parentElement ?? null;
  const container = labelButton?.parentElement ?? null;
  if (labelButton && container && footerEl.contains(container)) {
    if (button.parentElement !== container || button.nextElementSibling !== labelButton) {
      container.insertBefore(button, labelButton);
    }
    return;
  }
  const anchor =
    footerEl.querySelector('[data-testid="assistant-fork-menu"]') ??
    footerEl.querySelector('[data-testid="turn-metrics-trigger"]') ??
    footerEl.querySelector(
      'button:not([data-harness-turn-usage-button]), [role="button"]:not([data-harness-turn-usage-button])',
    );
  const actionHost = anchor?.parentElement ?? null;
  if (actionHost && footerEl.contains(actionHost)) {
    if (button.parentElement !== actionHost) actionHost.append(button);
    return;
  }
  const fallback =
    footerEl.firstElementChild?.firstElementChild ?? footerEl.firstElementChild ?? footerEl;
  if (button.parentElement !== fallback) fallback.append(button);
}

export function installFooter(options: Options): () => void {
  const showFooter = options.showFooter ?? true;
  const showTurnUsage = options.showTurnUsage ?? true;
  if (!options.isWeb || (!showFooter && !showTurnUsage) || typeof document === "undefined")
    return () => {};
  const footers = new Map<Element, Footer>();
  let disposed = false,
    mutating = false,
    popup: Popup | null = null,
    nextId = 0;
  let observer: MutationObserver | null = null;

  function withMutationGuard<T>(fn: () => T): T {
    const nested = mutating;
    mutating = true;
    try {
      return fn();
    } finally {
      if (!nested) {
        observer?.takeRecords?.();
        mutating = false;
      }
    }
  }

  // Reserve the footer in CSS before any session/list/RPC result arrives. The
  // reading is absolutely positioned in that space, so fetching never moves input.
  let reservation: Element | null = null;
  if (showFooter) {
    reservation = element(
      "style",
      '[data-testid="message-input-root"] { margin-bottom: 28px !important; } div:has(> [data-testid="message-input-root"]) { position: relative; }',
    );
    reservation.setAttribute("data-harness-stats-reservation", "");
    document.body.append(reservation);
  }
  let turnUsageStyle: Element | null = null;
  if (showTurnUsage) {
    turnUsageStyle = element(
      "style",
      "@media (max-width: 480px) { [data-harness-turn-usage-button] { width: 24px !important; padding: 0 !important; justify-content: center !important; } [data-harness-turn-usage-button] [data-harness-turn-usage-label] { display: none !important; } }",
    );
    turnUsageStyle.setAttribute("data-harness-turn-usage-style", "");
    document.body.append(turnUsageStyle);
  }

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
    if (!footer.activity || !footer.usage) return;
    const theme = palette(footer.root);
    for (const reading of [footer.activity, footer.usage]) {
      const open = popup?.anchor === reading.button;
      const highlighted = open || reading.hovered;
      reading.button.style.background = highlighted ? theme.selected : "transparent";
      reading.button.style.color = highlighted ? theme.foreground : "inherit";
      reading.button.setAttribute("data-state", open ? "open" : "closed");
    }
  }
  function formatTurnConsumed(copy: FooterCopy, turn: TurnUsage) {
    const total = `${formatTokens(turn.totalTokens)} tok`;
    return copy.turnConsumed ? copy.turnConsumed(total) : `Usage ${total}`;
  }
  function formatCostHint(copy: FooterCopy, complete: boolean) {
    return complete
      ? (copy.costOfficialHint ?? "Official API pricing")
      : (copy.costPartialHint ?? "Official API pricing (partial)");
  }
  function formatSessionUsage(copy: FooterCopy, stats: Stats) {
    const cache = cachePercent(stats);
    const label =
      `${formatTokens(totalTokens(stats))} tok` +
      (cache === null ? "" : ` · ${copy.cache(cache)}`) +
      (stats.cost ? ` · ${formatUsd(stats.cost.totalUsd, "compact")}` : "");
    const detail =
      `${totalTokens(stats).toLocaleString()} tok` +
      (stats.cost ? ` · ${formatUsd(stats.cost.totalUsd, "detail")}` : "");
    return { label, title: `${label}\n${detail}` };
  }
  function paintTurnButton(footer: Footer, entry: TurnButtonEntry) {
    const theme = palette(footer.root);
    const copy = options.copy();
    const baseTriggerText = formatTurnConsumed(copy, entry.turn);
    const triggerText = entry.turn.cost
      ? `${baseTriggerText} · ${formatUsd(entry.turn.cost.totalUsd, "compact")}`
      : baseTriggerText;
    const open = popup?.anchor === entry.button;
    const highlighted = open || entry.hovered;
    const turnAttr = String(entry.turn.turnNumber);
    if (entry.button.getAttribute("data-harness-turn-usage-button") !== turnAttr) {
      entry.button.setAttribute("data-harness-turn-usage-button", turnAttr);
    }
    if (entry.label.textContent !== triggerText) entry.label.textContent = triggerText;
    if (entry.button.getAttribute("aria-label") !== triggerText) {
      entry.button.setAttribute("aria-label", triggerText);
    }
    const nextTitle = open
      ? ""
      : entry.turn.cost
        ? `${triggerText}\n${formatExactTokens(entry.turn.totalTokens)} tok · ${formatUsd(entry.turn.cost.totalUsd, "detail")}`
        : `${triggerText}\n${formatExactTokens(entry.turn.totalTokens)} tok`;
    if (entry.button.title !== nextTitle) entry.button.title = nextTitle;
    entry.button.style.background = highlighted ? theme.selected : "transparent";
    entry.button.style.color = highlighted ? theme.foreground : theme.muted;
    entry.button.setAttribute("data-state", open ? "open" : "closed");
  }
  function close(restoreFocus = false) {
    if (!popup) return;
    const current = popup;
    popup = null;
    withMutationGuard(() => {
      current.panel.remove();
      current.anchor.setAttribute("aria-expanded", "false");
      current.anchor.removeAttribute("aria-controls");
      if (current.kind === "turn-usage") {
        paintTurnButton(current.footer, current.entry);
      } else {
        paintButtons(current.footer);
        if (current.footer.stats && !current.footer.error) {
          const copy = options.copy();
          const stats = current.footer.stats;
          if (current.kind === "activity" && current.footer.activity) {
            const tps = speed(stats);
            current.footer.activity.button.title =
              copy.counts(stats.turns, stats.steps) +
              (tps === null ? "" : ` · ${Math.round(tps)} tok/s`);
          } else if (current.kind === "usage" && current.footer.usage) {
            current.footer.usage.button.title = formatSessionUsage(copy, stats).title;
          }
        }
      }
    });
    if (restoreFocus && current.anchor.isConnected) current.anchor.focus({ preventScroll: true });
  }
  function position() {
    if (!popup) return;
    if (!visible(popup.anchor)) {
      close();
      return;
    }
    const { panel, anchor, kind } = popup;
    const rect = anchor.getBoundingClientRect();
    const maxWidth = kind === "turn-usage" ? 400 : 380;
    const width = Math.min(maxWidth, Math.max(0, document.documentElement.clientWidth - 24));
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
    const current = popup;
    withMutationGuard(() => {
      const { panel, footer } = current,
        copy = options.copy();
      const theme = palette(footer.root);
      panel.style.color = theme.foreground;
      panel.style.background = theme.background;
      panel.style.borderColor = theme.border;
      const input = footer.root.querySelector('textarea, [contenteditable="true"], input');
      panel.style.fontFamily = getComputedStyle(input ?? footer.root).fontFamily;

      const buildCostHeading = (
        titleText: string,
        cost: CostBreakdown,
        exactTotalText: string,
      ) => {
        const heading = element("div", undefined, {
          display: "flex",
          flexDirection: "column",
          gap: "4px",
          paddingBottom: "16px",
          marginBottom: "15px",
          borderBottom: `1px solid ${theme.border}`,
        });
        const topRow = element("div", undefined, {
          display: "flex",
          alignItems: "center",
          gap: "9px",
        });
        const title = element("span", titleText, {
          flex: "1",
          fontWeight: "600",
        });
        title.id = `${panel.id}-title`;
        topRow.append(
          glyph("usage", 16),
          title,
          element("span", formatUsd(cost.totalUsd, "detail"), {
            fontWeight: "600",
            whiteSpace: "nowrap",
            fontVariantNumeric: "tabular-nums",
            color: theme.foreground,
          }),
        );
        const subRow = element("div", undefined, {
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "12px",
          fontSize: "12px",
          color: theme.muted,
        });
        subRow.append(
          element("span", formatCostHint(copy, cost.complete)),
          element("span", exactTotalText, {
            whiteSpace: "nowrap",
            fontVariantNumeric: "tabular-nums",
          }),
        );
        heading.append(topRow, subRow);
        panel.setAttribute("aria-labelledby", title.id);
        return heading;
      };

      const buildCostRow = (
        label: string,
        usd: number,
        tokensEl: Element,
        rate?: number,
      ) => {
        const row = element("div", undefined, {
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "16px",
        });
        const left = element("div", undefined, {
          display: "flex",
          flexDirection: "column",
          gap: "2px",
          flexShrink: "0",
        });
        left.append(element("span", label));
        if (rate !== undefined) {
          left.append(
            element("span", formatRatePerMillion(rate), {
              fontSize: "11px",
              opacity: "0.78",
              fontVariantNumeric: "tabular-nums",
            }),
          );
        }
        const right = element("div", undefined, {
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: "2px",
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
          minWidth: "0",
        });
        right.append(
          element("span", formatUsd(usd, "detail"), {
            color: theme.foreground,
            fontWeight: "500",
            whiteSpace: "nowrap",
          }),
          tokensEl,
        );
        row.append(left, right);
        return row;
      };

      if (current.kind === "turn-usage") {
        paintTurnButton(footer, current.entry);
        const turn = current.entry.turn;
        const turnCost = turn.cost;
        let heading: Element;
        if (turnCost) {
          heading = buildCostHeading(
            copy.turnTitle ?? "Turn usage",
            turnCost,
            `${formatExactTokens(turn.totalTokens)} tok`,
          );
        } else {
          heading = element("div", undefined, {
            display: "flex",
            alignItems: "center",
            gap: "9px",
            paddingBottom: "16px",
            marginBottom: "15px",
            borderBottom: `1px solid ${theme.border}`,
          });
          const title = element("span", copy.turnTitle ?? "Turn usage", {
            flex: "1",
            fontWeight: "600",
          });
          title.id = `${panel.id}-title`;
          heading.append(
            glyph("usage", 16),
            title,
            element("span", `${formatExactTokens(turn.totalTokens)} tok`, {
              fontWeight: "600",
              whiteSpace: "nowrap",
              fontVariantNumeric: "tabular-nums",
            }),
          );
          panel.setAttribute("aria-labelledby", title.id);
        }
        const body = element("div", undefined, {
          display: "flex",
          flexDirection: "column",
          gap: "14px",
          color: theme.muted,
          fontSize: "13px",
        });
        const appendRow = (
          label: string,
          valueEl: Element,
        ) => {
          const row = element("div", undefined, {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: "16px",
          });
          row.append(element("span", label, { flexShrink: "0" }), valueEl);
          body.append(row);
        };
        if (turn.routes.length > 0) {
          appendRow(
            copy.turnModel ?? "Provider / model",
            element(
              "span",
              turn.routes.map((route) => `${route.provider}/${route.model}`).join(", "),
              {
                textAlign: "right",
                overflowWrap: "anywhere",
                minWidth: "0",
                color: theme.foreground,
              },
            ),
          );
        }
        const hit = turnCachePercent(turn);
        if (hit !== null) {
          appendRow(
            copy.turnCacheHit ?? copy.cacheLabel,
            element("span", `${hit}%`, {
              textAlign: "right",
              whiteSpace: "nowrap",
              fontVariantNumeric: "tabular-nums",
              color: theme.foreground,
            }),
          );
        }
        if (turnCost) {
          const tokenSub = (text: string) =>
            element("span", text, {
              fontSize: "12px",
              color: theme.muted,
              whiteSpace: "nowrap",
            });
          body.append(
            buildCostRow(
              copy.turnInput ?? copy.uncached,
              turnCost.uncachedInputUsd,
              tokenSub(`${formatExactTokens(turn.uncachedInputTokens)} tok`),
              turnCost.ratesPerMillion?.uncachedInput,
            ),
          );
          if (turn.cachedTokens !== undefined) {
            body.append(
              buildCostRow(
                copy.turnCacheRead ?? copy.cacheRead,
                turnCost.cachedInputUsd,
                tokenSub(`${formatExactTokens(turn.cachedTokens)} tok`),
                turnCost.ratesPerMillion?.cachedInput,
              ),
            );
          }
          if (turn.cacheWriteTokens !== undefined && turn.cacheWriteTokens > 0) {
            body.append(
              buildCostRow(
                copy.turnCacheWrite ?? copy.cacheWrite,
                turnCost.cacheWriteUsd,
                tokenSub(`${formatExactTokens(turn.cacheWriteTokens)} tok`),
                turnCost.ratesPerMillion?.cacheWrite,
              ),
            );
          }
          const outputTokensEl = element("span", undefined, {
            fontSize: "12px",
            color: theme.muted,
            textAlign: "right",
            fontVariantNumeric: "tabular-nums",
          });
          outputTokensEl.append(
            element("span", `${formatExactTokens(turn.outputTokens)} tok`, {
              whiteSpace: "nowrap",
            }),
          );
          if (turn.reasoningTokens !== undefined && turn.reasoningTokens > 0) {
            const reasoningText = (
              copy.turnReasoning ?? ((tokens: string) => ` (${tokens} reasoning)`)
            )(`${formatExactTokens(turn.reasoningTokens)} tok`);
            outputTokensEl.append(
              element("span", reasoningText, {
                color: theme.muted,
                opacity: "0.78",
                whiteSpace: "nowrap",
              }),
            );
          }
          body.append(
            buildCostRow(
              copy.turnOutput ?? copy.output,
              turnCost.outputUsd,
              outputTokensEl,
              turnCost.ratesPerMillion?.output,
            ),
          );
        } else {
          appendRow(
            copy.turnInput ?? copy.uncached,
            element("span", `${formatExactTokens(turn.uncachedInputTokens)} tok`, {
              textAlign: "right",
              whiteSpace: "nowrap",
              fontVariantNumeric: "tabular-nums",
              color: theme.foreground,
            }),
          );
          if (turn.cachedTokens !== undefined) {
            appendRow(
              copy.turnCacheRead ?? copy.cacheRead,
              element("span", `${formatExactTokens(turn.cachedTokens)} tok`, {
                textAlign: "right",
                whiteSpace: "nowrap",
                fontVariantNumeric: "tabular-nums",
                color: theme.foreground,
              }),
            );
          }
          if (turn.cacheWriteTokens !== undefined && turn.cacheWriteTokens > 0) {
            appendRow(
              copy.turnCacheWrite ?? copy.cacheWrite,
              element("span", `${formatExactTokens(turn.cacheWriteTokens)} tok`, {
                textAlign: "right",
                whiteSpace: "nowrap",
                fontVariantNumeric: "tabular-nums",
                color: theme.foreground,
              }),
            );
          }
          const outputValue = element("span", undefined, {
            textAlign: "right",
            fontVariantNumeric: "tabular-nums",
            color: theme.foreground,
          });
          outputValue.append(
            element("span", `${formatExactTokens(turn.outputTokens)} tok`, {
              whiteSpace: "nowrap",
            }),
          );
          if (turn.reasoningTokens !== undefined && turn.reasoningTokens > 0) {
            const reasoningText = (
              copy.turnReasoning ?? ((tokens: string) => ` (${tokens} reasoning)`)
            )(`${formatExactTokens(turn.reasoningTokens)} tok`);
            outputValue.append(
              element("span", reasoningText, {
                color: theme.muted,
                whiteSpace: "nowrap",
              }),
            );
          }
          appendRow(copy.turnOutput ?? copy.output, outputValue);
        }
        panel.replaceChildren(heading, body);
        position();
        return;
      }

      const { kind } = current,
        stats = footer.stats;
      paintButtons(footer);
      const usageCost = kind === "usage" && stats && !footer.error ? stats.cost : undefined;
      let heading: Element;
      if (usageCost && stats) {
        heading = buildCostHeading(
          copy.tokenTitle,
          usageCost,
          `${formatExactTokens(totalTokens(stats))} tok`,
        );
      } else {
        heading = element("div", undefined, {
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
      }
      const body = element("div", undefined, {
        display: "flex",
        flexDirection: "column",
        gap: "14px",
        color: theme.muted,
        fontSize: "13px",
      });
      if (!stats || footer.error) body.append(element("span", footer.error ?? copy.loading));
      else if (usageCost) {
        const cache = cachePercent(stats);
        const uncachedTokens = Math.max(
          0,
          stats.inputTokens - stats.cachedTokens - stats.cacheWriteTokens,
        );
        const cacheRow = element("div", undefined, {
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: "16px",
        });
        cacheRow.append(
          element("span", copy.cacheLabel),
          element("span", cache === null ? "—" : `${cache}%`, {
            textAlign: "right",
            whiteSpace: "nowrap",
            fontVariantNumeric: "tabular-nums",
            color: theme.foreground,
          }),
        );
        body.append(cacheRow);
        const tokenSub = (text: string) =>
          element("span", text, {
            fontSize: "12px",
            color: theme.muted,
            whiteSpace: "nowrap",
          });
        body.append(
          buildCostRow(
            copy.uncached,
            usageCost.uncachedInputUsd,
            tokenSub(`${formatExactTokens(uncachedTokens)} tok`),
            usageCost.ratesPerMillion?.uncachedInput,
          ),
          buildCostRow(
            copy.cacheRead,
            usageCost.cachedInputUsd,
            tokenSub(`${formatExactTokens(stats.cachedTokens)} tok`),
            usageCost.ratesPerMillion?.cachedInput,
          ),
        );
        if (stats.cacheWriteTokens > 0) {
          body.append(
            buildCostRow(
              copy.cacheWrite,
              usageCost.cacheWriteUsd,
              tokenSub(`${formatExactTokens(stats.cacheWriteTokens)} tok`),
              usageCost.ratesPerMillion?.cacheWrite,
            ),
          );
        }
        body.append(
          buildCostRow(
            copy.output,
            usageCost.outputUsd,
            tokenSub(`${formatExactTokens(stats.outputTokens)} tok`),
            usageCost.ratesPerMillion?.output,
          ),
        );
      } else {
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
    });
  }
  function createPopupPanel(kind: Popup["kind"], anchor: Element) {
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
    return panel;
  }
  function toggle(footer: Footer, kind: Kind) {
    const target = footer[kind];
    if (!target) return;
    const anchor = target.button;
    if (popup?.anchor === anchor) {
      close(true);
      return;
    }
    close();
    const panel = withMutationGuard(() => createPopupPanel(kind, anchor));
    popup = { panel, footer, anchor, kind };
    renderPopup();
    panel.focus({ preventScroll: true });
  }
  function toggleTurnUsage(footer: Footer, entry: TurnButtonEntry) {
    const anchor = entry.button;
    if (popup?.anchor === anchor) {
      close(true);
      return;
    }
    close();
    const panel = withMutationGuard(() => createPopupPanel("turn-usage", anchor));
    popup = { panel, footer, anchor, kind: "turn-usage", entry };
    renderPopup();
    panel.focus({ preventScroll: true });
  }
  function createTurnButton(footer: Footer, footerEl: Element, turn: TurnUsage): TurnButtonEntry {
    const button = element("button", undefined, {
      display: "inline-flex",
      alignItems: "center",
      gap: "5px",
      height: "24px",
      padding: "0 6px",
      margin: "0",
      border: "0",
      borderRadius: "6px",
      background: "transparent",
      color: palette(footer.root).muted,
      fontSize: "12px",
      lineHeight: "18px",
      fontFamily: "inherit",
      fontVariantNumeric: "tabular-nums",
      whiteSpace: "nowrap",
      flexShrink: "0",
      cursor: "pointer",
      userSelect: "none",
    });
    button.type = "button";
    button.setAttribute("data-harness-turn-usage-button", String(turn.turnNumber));
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("data-state", "closed");
    const icon = glyph("usage", 14);
    icon.style.flexShrink = "0";
    const label = element("span");
    label.setAttribute("data-harness-turn-usage-label", "");
    button.append(icon, label);
    const entry: TurnButtonEntry = {
      footerEl,
      button,
      label,
      turn,
      hovered: false,
    };
    button.addEventListener("click", () => toggleTurnUsage(footer, entry));
    button.addEventListener("mouseenter", () => {
      entry.hovered = true;
      paintTurnButton(footer, entry);
    });
    button.addEventListener("mouseleave", () => {
      entry.hovered = false;
      paintTurnButton(footer, entry);
    });
    return entry;
  }
  function syncTurnUsage(footer: Footer) {
    if (!showTurnUsage) return;
    withMutationGuard(() => {
      const container = findChatContainer(footer.root, footer.pane);
      const stats = footer.stats;
      const turns =
        stats && stats.source === "session"
          ? stats.turnUsages.filter((turn) => turn.totalTokens > 0)
          : [];
      if (!container || turns.length === 0) {
        for (const entry of footer.turnButtons.values()) {
          if (popup?.kind === "turn-usage" && popup.entry === entry) close();
          entry.button.remove();
        }
        footer.turnButtons.clear();
        return;
      }

      const previousMatched = new Map<Element, TurnUsage>();
      for (const [footerEl, entry] of footer.turnButtons) {
        previousMatched.set(footerEl, entry.turn);
      }
      const { matched, working } = matchTurnsToFooters(container, turns, previousMatched);

      for (const workingEl of working) {
        const stale = footer.turnButtons.get(workingEl);
        if (stale) {
          if (popup?.kind === "turn-usage" && popup.entry === stale) close();
          stale.button.remove();
          footer.turnButtons.delete(workingEl);
        }
        const stray = workingEl.querySelector("[data-harness-turn-usage-button]");
        if (stray) stray.remove();
      }

      for (const [footerEl, entry] of footer.turnButtons) {
        if (!matched.has(footerEl) || !footerEl.isConnected) {
          if (popup?.kind === "turn-usage" && popup.entry === entry) close();
          entry.button.remove();
          footer.turnButtons.delete(footerEl);
        }
      }

      for (const [footerEl, turn] of matched) {
        let entry = footer.turnButtons.get(footerEl);
        if (!entry) {
          entry = createTurnButton(footer, footerEl, turn);
          footer.turnButtons.set(footerEl, entry);
        } else {
          entry.turn = turn;
        }
        mountTurnButton(footerEl, entry.button);
        paintTurnButton(footer, entry);
      }
    });
  }
  function create(root: Element, pane: Element | null, agentId: string): Footer {
    let row: Element | null = null;
    let activity: Reading | null = null;
    let usage: Reading | null = null;
    const footer: Footer = {
      root,
      pane,
      row: null,
      agentId,
      activity: null,
      usage: null,
      turnButtons: new Map(),
      busy: false,
      stats: null,
      error: null,
    };
    if (showFooter) {
      withMutationGuard(() => {
        row = element("div", undefined, {
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
          const readingObj: Reading = { button, label, hovered: false };
          button.setAttribute("data-state", "closed");
          button.addEventListener("mouseenter", () => {
            readingObj.hovered = true;
            paintButtons(footer);
          });
          button.addEventListener("mouseleave", () => {
            readingObj.hovered = false;
            paintButtons(footer);
          });
          return readingObj;
        };
        activity = reading("activity");
        usage = reading("usage");
        footer.row = row;
        footer.activity = activity;
        footer.usage = usage;
        row.append(activity.button, usage.button);
        root.parentElement?.append(row);
      });
    }
    const cached = options.peek?.(agentId);
    if (cached) paint(footer, cached);
    else if (footer.row) footer.row.style.visibility = "hidden";
    return footer;
  }
  function paint(footer: Footer, stats: Stats) {
    const copy = options.copy();
    footer.stats = stats;
    footer.error = stats.source === "session" ? null : copy[stats.source];
    if (footer.row && footer.activity && footer.usage) {
      withMutationGuard(() => {
        if (!footer.row || !footer.activity || !footer.usage) return;
        footer.row.style.visibility = "visible";
        footer.row.style.color = palette(footer.root).muted;
        paintButtons(footer);
        if (footer.error) {
          footer.activity.label.textContent = footer.error;
          footer.usage.button.style.display = "none";
        } else {
          const tps = speed(stats);
          const activity =
            copy.counts(stats.turns, stats.steps) +
            (tps === null ? "" : ` · ${Math.round(tps)} tok/s`);
          const sessionUsage = formatSessionUsage(copy, stats);
          if (footer.activity.label.textContent !== activity)
            footer.activity.label.textContent = activity;
          if (footer.usage.label.textContent !== sessionUsage.label)
            footer.usage.label.textContent = sessionUsage.label;
          if (popup?.anchor !== footer.activity.button) footer.activity.button.title = activity;
          if (popup?.anchor !== footer.usage.button)
            footer.usage.button.title = sessionUsage.title;
          footer.usage.button.style.display = "inline-flex";
        }
      });
    }
    syncTurnUsage(footer);
  }
  function removeFooterState(root: Element, footer: Footer) {
    if (popup?.footer === footer) close();
    withMutationGuard(() => {
      footer.row?.remove();
      for (const entry of footer.turnButtons.values()) entry.button.remove();
      footer.turnButtons.clear();
    });
    footers.delete(root);
  }
  async function update(footer: Footer) {
    if (footer.busy) return;
    footer.busy = true;
    const copy = options.copy();
    if (footer.row) {
      footer.row.style.color = palette(footer.root).muted;
      footer.row.setAttribute("aria-label", copy.details);
    }
    try {
      const stats = await options.read(footer.agentId);
      if (disposed || !footer.root.isConnected || (footer.row && !footer.row.isConnected)) return;
      paint(footer, stats);
    } catch {
      if (!disposed && footer.root.isConnected && (!footer.row || footer.row.isConnected)) {
        footer.error = copy.error;
        if (footer.row && footer.activity && footer.usage) {
          footer.row.style.visibility = "visible";
          footer.activity.label.textContent = copy.error;
          footer.usage.button.style.display = "none";
        }
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
      if (
        footer &&
        (footer.agentId !== agentId ||
          footer.pane !== pane ||
          (showFooter && footer.row && !footer.row.isConnected))
      ) {
        removeFooterState(root, footer);
        footer = undefined;
      }
      const created = !footer;
      if (!footer) {
        footer = create(root, pane, agentId);
        footers.set(root, footer);
      }
      if (refresh || created) void update(footer);
      else if (showTurnUsage && footer.stats) syncTurnUsage(footer);
    }
    for (const [root, footer] of footers)
      if (!active.has(root)) removeFooterState(root, footer);
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
  document.addEventListener("click", outside, true);
  document.addEventListener("keydown", keydown);
  document.addEventListener("scroll", position, true);
  window.addEventListener("resize", position);
  observer = new MutationObserver(() => {
    if (disposed || mutating) return;
    tick(false);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const timer = setInterval(() => tick(), 2000);
  tick();
  const removeTheme = options.subscribeTheme?.(() => {
    withMutationGuard(() => {
      for (const footer of footers.values()) {
        if (footer.row) {
          footer.row.style.color = palette(footer.root).muted;
          paintButtons(footer);
        }
        for (const entry of footer.turnButtons.values()) paintTurnButton(footer, entry);
      }
    });
    renderPopup();
  });
  return () => {
    disposed = true;
    clearInterval(timer);
    observer?.disconnect();
    removeTheme?.();
    close();
    reservation?.remove();
    turnUsageStyle?.remove();
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("click", outside, true);
    document.removeEventListener("keydown", keydown);
    document.removeEventListener("scroll", position, true);
    window.removeEventListener("resize", position);
    for (const footer of footers.values()) {
      footer.row?.remove();
      for (const entry of footer.turnButtons.values()) entry.button.remove();
      footer.turnButtons.clear();
    }
    footers.clear();
  };
}
