import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here (docs/0.4.2-UI-FAILURE-INVENTORY.md):
// R3  The cluster shows before hover, or the date stays under it.
// R4  Hover styles stick on touch.
// R5  A cluster click opens the row or steals focus.
// R6  A double-click on Archive sends two moves.
// R7  The cluster overflows a 240px pane or shrinks below the target size.
// R8  Compact and 200% text clip the cluster or grow the row.
// R9  Hover shifts the row layout.
// R10 Conversation, Archive and Trash rows keep the wrong labels.
// R11 The cluster is not aria-hidden, or Tab lands in it.
// R13 The cluster shows in select mode.
// R14 Forced colors lose the cluster.
// R15 Reduced motion still animates.
// R16 A 1500-row list stalls on hover.
// R19 Right-clicking the cluster misses the row menu.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/list-row-actions-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

const MIX = "/?rowMix=1&theme=light";

function wrapFor(page: Page, name: RegExp, role = "option"): Locator {
  return page.locator(".message-row-wrap").filter({
    has: page.getByRole(role as "option", { name }),
  });
}

function action(wrap: Locator, name: string): Locator {
  return wrap.locator(`button.row-action[data-action="${name}"]`);
}

async function ipc(page: Page, command: string) {
  return page.evaluate(
    (name) =>
      (window.__POSTAL_SNAP_TEST__?.ipcCalls ?? []).filter(
        (call) => call.command === name,
      ),
    command,
  );
}

async function targetSize(page: Page): Promise<number> {
  return page.evaluate(() => {
    const probe = document.createElement("i");
    probe.style.cssText = "position:fixed;width:var(--target-size)";
    document.body.append(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  });
}

async function measure(wrap: Locator) {
  return wrap.evaluate((node) => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const cluster = node.querySelector(".row-actions");
    const style = cluster ? getComputedStyle(cluster) : null;
    const date = node.querySelector(".message-when");
    return {
      row: box(node.querySelector(".message-row")),
      sender: box(node.querySelector(".message-sender")),
      subject: box(node.querySelector(".message-subject")),
      cluster: box(cluster),
      opacity: style ? Number(style.opacity) : null,
      pointer: style?.pointerEvents ?? null,
      dateOpacity: date ? Number(getComputedStyle(date).opacity) : null,
      dateVisibility: date ? getComputedStyle(date).visibility : null,
      buttons: [...node.querySelectorAll("button.row-action")].map((button) => {
        const r = button.getBoundingClientRect();
        return { width: r.width, height: r.height };
      }),
    };
  });
}

function dateHidden(m: Awaited<ReturnType<typeof measure>>): boolean {
  return m.dateOpacity === 0 || m.dateVisibility === "hidden";
}

test("the cluster is invisible and inert before hover", async ({ page }) => {
  await page.goto(MIX);
  const wrap = wrapFor(page, /Receipt and tickets/i);
  await expect(wrap).toBeVisible();
  await page.mouse.move(2, 2);
  const cluster = wrap.locator("div.row-actions");
  await expect(cluster).toHaveCount(1);
  await expect(cluster).toHaveAttribute("aria-hidden", "true");
  const m = await measure(wrap);
  expect(m.opacity).toBe(0);
  expect(m.pointer).toBe("none");
  expect(dateHidden(m)).toBe(false);
  const names = await wrap
    .locator("button.row-action")
    .evaluateAll((nodes) =>
      nodes.map((node) => [
        node.getAttribute("data-action"),
        node.getAttribute("tabindex"),
      ]),
    );
  expect(names).toEqual([
    ["star", "-1"],
    ["read", "-1"],
    ["archive", "-1"],
    ["trash", "-1"],
  ]);
});

test("hover reveals four target-sized buttons inside the row without shifting it", async ({
  page,
}) => {
  await page.goto(MIX);
  const wrap = wrapFor(page, /Receipt and tickets/i);
  await page.mouse.move(2, 2);
  const before = await measure(wrap);
  await wrap.hover();
  await expect.poll(async () => (await measure(wrap)).opacity).toBe(1);
  const after = await measure(wrap);
  expect(after.pointer).toBe("auto");
  expect(dateHidden(after)).toBe(true);
  expect(after.row).toEqual(before.row);
  expect(after.sender).toEqual(before.sender);
  expect(after.subject).toEqual(before.subject);
  const c = after.cluster!;
  const r = after.row!;
  expect(c.left).toBeGreaterThanOrEqual(r.left - 0.5);
  expect(c.right).toBeLessThanOrEqual(r.right + 0.5);
  expect(c.top).toBeGreaterThanOrEqual(r.top - 0.5);
  expect(c.bottom).toBeLessThanOrEqual(r.bottom + 0.5);
  const size = await targetSize(page);
  expect(after.buttons).toHaveLength(4);
  for (const button of after.buttons) {
    expect(button.width).toBeGreaterThanOrEqual(size - 0.5);
    expect(button.height).toBeGreaterThanOrEqual(size - 0.5);
  }
});

for (const [label, query] of [
  ["compact", "&density=compact"],
  ["200% text", "&scale=2"],
  ["compact 200%", "&density=compact&scale=2"],
  ["240px pane", "&messagePaneWidth=240"],
] as const) {
  test(`the cluster fits and keeps the row height: ${label}`, async ({
    page,
  }) => {
    await page.goto(`${MIX}${query}`);
    const wrap = wrapFor(page, /Receipt and tickets/i);
    await page.mouse.move(2, 2);
    const before = await measure(wrap);
    await wrap.hover();
    await expect.poll(async () => (await measure(wrap)).opacity).toBe(1);
    const after = await measure(wrap);
    expect(after.row).toEqual(before.row);
    const c = after.cluster!;
    const r = after.row!;
    expect(c.left).toBeGreaterThanOrEqual(r.left - 0.5);
    expect(c.right).toBeLessThanOrEqual(r.right + 0.5);
    expect(c.top).toBeGreaterThanOrEqual(r.top - 0.5);
    expect(c.bottom).toBeLessThanOrEqual(r.bottom + 0.5);
  });
}

test("cluster buttons act without opening the row or taking focus", async ({
  page,
}) => {
  await page.goto(MIX);
  const wrap = wrapFor(page, /Receipt and tickets/i);
  const row = page.getByRole("option", { name: /Receipt and tickets/i });
  await row.focus();
  await wrap.hover();
  await action(wrap, "star").click();
  await expect(row).toHaveAccessibleName(/Starred/i);
  await expect(row).not.toHaveAttribute("aria-selected", "true");
  await expect(row).toBeFocused();
  await expect(action(wrap, "star")).toHaveAttribute("aria-pressed", "true");
  await expect(action(wrap, "star")).toHaveAttribute(
    "aria-label",
    "Remove star",
  );
  await action(wrap, "read").click();
  await expect(row).toHaveAccessibleName(/Unread/i);
  await expect(row).not.toHaveAttribute("aria-selected", "true");
  const flags = await ipc(page, "set_message_flags");
  expect(flags.length).toBe(2);
});

test("Tab never lands in the cluster", async ({ page }) => {
  await page.goto(MIX);
  const wrap = wrapFor(page, /Receipt and tickets/i);
  await wrap.hover();
  await page.getByRole("option", { name: /Receipt and tickets/i }).focus();
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(
      () => !!document.activeElement?.closest(".row-actions"),
    );
    expect(inside).toBe(false);
  }
});

test("Archive moves once on a double-click", async ({ page }) => {
  await page.goto(MIX);
  const wrap = wrapFor(page, /Receipt and tickets/i);
  await wrap.hover();
  await action(wrap, "archive").dblclick();
  await expect
    .poll(async () => (await ipc(page, "move_message")).length)
    .toBeGreaterThan(0);
  await page.waitForTimeout(300);
  const moves = await ipc(page, "move_message");
  expect(moves).toHaveLength(1);
  expect(moves[0].args).toMatchObject({ messageId: 61, role: "archive" });
});

test("Trash moves to the Trash role", async ({ page }) => {
  await page.goto(MIX);
  const wrap = wrapFor(page, /Receipt and tickets/i);
  await wrap.hover();
  await action(wrap, "trash").click();
  await expect
    .poll(async () => (await ipc(page, "move_message")).length)
    .toBe(1);
  expect((await ipc(page, "move_message"))[0].args).toMatchObject({
    messageId: 61,
    role: "trash",
  });
});

test("conversation rows use conversation labels", async ({ page }) => {
  await page.goto("/?threadGap=1&theme=light");
  const wrap = wrapFor(page, /Conversation/i, "treeitem");
  await expect(wrap).toBeVisible();
  await wrap.hover();
  await expect(action(wrap, "star")).toHaveAttribute(
    "aria-label",
    "Star conversation",
  );
  await expect(action(wrap, "read")).toHaveAttribute(
    "aria-label",
    "Mark conversation read",
  );
  await expect(action(wrap, "archive")).toHaveAttribute(
    "aria-label",
    "Archive conversation",
  );
  await expect(action(wrap, "trash")).toHaveAttribute(
    "aria-label",
    "Move conversation to trash",
  );
});

test("Archive rows offer Move to Inbox", async ({ page }) => {
  await page.goto("/?inArchive=1&theme=light");
  const wrap = wrapFor(page, /Weekend plans/i);
  await wrap.hover();
  await expect(action(wrap, "archive")).toHaveAttribute(
    "aria-label",
    "Move to Inbox",
  );
  await expect(action(wrap, "archive")).toHaveAttribute(
    "title",
    /Move to Inbox/,
  );
});

test("Trash rows say Delete and confirm natively", async ({ page }) => {
  await page.goto("/?inTrash=1&theme=light");
  const wrap = wrapFor(page, /Weekend plans/i);
  await wrap.hover();
  await expect(action(wrap, "trash")).toHaveAttribute("aria-label", "Delete");
  let dialogType = "";
  page.once("dialog", (dialog) => {
    dialogType = dialog.type();
    void dialog.accept();
  });
  await action(wrap, "trash").click();
  await expect
    .poll(async () => (await ipc(page, "delete_trash_messages")).length)
    .toBe(1);
  expect(dialogType).toBe("confirm");
  expect((await ipc(page, "move_message")).length).toBe(0);
});

test("the cluster follows the selected row colors", async ({ page }) => {
  await page.goto(MIX);
  const row = page.getByRole("option", { name: /Pinned reminder/i });
  const wrap = wrapFor(page, /Pinned reminder/i);
  await row.click();
  await expect(row).toHaveAttribute("aria-selected", "true");
  await wrap.hover();
  await expect.poll(async () => (await measure(wrap)).opacity).toBe(1);
  const colors = await wrap.evaluate((node) => ({
    row: getComputedStyle(node.querySelector(".message-row")!).backgroundColor,
    cluster: getComputedStyle(node.querySelector(".row-actions")!)
      .backgroundColor,
  }));
  expect(colors.cluster).toBe(colors.row);
});

test("right-clicking the cluster opens the row menu", async ({ page }) => {
  await page.goto(MIX);
  const wrap = wrapFor(page, /Receipt and tickets/i);
  await wrap.hover();
  await action(wrap, "star").click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Actions" })).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Reply", exact: true }),
  ).toBeVisible();
});

test("select mode has no cluster", async ({ page }) => {
  await page.goto(MIX);
  await page.locator("button.list-day").first().click();
  await expect(page.locator(".message-select-hit").first()).toBeVisible();
  await expect(page.locator(".row-actions")).toHaveCount(0);
});

test("reduced motion removes the cluster transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(MIX);
  const wrap = wrapFor(page, /Receipt and tickets/i);
  await wrap.hover();
  await expect.poll(async () => (await measure(wrap)).opacity).toBe(1);
  const duration = await wrap
    .locator(".row-actions")
    .evaluate((node) => getComputedStyle(node).transitionDuration);
  expect(duration.split(",").every((part) => parseFloat(part) === 0)).toBe(
    true,
  );
});

test("forced colors keep the cluster, star mark and unread dot", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto(MIX);
  const wrap = wrapFor(page, /Receipt and tickets/i);
  await wrap.hover();
  await expect.poll(async () => (await measure(wrap)).opacity).toBe(1);
  const facts = await wrap.evaluate((node) => {
    const probe = (css: string, prop: "color" | "backgroundColor") => {
      const el = document.createElement("i");
      el.style.cssText = css;
      document.body.append(el);
      const value = getComputedStyle(el)[prop];
      el.remove();
      return value;
    };
    const cluster = getComputedStyle(node.querySelector(".row-actions")!);
    const button = getComputedStyle(node.querySelector("button.row-action")!);
    return {
      clusterBg: cluster.backgroundColor,
      canvas: probe("background-color:Canvas", "backgroundColor"),
      buttonColor: button.color,
      buttonText: probe("color:ButtonText", "color"),
    };
  });
  expect(facts.clusterBg).toBe(facts.canvas);
  expect(facts.buttonColor).toBe(facts.buttonText);
  const mixWrap = wrapFor(page, /Team calendar invitation/i);
  const dot = await mixWrap
    .locator(".unread-dot")
    .evaluate((node) => getComputedStyle(node).borderTopWidth);
  expect(dot).toBe("1px");
});

test("a 1500-row list reveals the cluster promptly", async ({ page }) => {
  await page.goto("/?hugeList=1500&theme=light");
  await expect(page.getByRole("option").first()).toBeVisible();
  const wrap = page.locator(".message-row-wrap").nth(3);
  const started = Date.now();
  await wrap.hover();
  await expect.poll(async () => (await measure(wrap)).opacity).toBe(1);
  expect(Date.now() - started).toBeLessThan(1500);
});

test.describe("touch", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("a tap opens the message and never shows the cluster", async ({
    page,
  }) => {
    await page.goto(MIX);
    const hoverNone = await page.evaluate(
      () => window.matchMedia("(hover: none)").matches,
    );
    test.skip(!hoverNone, "This engine reports hover on a touch context.");
    const row = page.getByRole("option", { name: /Receipt and tickets/i });
    await expect(row).toBeVisible();
    const wrap = wrapFor(page, /Receipt and tickets/i);
    await row.tap();
    await expect(row).toHaveAttribute("aria-selected", "true");
    const m = await measure(wrap);
    expect(m.opacity).toBe(0);
    expect(dateHidden(m)).toBe(false);
  });
});
