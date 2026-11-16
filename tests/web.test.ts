import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installFooter, type FooterCopy } from "../client/web";
import { emptyStats } from "../shared/stats";
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
