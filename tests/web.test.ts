import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installFooter, type FooterCopy } from "../client/web";
import { emptyStats, type CostBreakdown, type TurnUsage } from "../shared/stats";
import { getPreferences, setPreferences, subscribePreferences } from "../client/preferences";
import type { PluginTheme } from "@getpaseo/plugin";

const copy: FooterCopy = {
  counts: (turns, steps) => `${turns} 轮 ${steps} 步`,
  cache: (percent) => `缓存命中 ${percent}%`,
  loading: "读取中",
  unavailable: "记录暂不可用",
  unsupported: "不支持",
  error: "读取失败",
  details: "会话统计",
  tokenTitle: "Token 用量",
  uncached: "未缓存输入",
  cacheRead: "缓存读取",
  cacheWrite: "缓存写入",
  output: "输出",
  modelTime: "模型用时",
  toolTime: "工具调用用时",
  ttft: "首 token 平均（TTFT）",
  speed: "输出速度（TPS）",
  cacheLabel: "缓存命中",
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(width = 1200, dark = false) {
  const dom = new JSDOM(
    `<body><div data-testid="workspace-pane-main"><button data-testid="workspace-tab-agent_agent-1" aria-selected="true">Agent</button><div><div data-testid="message-input-root"><textarea></textarea></div></div></div><button id="outside">Outside</button></body>`,
    { pretendToBeVisual: true },
  );
  const win = dom.window,
    doc = win.document;
  const original = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: win,
    document: doc,
    MutationObserver: win.MutationObserver,
    getComputedStyle: win.getComputedStyle.bind(win),
  })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.defineProperty(doc.documentElement, "clientWidth", { value: width });
  Object.defineProperty(doc.documentElement, "clientHeight", { value: 800 });
  Object.defineProperty(win.HTMLElement.prototype, "getClientRects", {
    value() {
      return [this.getBoundingClientRect()];
    },
  });
  Object.defineProperty(win.HTMLElement.prototype, "getBoundingClientRect", {
    value() {
      return this.hasAttribute("data-harness-stats-popup")
        ? { left: 0, top: 0, bottom: 250, right: 380, width: 380, height: 250 }
        : { left: width - 240, right: width - 40, top: 740, bottom: 765, width: 200, height: 25 };
    },
  });
  const root = doc.querySelector('[data-testid="message-input-root"]')!;
  root.setAttribute("style", `background: ${dark ? "rgb(30, 30, 30)" : "rgb(250, 250, 250)"}`);
  root.querySelector("textarea")!.style.color = dark ? "rgb(240, 240, 240)" : "rgb(20, 20, 20)";
  const stats = {
    ...emptyStats("codex"),
    turns: 5,
    steps: 66,
    inputTokens: 4306458,
    cachedTokens: 2908364,
    outputTokens: 50399,
    modelMs: 1247000,
    toolMs: 246000,
    timedOutputTokens: 50399,
  };
  let fail = false;
  const dispose = installFooter({
    isWeb: true,
    hasAgent: (id) => id === "agent-1",
    read: async () => {
      if (fail) throw Error("offline");
      return { ...stats };
    },
    copy: () => copy,
  });
  await flush();
  return {
    doc,
    win,
    stats,
    fail: () => {
      fail = true;
    },
    dispose,
    cleanup() {
      dispose();
      win.close();
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("Two independent anchored dialogs toggle in place, close outside and on Escape, and clean up", async () => {
  const f = await fixture();
  try {
    const activity = f.doc.querySelector<HTMLButtonElement>(
      '[data-harness-stats-button="activity"]',
    )!;
    const usage = f.doc.querySelector<HTMLButtonElement>('[data-harness-stats-button="usage"]')!;
    assert.match(activity.textContent!, /5 轮 66 步/);
    activity.click();
    let popup = f.doc.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.equal(popup.dataset.harnessStatsPopup, "activity");
    assert.match(popup.textContent!, /工具调用用时4m 6s/);
    assert.match(popup.textContent!, /TTFT）—/);
    assert.equal(activity.getAttribute("aria-expanded"), "true");
    assert.ok(parseFloat(popup.style.top) < 740);
    usage.click();
    assert.equal(f.doc.querySelectorAll('[role="dialog"]').length, 1);
    popup = f.doc.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.equal(popup.dataset.harnessStatsPopup, "usage");
    assert.match(popup.textContent!, /Token 用量4,356,857 tok/);
    assert.match(popup.textContent!, /未缓存输入1,398,094 tok/);
    assert.equal(activity.getAttribute("aria-expanded"), "false");
    f.doc.dispatchEvent(new f.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(f.doc.querySelector('[role="dialog"]'), null);
    assert.equal(f.doc.activeElement, usage);
    usage.click();
    usage.click();
    assert.equal(f.doc.querySelector('[role="dialog"]'), null);
    activity.click();
    f.doc
      .querySelector("#outside")!
      .dispatchEvent(new f.win.Event("pointerdown", { bubbles: true }));
    assert.equal(f.doc.querySelector('[role="dialog"]'), null);
    activity.click();
    f.dispose();
    assert.equal(f.doc.querySelector("[data-harness-stats]"), null);
    assert.equal(f.doc.querySelector('[role="dialog"]'), null);
  } finally {
    f.cleanup();
  }
});

for (const dark of [false, true])
  test(`Compact ${dark ? "dark" : "light"} popup fits the viewport and uses the composer palette`, async () => {
    const f = await fixture(320, dark);
    try {
      f.doc.querySelector<HTMLButtonElement>('[data-harness-stats-button="activity"]')!.click();
      const popup = f.doc.querySelector<HTMLElement>('[role="dialog"]')!;
      assert.equal(popup.style.width, "296px");
      assert.equal(popup.style.left, "12px");
      assert.equal(popup.style.backgroundColor, dark ? "rgb(30, 30, 30)" : "rgb(250, 250, 250)");
      assert.equal(popup.style.color, dark ? "rgb(240, 240, 240)" : "rgb(20, 20, 20)");
      assert.equal(
        f.doc.querySelector<HTMLElement>("[data-harness-stats]")!.style.flexWrap,
        "nowrap",
      );
    } finally {
      f.cleanup();
    }
  });

test("Native clients never touch browser globals", () => {
  assert.doesNotThrow(() =>
    installFooter({
      isWeb: false,
      hasAgent: () => false,
      read: async () => emptyStats("codex"),
      copy: () => copy,
    })(),
  );
});

test("The footer reserves constant height before RPC completion and never pushes the input on load", async () => {
  const f = await fixture();
  let cleanup = () => {};
  try {
    f.dispose();
    let finish: (value: typeof f.stats) => void = () => {};
    const pending = new Promise<typeof f.stats>((resolve) => {
      finish = resolve;
    });
    cleanup = installFooter({
      isWeb: true,
      hasAgent: () => true,
      read: () => pending,
      copy: () => copy,
    });
    const root = f.doc.querySelector<HTMLElement>('[data-testid="message-input-root"]')!;
    const row = f.doc.querySelector<HTMLElement>("[data-harness-stats]")!;
    assert.equal(f.win.getComputedStyle(root).marginBottom, "28px");
    assert.equal(row.style.position, "absolute");
    assert.equal(row.style.height, "24px");
    assert.equal(row.style.visibility, "hidden");
    assert.equal(row.textContent, "");
    assert.equal(row.querySelectorAll("button").length, 2);
    finish(f.stats);
    await flush();
    assert.match(row.textContent!, /5 轮 66 步/);
    assert.equal(row.style.visibility, "visible");
    assert.equal(f.win.getComputedStyle(root).marginBottom, "28px");
    assert.equal(row.style.position, "absolute");
    assert.equal(row.style.height, "24px");
    cleanup();
    assert.equal(f.doc.querySelector("[data-harness-stats-reservation]"), null);
  } finally {
    cleanup();
    f.cleanup();
  }
});

test("Host theme tokens override the input's colors and an open popup follows theme changes immediately", async () => {
  const f = await fixture();
  let cleanup = () => {},
    changed = () => {};
  const theme = (surface: string, foreground: string, muted: string): PluginTheme => ({
    colors: {
      surface0: surface,
      surface1: surface,
      surface2: "rgb(40, 80, 60)",
      foreground,
      foregroundMuted: muted,
      border: "rgb(60, 100, 80)",
      accent: "green",
      accentForeground: "white",
      statusSuccess: "green",
      statusWarning: "yellow",
      statusDanger: "red",
    },
  });
  let active = theme("rgb(20, 50, 30)", "rgb(240, 250, 240)", "rgb(180, 200, 180)");
  try {
    f.dispose();
    cleanup = installFooter({
      isWeb: true,
      hasAgent: () => true,
      read: async () => f.stats,
      copy: () => copy,
      theme: () => active,
      subscribeTheme: (listener) => {
        changed = listener;
        return () => {
          changed = () => {};
        };
      },
    });
    await flush();
    f.doc.querySelector<HTMLButtonElement>('[data-harness-stats-button="activity"]')!.click();
    const popup = f.doc.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.equal(popup.style.backgroundColor, active.colors.surface1);
    assert.equal(popup.style.color, active.colors.foreground);
    assert.equal(popup.style.borderColor, active.colors.border);
    active = theme("rgb(250, 245, 230)", "rgb(40, 30, 10)", "rgb(110, 100, 80)");
    changed();
    assert.equal(popup.style.backgroundColor, active.colors.surface1);
    assert.equal(popup.style.color, active.colors.foreground);
    assert.equal(
      f.doc.querySelector<HTMLElement>("[data-harness-stats]")!.style.color,
      active.colors.foregroundMuted,
    );
  } finally {
    cleanup();
    f.cleanup();
  }
});

test("Cached readings render synchronously on workspace remount without placeholders", async () => {
  const f = await fixture();
  let cleanup = () => {};
  try {
    f.dispose();
    cleanup = installFooter({
      isWeb: true,
      hasAgent: () => true,
      read: () => new Promise(() => {}),
      peek: () => f.stats,
      copy: () => copy,
    });
    const row = f.doc.querySelector<HTMLElement>("[data-harness-stats]")!;
    assert.equal(row.style.visibility, "visible");
    assert.match(row.textContent!, /5 轮 66 步/);
    assert.match(row.textContent!, /4.4M tok/);
    assert.doesNotMatch(row.textContent!, /读取中|— 轮/);
  } finally {
    cleanup();
    f.cleanup();
  }
});

test("Hover, keyboard focus and an open popup use the selected theme surface", async () => {
  const f = await fixture();
  let cleanup = () => {};
  try {
    f.dispose();
    const palette: PluginTheme = {
      colors: {
        surface0: "white",
        surface1: "white",
        surface2: "rgb(230, 235, 240)",
        foreground: "rgb(20, 30, 40)",
        foregroundMuted: "gray",
        border: "gray",
        accent: "blue",
        accentForeground: "white",
        statusSuccess: "green",
        statusWarning: "yellow",
        statusDanger: "red",
      },
    };
    cleanup = installFooter({
      isWeb: true,
      hasAgent: () => true,
      read: async () => f.stats,
      copy: () => copy,
      theme: () => palette,
    });
    await flush();
    const button = f.doc.querySelector<HTMLButtonElement>(
      '[data-harness-stats-button="activity"]',
    )!;
    button.dispatchEvent(new f.win.Event("mouseenter"));
    assert.equal(button.style.backgroundColor, palette.colors.surface2);
    button.dispatchEvent(new f.win.Event("mouseleave"));
    assert.equal(button.style.backgroundColor, "transparent");
    button.click();
    assert.equal(button.getAttribute("data-state"), "open");
    button.dispatchEvent(new f.win.Event("mouseleave"));
    assert.equal(button.style.backgroundColor, palette.colors.surface2);
    button.click();
    assert.equal(button.getAttribute("data-state"), "closed");
    button.blur();
    assert.equal(button.style.backgroundColor, "transparent");
  } finally {
    cleanup();
    f.cleanup();
  }
});

test("Closing the same reading twice clears the selected capsule even when the button keeps focus", async () => {
  const f = await fixture();
  try {
    const button = f.doc.querySelector<HTMLButtonElement>(
      '[data-harness-stats-button="activity"]',
    )!;
    button.click();
    assert.notEqual(button.style.backgroundColor, "transparent");
    button.click();
    assert.equal(button.getAttribute("data-state"), "closed");
    assert.equal(button.style.backgroundColor, "transparent");
  } finally {
    f.cleanup();
  }
});

const fullCopy: FooterCopy = {
  ...copy,
  turnTitle: "本轮用量",
  turnConsumed: (total) => `用量 ${total}`,
  turnModel: "提供方 / 模型",
  turnCacheHit: "缓存命中",
  turnInput: "未缓存输入",
  turnCacheRead: "缓存读取",
  turnCacheWrite: "缓存写入",
  turnOutput: "输出",
  turnReasoning: (tokens) => `（其中推理 ${tokens}）`,
  costOfficialHint: "按官方 API 标准定价",
  costPartialHint: "按官方 API 定价（不含未定价模型）",
};

function makeTurn(overrides: Partial<TurnUsage> & { turnNumber: number }): TurnUsage {
  return {
    messageIds: [],
    startedAtMs: null,
    completedAtMs: null,
    routes: [],
    steps: 1,
    inputTokens: 1000,
    uncachedInputTokens: 1000,
    outputTokens: 100,
    totalTokens: 1100,
    ...overrides,
  };
}

function renderTurnFooterHtml(options?: {
  rowId?: string;
  messageId?: string;
  dataIndex?: number;
  working?: "indicator" | "elapsed";
  timing?: string | null;
}) {
  const timing =
    options?.timing === null
      ? ""
      : `<button type="button"><span data-testid="turn-footer-timing-label">${options?.timing ?? "Worked for 12s"}</span></button>`;
  const workingHtml =
    options?.working === "indicator"
      ? `<span data-testid="turn-working-indicator">Working</span>`
      : options?.working === "elapsed"
        ? `<span data-testid="turn-working-elapsed">3s</span>`
        : "";
  const footer = `<div data-testid="turn-footer"><div><div data-role="container"><div data-role="actions"><button type="button" data-testid="copy-btn">Copy</button><div data-testid="assistant-fork-menu"><button type="button">Fork</button></div></div>${workingHtml}${timing}</div></div></div>`;
  if (!options?.rowId) return `<div data-role="auxiliary">${footer}</div>`;
  const attrs = [
    `data-history-row-id="${options.rowId}"`,
    options.messageId ? `data-message-id="${options.messageId}"` : "",
    options.dataIndex !== undefined ? `data-index="${options.dataIndex}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<div ${attrs}>${footer}</div>`;
}

async function turnFixture(options: {
  chatHtml: string;
  turnUsages: TurnUsage[];
  cost?: CostBreakdown;
  showFooter?: boolean;
  showTurnUsage?: boolean;
  theme?: () => PluginTheme | null;
  subscribeTheme?: (listener: () => void) => () => void;
}) {
  const dom = new JSDOM(
    `<body><div data-testid="workspace-pane-main"><button data-testid="workspace-tab-agent_agent-1" aria-selected="true">Agent</button><div data-testid="agent-chat-scroll">${options.chatHtml}</div><div><div data-testid="message-input-root"><textarea></textarea></div></div></div><button id="outside">Outside</button></body>`,
    { pretendToBeVisual: true },
  );
  const win = dom.window,
    doc = win.document;
  const original = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: win,
    document: doc,
    MutationObserver: win.MutationObserver,
    getComputedStyle: win.getComputedStyle.bind(win),
  })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.defineProperty(doc.documentElement, "clientWidth", { value: 1200 });
  Object.defineProperty(doc.documentElement, "clientHeight", { value: 800 });
  Object.defineProperty(win.HTMLElement.prototype, "getClientRects", {
    value() {
      return [this.getBoundingClientRect()];
    },
  });
  Object.defineProperty(win.HTMLElement.prototype, "getBoundingClientRect", {
    value() {
      return this.hasAttribute("data-harness-stats-popup")
        ? { left: 0, top: 0, bottom: 250, right: 400, width: 400, height: 250 }
        : { left: 200, right: 360, top: 600, bottom: 624, width: 160, height: 24 };
    },
  });
  const root = doc.querySelector('[data-testid="message-input-root"]')!;
  root.setAttribute("style", "background: rgb(250, 250, 250)");
  root.querySelector("textarea")!.style.color = "rgb(20, 20, 20)";
  const stats = {
    ...emptyStats("codex"),
    turns: options.turnUsages.length,
    steps: options.turnUsages.reduce((sum, t) => sum + t.steps, 0),
    inputTokens: options.turnUsages.reduce((sum, t) => sum + t.inputTokens, 0),
    cachedTokens: options.turnUsages.reduce((sum, t) => sum + (t.cachedTokens ?? 0), 0),
    cacheWriteTokens: options.turnUsages.reduce((sum, t) => sum + (t.cacheWriteTokens ?? 0), 0),
    outputTokens: options.turnUsages.reduce((sum, t) => sum + t.outputTokens, 0),
    turnUsages: options.turnUsages,
    ...(options.cost ? { cost: options.cost } : {}),
  };
  const dispose = installFooter({
    isWeb: true,
    showFooter: options.showFooter,
    showTurnUsage: options.showTurnUsage,
    hasAgent: (id) => id === "agent-1",
    read: async () => ({ ...stats, turnUsages: [...stats.turnUsages] }),
    copy: () => fullCopy,
    theme: options.theme,
    subscribeTheme: options.subscribeTheme,
  });
  await flush();
  return {
    doc,
    win,
    stats,
    dispose,
    cleanup() {
      dispose();
      win.close();
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("Per-turn button injects after Copy/Fork and before timing label, and skips working turns", async () => {
  const f = await turnFixture({
    chatHtml:
      renderTurnFooterHtml({ rowId: "msg-1", messageId: "msg-1", timing: "Worked for 12s" }) +
      renderTurnFooterHtml({ rowId: "msg-2", messageId: "msg-2", working: "indicator" }) +
      renderTurnFooterHtml({ rowId: "msg-3", messageId: "msg-3", working: "elapsed" }),
    turnUsages: [
      makeTurn({
        turnNumber: 1,
        messageIds: ["msg-1"],
        inputTokens: 15000,
        uncachedInputTokens: 3000,
        cachedTokens: 12000,
        outputTokens: 811,
        totalTokens: 15811,
      }),
    ],
  });
  try {
    const buttons = f.doc.querySelectorAll<HTMLButtonElement>("[data-harness-turn-usage-button]");
    assert.equal(buttons.length, 1);
    const button = buttons[0];
    assert.equal(button.getAttribute("data-harness-turn-usage-button"), "1");
    assert.equal(button.textContent, "用量 15.8K tok");
    assert.equal(button.getAttribute("aria-label"), "用量 15.8K tok");
    assert.equal(button.title, "用量 15.8K tok\n15,811 tok");
    assert.equal(button.querySelector("svg")?.getAttribute("width"), "14");
    assert.ok(button.querySelector("[data-harness-turn-usage-label]"));

    const container = f.doc.querySelector('[data-history-row-id="msg-1"] [data-role="container"]')!;
    const children = Array.from(container.children);
    assert.equal(children[0].getAttribute("data-role"), "actions");
    assert.equal(children[1], button);
    assert.ok(children[2].querySelector('[data-testid="turn-footer-timing-label"]'));

    assert.equal(
      f.doc.querySelector('[data-history-row-id="msg-2"] [data-harness-turn-usage-button]'),
      null,
    );
    assert.equal(
      f.doc.querySelector('[data-history-row-id="msg-3"] [data-harness-turn-usage-button]'),
      null,
    );
  } finally {
    f.cleanup();
  }
});

test("Turn usage popup displays full DSH breakdown, exact cache rounding, and omits absent optional fields", async () => {
  const f = await turnFixture({
    chatHtml:
      renderTurnFooterHtml({ rowId: "m1", messageId: "m1" }) +
      renderTurnFooterHtml({ rowId: "m2", messageId: "m2" }) +
      renderTurnFooterHtml({ rowId: "m3", messageId: "m3" }),
    turnUsages: [
      makeTurn({
        turnNumber: 1,
        messageIds: ["m1"],
        routes: [
          { provider: "openai", model: "gpt-5.4" },
          { provider: "anthropic", model: "claude-sonnet-4" },
        ],
        inputTokens: 10000,
        uncachedInputTokens: 1,
        cachedTokens: 9999,
        cacheWriteTokens: 250,
        outputTokens: 811,
        reasoningTokens: 42,
        totalTokens: 15811,
      }),
      makeTurn({
        turnNumber: 2,
        messageIds: ["m2"],
        routes: [],
        inputTokens: 500,
        uncachedInputTokens: 500,
        cachedTokens: undefined,
        cacheWriteTokens: 0,
        outputTokens: 120,
        reasoningTokens: 0,
        totalTokens: 620,
      }),
      makeTurn({
        turnNumber: 3,
        messageIds: ["m3"],
        inputTokens: 1000,
        uncachedInputTokens: 166,
        cachedTokens: 834,
        outputTokens: 200,
        totalTokens: 1200,
      }),
    ],
  });
  try {
    const turn1Btn = f.doc.querySelector<HTMLButtonElement>(
      '[data-harness-turn-usage-button="1"]',
    )!;
    turn1Btn.click();
    let popup = f.doc.querySelector<HTMLElement>('[data-harness-stats-popup="turn-usage"]')!;
    assert.ok(popup);
    assert.equal(turn1Btn.title, "");
    assert.equal(turn1Btn.getAttribute("aria-expanded"), "true");
    assert.match(popup.textContent!, /本轮用量15,811 tok/);
    assert.match(popup.textContent!, /提供方 \/ 模型openai\/gpt-5\.4, anthropic\/claude-sonnet-4/);
    assert.match(popup.textContent!, /缓存命中99\.99%/);
    assert.doesNotMatch(popup.textContent!, /缓存命中100%/);
    assert.match(popup.textContent!, /未缓存输入1 tok/);
    assert.match(popup.textContent!, /缓存读取9,999 tok/);
    assert.match(popup.textContent!, /缓存写入250 tok/);
    assert.match(popup.textContent!, /输出811 tok（其中推理 42 tok）/);

    const turn2Btn = f.doc.querySelector<HTMLButtonElement>(
      '[data-harness-turn-usage-button="2"]',
    )!;
    turn2Btn.click();
    assert.equal(f.doc.querySelectorAll('[role="dialog"]').length, 1);
    popup = f.doc.querySelector<HTMLElement>('[data-harness-stats-popup="turn-usage"]')!;
    assert.match(popup.textContent!, /本轮用量620 tok/);
    assert.doesNotMatch(popup.textContent!, /提供方 \/ 模型/);
    assert.doesNotMatch(popup.textContent!, /缓存命中/);
    assert.match(popup.textContent!, /未缓存输入500 tok/);
    assert.doesNotMatch(popup.textContent!, /缓存读取/);
    assert.doesNotMatch(popup.textContent!, /缓存写入/);
    assert.match(popup.textContent!, /输出120 tok/);
    assert.doesNotMatch(popup.textContent!, /其中推理/);

    const turn3Btn = f.doc.querySelector<HTMLButtonElement>(
      '[data-harness-turn-usage-button="3"]',
    )!;
    turn3Btn.click();
    popup = f.doc.querySelector<HTMLElement>('[data-harness-stats-popup="turn-usage"]')!;
    assert.match(popup.textContent!, /缓存命中83\.4%/);
  } finally {
    f.cleanup();
  }
});

test("Turn usage popup and footer popups are mutually exclusive and close cleanly without lingering highlight", async () => {
  const f = await turnFixture({
    chatHtml: renderTurnFooterHtml({ rowId: "m1", messageId: "m1" }),
    turnUsages: [makeTurn({ turnNumber: 1, messageIds: ["m1"], totalTokens: 2500 })],
  });
  try {
    const footerActivity = f.doc.querySelector<HTMLButtonElement>(
      '[data-harness-stats-button="activity"]',
    )!;
    const turnBtn = f.doc.querySelector<HTMLButtonElement>(
      '[data-harness-turn-usage-button="1"]',
    )!;

    // Footer -> Turn usage mutual exclusion
    footerActivity.click();
    assert.equal(
      f.doc.querySelector<HTMLElement>('[role="dialog"]')?.dataset.harnessStatsPopup,
      "activity",
    );
    turnBtn.click();
    assert.equal(f.doc.querySelectorAll('[role="dialog"]').length, 1);
    assert.equal(
      f.doc.querySelector<HTMLElement>('[role="dialog"]')?.dataset.harnessStatsPopup,
      "turn-usage",
    );
    assert.equal(footerActivity.getAttribute("aria-expanded"), "false");
    assert.equal(turnBtn.getAttribute("data-state"), "open");

    // Turn usage -> Footer mutual exclusion
    footerActivity.click();
    assert.equal(f.doc.querySelectorAll('[role="dialog"]').length, 1);
    assert.equal(
      f.doc.querySelector<HTMLElement>('[role="dialog"]')?.dataset.harnessStatsPopup,
      "activity",
    );
    assert.equal(turnBtn.getAttribute("aria-expanded"), "false");
    assert.equal(turnBtn.getAttribute("data-state"), "closed");
    assert.equal(turnBtn.style.backgroundColor, "transparent");

    // Toggle same turn button twice clears highlight capsule
    turnBtn.click();
    assert.notEqual(turnBtn.style.backgroundColor, "transparent");
    turnBtn.click();
    assert.equal(f.doc.querySelector('[role="dialog"]'), null);
    assert.equal(turnBtn.getAttribute("data-state"), "closed");
    assert.equal(turnBtn.style.backgroundColor, "transparent");

    // Outside pointerdown closes
    turnBtn.click();
    f.doc
      .querySelector("#outside")!
      .dispatchEvent(new f.win.Event("pointerdown", { bubbles: true }));
    assert.equal(f.doc.querySelector('[role="dialog"]'), null);
    assert.equal(turnBtn.style.backgroundColor, "transparent");

    // Outside click (e.g. keyboard activation) closes
    turnBtn.click();
    f.doc.querySelector<HTMLButtonElement>("#outside")!.click();
    assert.equal(f.doc.querySelector('[role="dialog"]'), null);
    assert.equal(turnBtn.style.backgroundColor, "transparent");

    // Escape closes and restores focus
    turnBtn.click();
    f.doc.dispatchEvent(new f.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(f.doc.querySelector('[role="dialog"]'), null);
    assert.equal(f.doc.activeElement, turnBtn);
    assert.equal(turnBtn.style.backgroundColor, "transparent");
  } finally {
    f.cleanup();
  }
});

test("showFooter and showTurnUsage operate completely independently", async () => {
  // Case 1: showFooter: false, showTurnUsage: true
  const f1 = await turnFixture({
    chatHtml: renderTurnFooterHtml({ rowId: "m1", messageId: "m1" }),
    turnUsages: [makeTurn({ turnNumber: 1, messageIds: ["m1"], totalTokens: 4200 })],
    showFooter: false,
    showTurnUsage: true,
  });
  try {
    assert.equal(f1.doc.querySelector("[data-harness-stats-reservation]"), null);
    assert.equal(f1.doc.querySelector("[data-harness-stats]"), null);
    assert.ok(f1.doc.querySelector("[data-harness-turn-usage-style]"));
    const turnBtn = f1.doc.querySelector<HTMLButtonElement>(
      '[data-harness-turn-usage-button="1"]',
    )!;
    assert.ok(turnBtn);
    assert.equal(turnBtn.textContent, "用量 4.2K tok");
    turnBtn.click();
    assert.ok(f1.doc.querySelector('[data-harness-stats-popup="turn-usage"]'));
  } finally {
    f1.cleanup();
  }

  // Case 2: showFooter: true, showTurnUsage: false
  const f2 = await turnFixture({
    chatHtml: renderTurnFooterHtml({ rowId: "m1", messageId: "m1" }),
    turnUsages: [makeTurn({ turnNumber: 1, messageIds: ["m1"], totalTokens: 4200 })],
    showFooter: true,
    showTurnUsage: false,
  });
  try {
    assert.ok(f2.doc.querySelector("[data-harness-stats-reservation]"));
    assert.ok(f2.doc.querySelector("[data-harness-stats]"));
    assert.equal(f2.doc.querySelector("[data-harness-turn-usage-style]"), null);
    assert.equal(f2.doc.querySelector("[data-harness-turn-usage-button]"), null);
  } finally {
    f2.cleanup();
  }
});

test("Virtualized list matches by exact ID (with :segment:), timestamp, and trailing non-virtualized alignment without misattributing unknown rows", async () => {
  const baseTs = 1700000000000;
  const f = await turnFixture({
    chatHtml:
      renderTurnFooterHtml({
        rowId: "unknown_virtual_row",
        dataIndex: 0,
      }) +
      renderTurnFooterHtml({
        rowId: "msg-2:segment:0",
        messageId: "msg-2:segment:0",
        dataIndex: 1,
      }) +
      renderTurnFooterHtml({
        rowId: `assistant_${baseTs + 20_000}_abc`,
        dataIndex: 2,
      }) +
      renderTurnFooterHtml({
        // Auxiliary footer at end (no data-history-row-id, not virtualized)
        timing: "Worked for 5s",
      }),
    turnUsages: [
      makeTurn({ turnNumber: 1, messageIds: ["old-1"], totalTokens: 1111 }),
      makeTurn({ turnNumber: 2, messageIds: ["msg-2"], totalTokens: 2222 }),
      makeTurn({
        turnNumber: 3,
        messageIds: [],
        startedAtMs: baseTs + 18_000,
        completedAtMs: baseTs + 22_000,
        totalTokens: 3333,
      }),
      makeTurn({ turnNumber: 4, messageIds: [], totalTokens: 4444 }),
    ],
  });
  try {
    // Unknown virtualized row must NOT get turn 1 guessed onto it
    assert.equal(
      f.doc.querySelector(
        '[data-history-row-id="unknown_virtual_row"] [data-harness-turn-usage-button]',
      ),
      null,
    );
    // Exact ID match after stripping :segment:0
    const btn2 = f.doc.querySelector(
      '[data-history-row-id="msg-2:segment:0"] [data-harness-turn-usage-button]',
    )!;
    assert.equal(btn2.getAttribute("data-harness-turn-usage-button"), "2");
    assert.equal(btn2.textContent, "用量 2.2K tok");

    // Timestamp match for assistant_<ts>_abc
    const btn3 = f.doc.querySelector(
      `[data-history-row-id="assistant_${baseTs + 20_000}_abc"] [data-harness-turn-usage-button]`,
    )!;
    assert.equal(btn3.getAttribute("data-harness-turn-usage-button"), "3");
    assert.equal(btn3.textContent, "用量 3.3K tok");

    // Trailing auxiliary footer aligns to last turn (turn 4)
    const btn4 = f.doc.querySelector('[data-role="auxiliary"] [data-harness-turn-usage-button]')!;
    assert.equal(btn4.getAttribute("data-harness-turn-usage-button"), "4");
    assert.equal(btn4.textContent, "用量 4.4K tok");
  } finally {
    f.cleanup();
  }
});

test("Theme changes update injected per-turn buttons and open turn usage popup immediately, and dispose removes all artifacts", async () => {
  let notifyTheme = () => {};
  const makeTheme = (
    surface1: string,
    surface2: string,
    foreground: string,
    muted: string,
    border: string,
  ): PluginTheme => ({
    colors: {
      surface0: surface1,
      surface1,
      surface2,
      foreground,
      foregroundMuted: muted,
      border,
      accent: "blue",
      accentForeground: "white",
      statusSuccess: "green",
      statusWarning: "yellow",
      statusDanger: "red",
    },
  });
  let active = makeTheme(
    "rgb(20, 30, 40)",
    "rgb(50, 60, 70)",
    "rgb(240, 245, 250)",
    "rgb(150, 160, 170)",
    "rgb(80, 90, 100)",
  );
  const f = await turnFixture({
    chatHtml:
      renderTurnFooterHtml({ rowId: "m1", messageId: "m1" }) +
      renderTurnFooterHtml({ rowId: "m2", messageId: "m2" }),
    turnUsages: [
      makeTurn({ turnNumber: 1, messageIds: ["m1"], totalTokens: 1500 }),
      makeTurn({ turnNumber: 2, messageIds: ["m2"], totalTokens: 2500 }),
    ],
    theme: () => active,
    subscribeTheme: (listener) => {
      notifyTheme = listener;
      return () => {
        notifyTheme = () => {};
      };
    },
  });
  try {
    const btn1 = f.doc.querySelector<HTMLButtonElement>('[data-harness-turn-usage-button="1"]')!;
    const btn2 = f.doc.querySelector<HTMLButtonElement>('[data-harness-turn-usage-button="2"]')!;
    assert.equal(btn2.style.color, active.colors.foregroundMuted);
    btn1.click();
    const popup = f.doc.querySelector<HTMLElement>('[data-harness-stats-popup="turn-usage"]')!;
    assert.equal(popup.style.backgroundColor, active.colors.surface1);
    assert.equal(popup.style.color, active.colors.foreground);
    assert.equal(popup.style.borderColor, active.colors.border);
    assert.equal(btn1.style.backgroundColor, active.colors.surface2);

    active = makeTheme(
      "rgb(250, 248, 240)",
      "rgb(225, 220, 210)",
      "rgb(25, 20, 15)",
      "rgb(110, 105, 95)",
      "rgb(190, 185, 175)",
    );
    notifyTheme();
    assert.equal(popup.style.backgroundColor, active.colors.surface1);
    assert.equal(popup.style.color, active.colors.foreground);
    assert.equal(popup.style.borderColor, active.colors.border);
    assert.equal(btn1.style.backgroundColor, active.colors.surface2);
    assert.equal(btn1.style.color, active.colors.foreground);
    assert.equal(btn2.style.color, active.colors.foregroundMuted);

    f.dispose();
    assert.equal(f.doc.querySelector("[data-harness-turn-usage-button]"), null);
    assert.equal(f.doc.querySelector("[data-harness-turn-usage-style]"), null);
    assert.equal(f.doc.querySelector("[data-harness-stats-reservation]"), null);
    assert.equal(f.doc.querySelector('[role="dialog"]'), null);
  } finally {
    f.cleanup();
  }
});

test("Working turn with partial logged usage keeps completed turns accurate in both non-virtualized and virtualized lists", async () => {
  // 1. Non-virtualized: 2 completed footers + 1 working footer, 3 turns in log (turn 3 already logged step 1)
  const f1 = await turnFixture({
    chatHtml:
      renderTurnFooterHtml({ rowId: "row-a" }) +
      renderTurnFooterHtml({ rowId: "row-b" }) +
      renderTurnFooterHtml({ working: "indicator" }),
    turnUsages: [
      makeTurn({ turnNumber: 1, messageIds: [], totalTokens: 1100 }),
      makeTurn({ turnNumber: 2, messageIds: [], totalTokens: 2200 }),
      makeTurn({ turnNumber: 3, messageIds: [], totalTokens: 9900 }),
    ],
  });
  try {
    const buttons = f1.doc.querySelectorAll<HTMLButtonElement>("[data-harness-turn-usage-button]");
    assert.equal(buttons.length, 2);
    const btn1 = f1.doc.querySelector('[data-history-row-id="row-a"] [data-harness-turn-usage-button]')!;
    const btn2 = f1.doc.querySelector('[data-history-row-id="row-b"] [data-harness-turn-usage-button]')!;
    assert.equal(btn1.getAttribute("data-harness-turn-usage-button"), "1");
    assert.equal(btn1.textContent, "用量 1.1K tok");
    assert.equal(btn2.getAttribute("data-harness-turn-usage-button"), "2");
    assert.equal(btn2.textContent, "用量 2.2K tok");
    assert.equal(
      f1.doc.querySelector('[data-role="auxiliary"] [data-harness-turn-usage-button]'),
      null,
    );
  } finally {
    f1.cleanup();
  }

  // 2. Virtualized: preserve previously matched trailing non-virtualized footer while a new turn is working
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let pollCallback: () => void = () => {};
  globalThis.setInterval = ((fn: () => void) => {
    pollCallback = fn;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => {
    pollCallback = () => {};
  }) as typeof clearInterval;

  const dom = new JSDOM(
    `<body><div data-testid="workspace-pane-main"><button data-testid="workspace-tab-agent_agent-1" aria-selected="true">Agent</button><div data-testid="agent-chat-scroll">${
      renderTurnFooterHtml({ rowId: "msg-1", messageId: "msg-1", dataIndex: 0 }) +
      `<div data-role="live-completed">${renderTurnFooterHtml({ timing: "Worked for 6s" })}</div>`
    }</div><div><div data-testid="message-input-root"><textarea></textarea></div></div></div></body>`,
    { pretendToBeVisual: true },
  );
  const win = dom.window,
    doc = win.document;
  const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: win,
    document: doc,
    MutationObserver: win.MutationObserver,
    getComputedStyle: win.getComputedStyle.bind(win),
  })) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.defineProperty(doc.documentElement, "clientWidth", { value: 1200 });
  Object.defineProperty(doc.documentElement, "clientHeight", { value: 800 });
  Object.defineProperty(win.HTMLElement.prototype, "getClientRects", {
    value() {
      return [this.getBoundingClientRect()];
    },
  });
  Object.defineProperty(win.HTMLElement.prototype, "getBoundingClientRect", {
    value() {
      return { left: 200, right: 360, top: 600, bottom: 624, width: 160, height: 24 };
    },
  });

  let currentTurns: TurnUsage[] = [
    makeTurn({ turnNumber: 1, messageIds: ["msg-1"], totalTokens: 1100 }),
    makeTurn({ turnNumber: 2, messageIds: [], totalTokens: 2200 }),
  ];
  const dispose = installFooter({
    isWeb: true,
    hasAgent: (id) => id === "agent-1",
    read: async () => ({
      ...emptyStats("codex"),
      turns: currentTurns.length,
      steps: currentTurns.length,
      turnUsages: [...currentTurns],
    }),
    copy: () => fullCopy,
  });

  try {
    await flush();
    const liveBtnBefore = doc.querySelector(
      '[data-role="live-completed"] [data-harness-turn-usage-button]',
    )!;
    assert.equal(liveBtnBefore.getAttribute("data-harness-turn-usage-button"), "2");
    assert.equal(liveBtnBefore.textContent, "用量 2.2K tok");

    // Turn 3 starts running and logs its first step while an unconfirmed non-virtualized footer also appears
    const scroll = doc.querySelector('[data-testid="agent-chat-scroll"]')!;
    const unconfirmed = doc.createElement("div");
    unconfirmed.setAttribute("data-role", "unconfirmed-live");
    unconfirmed.innerHTML = renderTurnFooterHtml({ timing: "Worked for 1s" });
    const workingWrap = doc.createElement("div");
    workingWrap.setAttribute("data-role", "working-wrap");
    workingWrap.innerHTML = renderTurnFooterHtml({ working: "indicator" });
    scroll.append(unconfirmed, workingWrap);

    currentTurns = [
      makeTurn({ turnNumber: 1, messageIds: ["msg-1"], totalTokens: 1100 }),
      makeTurn({ turnNumber: 2, messageIds: [], totalTokens: 2200 }),
      makeTurn({ turnNumber: 3, messageIds: [], totalTokens: 9900 }),
    ];
    pollCallback();
    await flush();

    // Confirmed completed turns keep exact mappings and are NOT polluted by turn 3
    const btn1 = doc.querySelector('[data-history-row-id="msg-1"] [data-harness-turn-usage-button]')!;
    const btn2 = doc.querySelector('[data-role="live-completed"] [data-harness-turn-usage-button]')!;
    assert.equal(btn1.getAttribute("data-harness-turn-usage-button"), "1");
    assert.equal(btn1.textContent, "用量 1.1K tok");
    assert.equal(btn2.getAttribute("data-harness-turn-usage-button"), "2");
    assert.equal(btn2.textContent, "用量 2.2K tok");
    // Unconfirmed footer and working footer do NOT receive turn 3's partial usage
    assert.equal(
      doc.querySelector('[data-role="unconfirmed-live"] [data-harness-turn-usage-button]'),
      null,
    );
    assert.equal(
      doc.querySelector('[data-role="working-wrap"] [data-harness-turn-usage-button]'),
      null,
    );
  } finally {
    dispose();
    win.close();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    for (const [key, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("Preferences store defaults turnUsageEnabled to true and notifies subscribers when it changes", () => {
  const initial = getPreferences();
  assert.equal(initial.turnUsageEnabled, true);
  let calls = 0;
  const unsubscribe = subscribePreferences(() => {
    calls++;
  });
  try {
    setPreferences({ ...initial });
    assert.equal(calls, 0);
    setPreferences({ ...initial, turnUsageEnabled: false });
    assert.equal(calls, 1);
    assert.equal(getPreferences().turnUsageEnabled, false);
    setPreferences({ ...initial, turnUsageEnabled: true });
    assert.equal(calls, 2);
  } finally {
    unsubscribe();
    setPreferences(initial);
  }
});

test("RetainedPanel tabs isolate turn usage buttons to the active visible tab's agent-chat-scroll", async () => {
  const dom = new JSDOM(
    `<body>
      <div data-testid="workspace-pane-main">
        <button data-testid="workspace-tab-agent_agent-1" aria-selected="false">Tab 1</button>
        <button data-testid="workspace-tab-agent_agent-2" aria-selected="true">Tab 2</button>
        <div data-role="retained-panel-1" style="display: none">
          <div data-testid="agent-chat-scroll">
            ${renderTurnFooterHtml({ rowId: "tab1-row-1", messageId: "tab1-msg-1" })}
            ${renderTurnFooterHtml({ rowId: "tab1-row-2", messageId: "tab1-msg-2" })}
          </div>
          <div><div data-testid="message-input-root"><textarea></textarea></div></div>
        </div>
        <div data-role="retained-panel-2">
          <div data-testid="agent-chat-scroll">
            ${renderTurnFooterHtml({ rowId: "tab2-row-1", messageId: "tab2-msg-1" })}
            ${renderTurnFooterHtml({ rowId: "tab2-row-2", messageId: "tab2-msg-2" })}
          </div>
          <div><div data-testid="message-input-root"><textarea></textarea></div></div>
        </div>
      </div>
    </body>`,
    { pretendToBeVisual: true },
  );
  const win = dom.window,
    doc = win.document;
  const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: win,
    document: doc,
    MutationObserver: win.MutationObserver,
    getComputedStyle: win.getComputedStyle.bind(win),
  })) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.defineProperty(doc.documentElement, "clientWidth", { value: 1200 });
  Object.defineProperty(doc.documentElement, "clientHeight", { value: 800 });
  Object.defineProperty(win.HTMLElement.prototype, "getClientRects", {
    value() {
      return [this.getBoundingClientRect()];
    },
  });
  Object.defineProperty(win.HTMLElement.prototype, "getBoundingClientRect", {
    value() {
      return { left: 200, right: 360, top: 600, bottom: 624, width: 160, height: 24 };
    },
  });

  const dispose = installFooter({
    isWeb: true,
    hasAgent: (id) => id === "agent-1" || id === "agent-2",
    read: async (id) => ({
      ...emptyStats("codex"),
      turns: 2,
      steps: 2,
      turnUsages:
        id === "agent-2"
          ? [
              makeTurn({ turnNumber: 1, messageIds: ["tab2-msg-1"], totalTokens: 3100 }),
              makeTurn({ turnNumber: 2, messageIds: ["tab2-msg-2"], totalTokens: 4200 }),
            ]
          : [
              makeTurn({ turnNumber: 1, messageIds: ["tab1-msg-1"], totalTokens: 1100 }),
              makeTurn({ turnNumber: 2, messageIds: ["tab1-msg-2"], totalTokens: 2200 }),
            ],
    }),
    copy: () => fullCopy,
  });

  try {
    await flush();
    // Hidden Tab 1 must never receive any turn usage buttons or footer
    assert.equal(
      doc.querySelectorAll('[data-role="retained-panel-1"] [data-harness-turn-usage-button]')
        .length,
      0,
    );
    assert.equal(doc.querySelector('[data-role="retained-panel-1"] [data-harness-stats]'), null);

    // Visible Tab 2 receives exact per-turn buttons inside its own agent-chat-scroll
    const tab2Buttons = doc.querySelectorAll<HTMLButtonElement>(
      '[data-role="retained-panel-2"] [data-harness-turn-usage-button]',
    );
    assert.equal(tab2Buttons.length, 2);
    assert.equal(tab2Buttons[0].getAttribute("data-harness-turn-usage-button"), "1");
    assert.equal(tab2Buttons[0].textContent, "用量 3.1K tok");
    assert.equal(tab2Buttons[1].getAttribute("data-harness-turn-usage-button"), "2");
    assert.equal(tab2Buttons[1].textContent, "用量 4.2K tok");
  } finally {
    dispose();
    win.close();
    for (const [key, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("Paginated non-virtualized history aligns trailing footers (including auxiliaryTurnFooter) and preserves them when a new turn starts working", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let pollCallback: () => void = () => {};
  globalThis.setInterval = ((fn: () => void) => {
    pollCallback = fn;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => {
    pollCallback = () => {};
  }) as typeof clearInterval;

  const dom = new JSDOM(
    `<body>
      <div data-testid="workspace-pane-main">
        <button data-testid="workspace-tab-agent_agent-1" aria-selected="true">Agent</button>
        <div data-testid="agent-chat-scroll">
          ${renderTurnFooterHtml({ rowId: "paginated-row-18" })}
          ${renderTurnFooterHtml({ rowId: "paginated-row-19" })}
          <div data-history-row-id="user_9000_u20"><div data-testid="user-message">Prompt 20</div></div>
          <div data-history-row-id="assistant_9001_a20">Reply 20</div>
          ${renderTurnFooterHtml({ timing: "Worked for 8s" })}
        </div>
        <div><div data-testid="message-input-root"><textarea></textarea></div></div>
      </div>
    </body>`,
    { pretendToBeVisual: true },
  );
  const win = dom.window,
    doc = win.document;
  const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: win,
    document: doc,
    MutationObserver: win.MutationObserver,
    getComputedStyle: win.getComputedStyle.bind(win),
  })) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  Object.defineProperty(doc.documentElement, "clientWidth", { value: 1200 });
  Object.defineProperty(doc.documentElement, "clientHeight", { value: 800 });
  Object.defineProperty(win.HTMLElement.prototype, "getClientRects", {
    value() {
      return [this.getBoundingClientRect()];
    },
  });
  Object.defineProperty(win.HTMLElement.prototype, "getBoundingClientRect", {
    value() {
      return { left: 200, right: 360, top: 600, bottom: 624, width: 160, height: 24 };
    },
  });

  const currentTurns: TurnUsage[] = Array.from({ length: 20 }, (_, idx) =>
    makeTurn({
      turnNumber: idx + 1,
      messageIds: [],
      totalTokens: (idx + 1) * 1000,
    }),
  );

  const dispose = installFooter({
    isWeb: true,
    hasAgent: (id) => id === "agent-1",
    read: async () => ({
      ...emptyStats("antigravity"),
      turns: currentTurns.length,
      steps: currentTurns.length,
      turnUsages: [...currentTurns],
    }),
    copy: () => fullCopy,
  });

  try {
    await flush();
    // 20 turns in log, only trailing 3 non-virtualized footers mounted -> align to turns 18, 19, 20
    const btn18 = doc.querySelector(
      '[data-history-row-id="paginated-row-18"] [data-harness-turn-usage-button]',
    )!;
    const btn19 = doc.querySelector(
      '[data-history-row-id="paginated-row-19"] [data-harness-turn-usage-button]',
    )!;
    const btn20 = doc.querySelector('[data-role="auxiliary"] [data-harness-turn-usage-button]')!;
    assert.equal(btn18.getAttribute("data-harness-turn-usage-button"), "18");
    assert.equal(btn18.textContent, "用量 18K tok");
    assert.equal(btn19.getAttribute("data-harness-turn-usage-button"), "19");
    assert.equal(btn19.textContent, "用量 19K tok");
    assert.equal(btn20.getAttribute("data-harness-turn-usage-button"), "20");
    assert.equal(btn20.textContent, "用量 20K tok");

    // Turn 21 begins working and logs partial usage, while an unconfirmed trailing footer also appears
    const scroll = doc.querySelector('[data-testid="agent-chat-scroll"]')!;
    const unconfirmedWrap = doc.createElement("div");
    unconfirmedWrap.setAttribute("data-role", "unconfirmed-21");
    unconfirmedWrap.innerHTML = renderTurnFooterHtml({ timing: "Worked for 1s" });
    const workingWrap = doc.createElement("div");
    workingWrap.setAttribute("data-role", "working-21");
    workingWrap.innerHTML = renderTurnFooterHtml({ working: "indicator" });
    scroll.append(unconfirmedWrap, workingWrap);

    currentTurns.push(
      makeTurn({
        turnNumber: 21,
        messageIds: [],
        totalTokens: 99_900,
      }),
    );
    pollCallback();
    await flush();

    // Turns 18-20 stay intact and unpolluted; unconfirmed & working turn 21 have no button
    assert.equal(
      doc
        .querySelector('[data-history-row-id="paginated-row-18"] [data-harness-turn-usage-button]')
        ?.getAttribute("data-harness-turn-usage-button"),
      "18",
    );
    assert.equal(
      doc.querySelector('[data-history-row-id="paginated-row-18"] [data-harness-turn-usage-button]')
        ?.textContent,
      "用量 18K tok",
    );
    assert.equal(
      doc
        .querySelector('[data-history-row-id="paginated-row-19"] [data-harness-turn-usage-button]')
        ?.getAttribute("data-harness-turn-usage-button"),
      "19",
    );
    assert.equal(
      doc.querySelector('[data-history-row-id="paginated-row-19"] [data-harness-turn-usage-button]')
        ?.textContent,
      "用量 19K tok",
    );
    assert.equal(
      doc
        .querySelector('[data-role="auxiliary"] [data-harness-turn-usage-button]')
        ?.getAttribute("data-harness-turn-usage-button"),
      "20",
    );
    assert.equal(
      doc.querySelector('[data-role="auxiliary"] [data-harness-turn-usage-button]')?.textContent,
      "用量 20K tok",
    );
    assert.equal(
      doc.querySelector('[data-role="unconfirmed-21"] [data-harness-turn-usage-button]'),
      null,
    );
    assert.equal(
      doc.querySelector('[data-role="working-21"] [data-harness-turn-usage-button]'),
      null,
    );
  } finally {
    dispose();
    win.close();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    for (const [key, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("auxiliaryTurnFooter resolves preceding data-history-row-id rows for Pass 1 exact ID and Pass 2 timestamp matching across unbilled gaps", async () => {
  const baseTs = 1710000000000;
  // Pass 1: auxiliary footer follows assistant row with exact message ID (:segment: stripped), skipping user rows and an unbilled middle turn
  const f1 = await turnFixture({
    chatHtml:
      renderTurnFooterHtml({ rowId: "msg-1", messageId: "msg-1" }) +
      `<div data-history-row-id="user_${baseTs + 10_000}_u2"><div data-testid="user-message">User turn 2</div></div>` +
      `<div data-history-row-id="msg-3:segment:0" data-message-id="msg-3:segment:0">Assistant reply 3</div>` +
      `<div data-history-row-id="user_${baseTs + 15_000}_queued"><div data-testid="user-message">Queued user</div></div>` +
      `<div data-role="aux-pass1">${renderTurnFooterHtml({ timing: "Worked for 4s" })}</div>` +
      renderTurnFooterHtml({ rowId: "msg-5", messageId: "msg-5" }),
    turnUsages: [
      makeTurn({ turnNumber: 1, messageIds: ["msg-1"], totalTokens: 1100 }),
      makeTurn({ turnNumber: 2, messageIds: ["msg-2"], totalTokens: 2200 }),
      makeTurn({ turnNumber: 3, messageIds: ["msg-3"], totalTokens: 3300 }),
      makeTurn({ turnNumber: 4, messageIds: ["msg-4"], totalTokens: 4400 }),
      makeTurn({ turnNumber: 5, messageIds: ["msg-5"], totalTokens: 5500 }),
    ],
  });
  try {
    const auxBtn = f1.doc.querySelector('[data-role="aux-pass1"] [data-harness-turn-usage-button]')!;
    assert.equal(auxBtn.getAttribute("data-harness-turn-usage-button"), "3");
    assert.equal(auxBtn.textContent, "用量 3.3K tok");
  } finally {
    f1.cleanup();
  }

  // Pass 2: auxiliary footer follows assistant_<ts>_hash row outside [data-history-row-id], with a missing/unrendered turn between anchors
  const f2 = await turnFixture({
    chatHtml:
      renderTurnFooterHtml({ rowId: "msg-1", messageId: "msg-1" }) +
      `<div data-history-row-id="user_${baseTs + 30_000}_u3"><div data-testid="user-message">User turn 3</div></div>` +
      `<div data-history-row-id="assistant_${baseTs + 40_000}_hash3">Assistant reply 3</div>` +
      `<div data-role="aux-pass2">${renderTurnFooterHtml({ timing: "Worked for 7s" })}</div>` +
      renderTurnFooterHtml({ rowId: "msg-5", messageId: "msg-5" }),
    turnUsages: [
      makeTurn({
        turnNumber: 1,
        messageIds: ["msg-1"],
        startedAtMs: baseTs,
        completedAtMs: baseTs + 5_000,
        totalTokens: 1100,
      }),
      makeTurn({
        turnNumber: 2,
        messageIds: [],
        startedAtMs: baseTs + 10_000,
        completedAtMs: baseTs + 15_000,
        totalTokens: 2200,
      }),
      makeTurn({
        turnNumber: 3,
        messageIds: [],
        startedAtMs: baseTs + 35_000,
        completedAtMs: baseTs + 42_000,
        totalTokens: 3600,
      }),
      makeTurn({
        turnNumber: 4,
        messageIds: [],
        startedAtMs: baseTs + 80_000,
        completedAtMs: baseTs + 90_000,
        totalTokens: 4400,
      }),
      makeTurn({
        turnNumber: 5,
        messageIds: ["msg-5"],
        startedAtMs: baseTs + 120_000,
        completedAtMs: baseTs + 130_000,
        totalTokens: 5500,
      }),
    ],
  });
  try {
    const auxBtn = f2.doc.querySelector('[data-role="aux-pass2"] [data-harness-turn-usage-button]')!;
    assert.equal(auxBtn.getAttribute("data-harness-turn-usage-button"), "3");
    assert.equal(auxBtn.textContent, "用量 3.6K tok");
    const btn5 = f2.doc.querySelector(
      '[data-history-row-id="msg-5"] [data-harness-turn-usage-button]',
    )!;
    assert.equal(btn5.getAttribute("data-harness-turn-usage-button"), "5");
    assert.equal(btn5.textContent, "用量 5.5K tok");
  } finally {
    f2.cleanup();
  }
});

test("mountTurnButton coexists with Paseo 0.17.5 turn-metrics-trigger and mounts into RNW role=button action bar when timing label is absent", async () => {
  const f = await turnFixture({
    chatHtml:
      // Case 1: timing label present + Paseo 0.17.5 turn-metrics-trigger inside actions
      `<div data-history-row-id="rnw-1" data-message-id="rnw-1">
        <div data-testid="turn-footer">
          <div>
            <div data-role="container">
              <div data-role="actions">
                <div role="button" data-testid="copy-btn"><span>Copy</span></div>
                <div data-testid="assistant-fork-menu"><div role="button"><span>Fork</span></div></div>
                <div role="button" data-testid="turn-metrics-trigger"><span>Metrics</span></div>
              </div>
              <div role="button" data-role="timing-btn"><span data-testid="turn-footer-timing-label">工作了 9s</span></div>
            </div>
          </div>
        </div>
      </div>` +
      // Case 2: no timing label, no fork menu, only Paseo turn-metrics-trigger
      `<div data-history-row-id="rnw-2" data-message-id="rnw-2">
        <div data-testid="turn-footer">
          <div>
            <div data-role="actions-metrics">
              <div role="button" data-testid="turn-metrics-trigger"><svg></svg></div>
            </div>
          </div>
        </div>
      </div>` +
      // Case 3: no timing label, no fork menu, no metrics trigger — only RNW <div role="button"> with inner icon
      `<div data-history-row-id="rnw-3" data-message-id="rnw-3">
        <div data-testid="turn-footer">
          <div>
            <div data-role="actions-rnw">
              <div role="button" data-testid="copy-rnw"><svg data-testid="copy-icon"></svg></div>
            </div>
          </div>
        </div>
      </div>`,
    turnUsages: [
      makeTurn({ turnNumber: 1, messageIds: ["rnw-1"], totalTokens: 1200 }),
      makeTurn({ turnNumber: 2, messageIds: ["rnw-2"], totalTokens: 2300 }),
      makeTurn({ turnNumber: 3, messageIds: ["rnw-3"], totalTokens: 3400 }),
    ],
  });
  try {
    // Case 1: placed between actions (Copy/Fork/turn-metrics-trigger) and timing button
    const btn1 = f.doc.querySelector('[data-history-row-id="rnw-1"] [data-harness-turn-usage-button]')!;
    const container1 = f.doc.querySelector('[data-history-row-id="rnw-1"] [data-role="container"]')!;
    const children1 = Array.from(container1.children);
    assert.equal(children1[0].getAttribute("data-role"), "actions");
    assert.equal(children1[1], btn1);
    assert.equal(children1[2].getAttribute("data-role"), "timing-btn");

    // Case 2: appended as sibling in turn-metrics-trigger's action bar, not inside trigger
    const btn2 = f.doc.querySelector('[data-history-row-id="rnw-2"] [data-harness-turn-usage-button]')!;
    const actions2 = f.doc.querySelector(
      '[data-history-row-id="rnw-2"] [data-role="actions-metrics"]',
    )!;
    assert.equal(btn2.parentElement, actions2);
    assert.equal(
      f.doc.querySelector(
        '[data-history-row-id="rnw-2"] [data-testid="turn-metrics-trigger"] [data-harness-turn-usage-button]',
      ),
      null,
    );

    // Case 3: appended as sibling in RNW <div role="button">'s action bar, preserving inner icon node
    const btn3 = f.doc.querySelector('[data-history-row-id="rnw-3"] [data-harness-turn-usage-button]')!;
    const actions3 = f.doc.querySelector(
      '[data-history-row-id="rnw-3"] [data-role="actions-rnw"]',
    )!;
    const copyRnw = f.doc.querySelector('[data-history-row-id="rnw-3"] [data-testid="copy-rnw"]')!;
    assert.equal(btn3.parentElement, actions3);
    assert.equal(copyRnw.querySelector("[data-harness-turn-usage-button]"), null);
    assert.ok(copyRnw.querySelector('[data-testid="copy-icon"]'));
  } finally {
    f.cleanup();
  }
});

test("Complete official API pricing renders in per-turn button/popup and session usage bar/popup without approximation symbols", async () => {
  const turnCost: CostBreakdown = {
    currency: "USD",
    totalUsd: 0.16,
    uncachedInputUsd: 0.03,
    cachedInputUsd: 0.06,
    cacheWriteUsd: 0.02,
    outputUsd: 0.05,
    complete: true,
    ratesPerMillion: {
      uncachedInput: 3,
      cachedInput: 0.3,
      cacheWrite: 3.75,
      output: 15,
    },
  };
  const sessionCost: CostBreakdown = {
    currency: "USD",
    totalUsd: 78.58,
    uncachedInputUsd: 12.5,
    cachedInputUsd: 4.08,
    cacheWriteUsd: 1.5,
    outputUsd: 60.5,
    complete: true,
    ratesPerMillion: {
      uncachedInput: 3,
      cachedInput: 0.3,
      cacheWrite: 3.75,
      output: 15,
    },
  };
  const f = await turnFixture({
    chatHtml: renderTurnFooterHtml({ rowId: "priced-1", messageId: "priced-1" }),
    turnUsages: [
      makeTurn({
        turnNumber: 1,
        messageIds: ["priced-1"],
        routes: [{ provider: "anthropic", model: "claude-sonnet-4-5" }],
        inputTokens: 480_000,
        uncachedInputTokens: 20_000,
        cachedTokens: 450_000,
        cacheWriteTokens: 10_000,
        outputTokens: 9_500,
        reasoningTokens: 2_100,
        totalTokens: 489_500,
        cost: turnCost,
      }),
    ],
    cost: sessionCost,
  });
  try {
    const turnBtn = f.doc.querySelector<HTMLButtonElement>('[data-harness-turn-usage-button="1"]')!;
    assert.equal(turnBtn.textContent, "用量 489.5K tok · $0.16");
    assert.equal(turnBtn.getAttribute("aria-label"), "用量 489.5K tok · $0.16");
    assert.equal(turnBtn.title, "用量 489.5K tok · $0.16\n489,500 tok · $0.1600");

    turnBtn.click();
    const turnPopup = f.doc.querySelector<HTMLElement>('[data-harness-stats-popup="turn-usage"]')!;
    assert.ok(turnPopup);
    const turnText = turnPopup.textContent!;
    assert.match(turnText, /本轮用量\$0\.1600/);
    assert.match(turnText, /按官方 API 标准定价489,500 tok/);
    assert.match(turnText, /提供方 \/ 模型anthropic\/claude-sonnet-4-5/);
    assert.match(turnText, /缓存命中93\.8%/);
    assert.match(turnText, /未缓存输入\$3 \/ 1M\$0\.030020,000 tok/);
    assert.match(turnText, /缓存读取\$0\.3 \/ 1M\$0\.0600450,000 tok/);
    assert.match(turnText, /缓存写入\$3\.75 \/ 1M\$0\.020010,000 tok/);
    assert.match(turnText, /输出\$15 \/ 1M\$0\.05009,500 tok（其中推理 2,100 tok）/);
    assert.doesNotMatch(turnText, /≈/);

    const usageBtn = f.doc.querySelector<HTMLButtonElement>('[data-harness-stats-button="usage"]')!;
    assert.equal(usageBtn.textContent, "489.5K tok · 缓存命中 94% · $78.58");
    assert.equal(usageBtn.title, "489.5K tok · 缓存命中 94% · $78.58\n489,500 tok · $78.58");

    usageBtn.click();
    const usagePopup = f.doc.querySelector<HTMLElement>('[data-harness-stats-popup="usage"]')!;
    assert.ok(usagePopup);
    const usageText = usagePopup.textContent!;
    assert.match(usageText, /Token 用量\$78\.58/);
    assert.match(usageText, /按官方 API 标准定价489,500 tok/);
    assert.match(usageText, /缓存命中94%/);
    assert.match(usageText, /未缓存输入\$3 \/ 1M\$12\.5020,000 tok/);
    assert.match(usageText, /缓存读取\$0\.3 \/ 1M\$4\.08450,000 tok/);
    assert.match(usageText, /缓存写入\$3\.75 \/ 1M\$1\.5010,000 tok/);
    assert.match(usageText, /输出\$15 \/ 1M\$60\.509,500 tok/);
    assert.doesNotMatch(usageText, /≈/);

    // Closing the session usage popup restores the exact tooltip including detail USD
    usageBtn.click();
    assert.equal(f.doc.querySelector('[role="dialog"]'), null);
    assert.equal(usageBtn.title, "489.5K tok · 缓存命中 94% · $78.58\n489,500 tok · $78.58");
  } finally {
    f.cleanup();
  }
});

test("Partial official pricing without uniform rates shows partial hint and omits per-million rate labels", async () => {
  const partialCost: CostBreakdown = {
    currency: "USD",
    totalUsd: 0.042,
    uncachedInputUsd: 0.01,
    cachedInputUsd: 0.002,
    cacheWriteUsd: 0,
    outputUsd: 0.03,
    complete: false,
  };
  const f = await turnFixture({
    chatHtml: renderTurnFooterHtml({ rowId: "partial-1", messageId: "partial-1" }),
    turnUsages: [
      makeTurn({
        turnNumber: 1,
        messageIds: ["partial-1"],
        routes: [
          { provider: "openai", model: "gpt-5.4" },
          { provider: "custom", model: "local-unpriced" },
        ],
        inputTokens: 12_000,
        uncachedInputTokens: 4_000,
        cachedTokens: 8_000,
        outputTokens: 2_000,
        totalTokens: 14_000,
        cost: partialCost,
      }),
    ],
    cost: partialCost,
  });
  try {
    const turnBtn = f.doc.querySelector<HTMLButtonElement>('[data-harness-turn-usage-button="1"]')!;
    assert.equal(turnBtn.textContent, "用量 14K tok · $0.042");
    assert.equal(turnBtn.title, "用量 14K tok · $0.042\n14,000 tok · $0.0420");

    turnBtn.click();
    const turnPopup = f.doc.querySelector<HTMLElement>('[data-harness-stats-popup="turn-usage"]')!;
    const turnText = turnPopup.textContent!;
    assert.match(turnText, /本轮用量\$0\.0420/);
    assert.match(turnText, /按官方 API 定价（不含未定价模型）14,000 tok/);
    assert.match(turnText, /未缓存输入\$0\.01004,000 tok/);
    assert.match(turnText, /缓存读取\$0\.00208,000 tok/);
    assert.match(turnText, /输出\$0\.03002,000 tok/);
    assert.doesNotMatch(turnText, /\/ 1M/);
    assert.doesNotMatch(turnText, /≈/);

    const usageBtn = f.doc.querySelector<HTMLButtonElement>('[data-harness-stats-button="usage"]')!;
    assert.equal(usageBtn.textContent, "14K tok · 缓存命中 67% · $0.042");
    usageBtn.click();
    const usagePopup = f.doc.querySelector<HTMLElement>('[data-harness-stats-popup="usage"]')!;
    const usageText = usagePopup.textContent!;
    assert.match(usageText, /Token 用量\$0\.0420/);
    assert.match(usageText, /按官方 API 定价（不含未定价模型）14,000 tok/);
    assert.doesNotMatch(usageText, /\/ 1M/);
    assert.doesNotMatch(usageText, /≈/);
  } finally {
    f.cleanup();
  }
});

test("Unpriced sessions and turns omit currency and pricing hints and remain pure token displays", async () => {
  const f = await turnFixture({
    chatHtml: renderTurnFooterHtml({ rowId: "unpriced-1", messageId: "unpriced-1" }),
    turnUsages: [
      makeTurn({
        turnNumber: 1,
        messageIds: ["unpriced-1"],
        routes: [{ provider: "custom", model: "unknown-model" }],
        inputTokens: 10_000,
        uncachedInputTokens: 2_000,
        cachedTokens: 8_000,
        outputTokens: 500,
        totalTokens: 10_500,
      }),
    ],
  });
  try {
    const turnBtn = f.doc.querySelector<HTMLButtonElement>('[data-harness-turn-usage-button="1"]')!;
    assert.equal(turnBtn.textContent, "用量 10.5K tok");
    assert.equal(turnBtn.title, "用量 10.5K tok\n10,500 tok");
    assert.doesNotMatch(turnBtn.textContent!, /\$/);

    turnBtn.click();
    const turnPopup = f.doc.querySelector<HTMLElement>('[data-harness-stats-popup="turn-usage"]')!;
    assert.match(turnPopup.textContent!, /本轮用量10,500 tok/);
    assert.doesNotMatch(turnPopup.textContent!, /\$|按官方 API|≈/);

    const usageBtn = f.doc.querySelector<HTMLButtonElement>('[data-harness-stats-button="usage"]')!;
    assert.equal(usageBtn.textContent, "10.5K tok · 缓存命中 80%");
    assert.equal(usageBtn.title, "10.5K tok · 缓存命中 80%\n10,500 tok");
    assert.doesNotMatch(usageBtn.textContent!, /\$/);

    usageBtn.click();
    const usagePopup = f.doc.querySelector<HTMLElement>('[data-harness-stats-popup="usage"]')!;
    assert.match(usagePopup.textContent!, /Token 用量10,500 tok/);
    assert.doesNotMatch(usagePopup.textContent!, /\$|按官方 API|≈/);
  } finally {
    f.cleanup();
  }
});

test("Auxiliary turn-footer skips intervening data-plugin-row='true' rows and matches preceding assistant_<ts>_ rows", async () => {
  const baseTs = 1700001000000;
  const f = await turnFixture({
    chatHtml:
      `<div data-history-row-id="assistant_${baseTs + 10_000}_a1" data-index="0">Reply 1</div>` +
      `<div data-history-row-id="vivid-activity/turn-time-1" data-plugin-row="true">12:00</div>` +
      `<div data-history-row-id="assistant_${baseTs + 90_000}_decoy" data-plugin-row="true">Plugin decoy</div>` +
      `<div data-history-row-id="harness-stats/turn-usage-1" data-plugin-row="true">Usage 1</div>` +
      renderTurnFooterHtml({ timing: "Worked for 4s" }) +
      `<div data-history-row-id="user_${baseTs + 20_000}_u2" data-testid="user-message">Next</div>` +
      `<div data-history-row-id="assistant_${baseTs + 25_000}_a2" data-index="1">Reply 2</div>` +
      `<div data-history-row-id="vivid-activity/turn-time-2" data-plugin-row="true">12:01</div>` +
      `<div data-history-row-id="harness-stats/turn-usage-2" data-plugin-row="true">Usage 2</div>` +
      renderTurnFooterHtml({ timing: "Worked for 6s" }) +
      renderTurnFooterHtml({ rowId: `assistant_${baseTs + 90_000}_a3`, working: "indicator" }),
    turnUsages: [
      makeTurn({
        turnNumber: 1,
        messageIds: [],
        startedAtMs: baseTs + 8_000,
        completedAtMs: baseTs + 12_000,
        totalTokens: 1500,
      }),
      makeTurn({
        turnNumber: 2,
        messageIds: [],
        startedAtMs: baseTs + 23_000,
        completedAtMs: baseTs + 27_000,
        totalTokens: 2800,
      }),
      makeTurn({
        turnNumber: 3,
        messageIds: [],
        startedAtMs: baseTs + 88_000,
        completedAtMs: baseTs + 92_000,
        totalTokens: 9900,
      }),
    ],
  });
  try {
    const buttons = Array.from(
      f.doc.querySelectorAll<HTMLButtonElement>("[data-harness-turn-usage-button]"),
    );
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0].getAttribute("data-harness-turn-usage-button"), "1");
    assert.equal(buttons[0].textContent, "用量 1.5K tok");
    assert.equal(buttons[1].getAttribute("data-harness-turn-usage-button"), "2");
    assert.equal(buttons[1].textContent, "用量 2.8K tok");

    const vividRow = f.doc.querySelector<HTMLElement>(
      '[data-history-row-id="vivid-activity/turn-time-1"]',
    )!;
    const harnessRow = f.doc.querySelector<HTMLElement>(
      '[data-history-row-id="harness-stats/turn-usage-1"]',
    )!;
    assert.notEqual(f.win.getComputedStyle(vividRow).display, "none");
    assert.equal(f.win.getComputedStyle(harnessRow).display, "none");
  } finally {
    f.cleanup();
  }
});

test("Web injects [data-harness-turn-usage-row-hide] style, cleans it up on dispose, and isolates hide-only mode when both toggles are off", async () => {
  const f1 = await turnFixture({
    chatHtml:
      `<div data-history-row-id="harness-stats/turn-usage-1" data-plugin-row="true">Hidden on desktop</div>` +
      renderTurnFooterHtml({ rowId: "m1", messageId: "m1" }),
    turnUsages: [makeTurn({ turnNumber: 1, messageIds: ["m1"], totalTokens: 3200 })],
    showFooter: true,
    showTurnUsage: true,
  });
  try {
    const hideStyle = f1.doc.querySelector<HTMLStyleElement>("[data-harness-turn-usage-row-hide]");
    assert.ok(hideStyle);
    assert.match(
      hideStyle.textContent ?? "",
      /\[data-history-row-id\^="harness-stats\/"\]\[data-plugin-row="true"\].*display:\s*none\s*!important/,
    );
    const pluginRow = f1.doc.querySelector<HTMLElement>(
      '[data-history-row-id="harness-stats/turn-usage-1"]',
    )!;
    assert.equal(f1.win.getComputedStyle(pluginRow).display, "none");
    f1.dispose();
    assert.equal(f1.doc.querySelector("[data-harness-turn-usage-row-hide]"), null);
  } finally {
    f1.cleanup();
  }

  const f2 = await turnFixture({
    chatHtml:
      `<div data-history-row-id="harness-stats/turn-usage-1" data-plugin-row="true">Hidden even when disabled</div>` +
      renderTurnFooterHtml({ rowId: "m1", messageId: "m1" }),
    turnUsages: [makeTurn({ turnNumber: 1, messageIds: ["m1"], totalTokens: 3200 })],
    showFooter: false,
    showTurnUsage: false,
  });
  try {
    assert.ok(f2.doc.querySelector("[data-harness-turn-usage-row-hide]"));
    assert.equal(f2.doc.querySelector("[data-harness-stats-reservation]"), null);
    assert.equal(f2.doc.querySelector("[data-harness-turn-usage-style]"), null);
    assert.equal(f2.doc.querySelector("[data-harness-stats]"), null);
    assert.equal(f2.doc.querySelector("[data-harness-turn-usage-button]"), null);
    const pluginRow = f2.doc.querySelector<HTMLElement>(
      '[data-history-row-id="harness-stats/turn-usage-1"]',
    )!;
    assert.equal(f2.win.getComputedStyle(pluginRow).display, "none");
    f2.dispose();
    assert.equal(f2.doc.querySelector("[data-harness-turn-usage-row-hide]"), null);
  } finally {
    f2.cleanup();
  }
});
