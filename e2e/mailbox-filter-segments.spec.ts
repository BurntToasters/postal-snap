import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered: F1-F8 (docs/0.4.2-UI-FAILURE-INVENTORY.md).
// F1 overflow, F2 More active state, F3 menu keyboard, F4 radio arrows,
// F5 large-text wrap, F6 bottom-pane clipping, F7 remembered filter,
// F8 forced colors. Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/mailbox-filter-segments-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

const moreButton = (page: Page) =>
  page.getByRole("button", { name: /^More filters/ });

test("the Show group has three radios and a More menu of four", async ({
  page,
}) => {
  await page.goto("/?rowMix=1");
  const group = page.getByRole("radiogroup", { name: "Show" });
  await expect(group.getByRole("radio")).toHaveCount(3);
  await expect(group.getByRole("radio", { name: "All" })).toBeChecked();
  await expect(moreButton(page)).toHaveAccessibleName("More filters");
  await expect(moreButton(page)).toHaveAttribute("aria-haspopup", "menu");
  await moreButton(page).click();
  const menu = page.getByRole("menu", { name: /More filters/ });
  await expect(menu.getByRole("menuitemradio")).toHaveCount(4);
  await expect(moreButton(page)).toHaveAttribute("aria-expanded", "true");
});

test("F2 choosing Pinned names and styles the More button", async ({
  page,
}) => {
  await page.goto("/?rowMix=1");
  await moreButton(page).click();
  await page.getByRole("menuitemradio", { name: "Pinned" }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(moreButton(page)).toHaveAccessibleName("More filters: Pinned");
  await expect(moreButton(page)).toHaveClass(/checked/);
  for (const name of ["All", "Unread", "Starred"]) {
    await expect(page.getByRole("radio", { name })).not.toBeChecked();
  }
  await moreButton(page).click();
  await expect(
    page.getByRole("menuitemradio", { name: "Pinned" }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await page.getByRole("radio", { name: "Unread" }).click();
  await expect(moreButton(page)).toHaveAccessibleName("More filters");
  await expect(moreButton(page)).not.toHaveClass(/checked/);
});

test("F3 the More menu works from the keyboard", async ({ page }) => {
  await page.goto("/?rowMix=1");
  await moreButton(page).focus();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitemradio", { name: "Pinned" }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitemradio", { name: "To me" }),
  ).toBeFocused();
  await page.keyboard.press("i");
  await expect(
    page.getByRole("menuitemradio", { name: "Invitations" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(moreButton(page)).toBeFocused();
  await moreButton(page).press("ArrowUp");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await moreButton(page).click();
  await page.getByRole("heading", { level: 1 }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await moreButton(page).click();
  await page.keyboard.press("Enter");
  await expect(moreButton(page)).toHaveAccessibleName("More filters: Pinned");
});

test("F4 radio arrow keys never move focus into More", async ({ page }) => {
  await page.goto("/?rowMix=1");
  await page.getByRole("radio", { name: "All" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Starred" })).toBeChecked();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "All" })).toBeFocused();
  await expect(moreButton(page)).not.toBeFocused();
});

test("F7 a remembered filter shows in the control", async ({ page }) => {
  await page.goto("/?rowMix=1&mailboxFilter=toMe");
  await expect(moreButton(page)).toHaveAccessibleName("More filters: To me");
  await expect(moreButton(page)).toHaveClass(/checked/);
  await page.goto("/?rowMix=1&mailboxFilter=starred");
  await expect(page.getByRole("radio", { name: "Starred" })).toBeChecked();
  await expect(moreButton(page)).toHaveAccessibleName("More filters");
});

test("F6 the More menu is not clipped in the bottom pane", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?rowMix=1&pane=bottom");
  await moreButton(page).click();
  const menu = page.getByRole("menu", { name: /More filters/ });
  await expect(menu).toBeVisible();
  const clipped = await menu.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const points = [
      [box.left + 4, box.top + 4],
      [box.right - 4, box.top + 4],
      [box.left + 4, box.bottom - 4],
      [box.right - 4, box.bottom - 4],
    ];
    return points.some(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return !hit || !node.contains(hit);
    });
  });
  expect(clipped).toBe(false);
});

type Combo = {
  width: number;
  density: "comfortable" | "compact";
  scale: 1 | 2;
  pane: "right" | "bottom";
};
const combos: Combo[] = [];
for (const density of ["comfortable", "compact"] as const)
  for (const scale of [1, 2] as const)
    for (const pane of ["right", "bottom"] as const)
      combos.push({ width: 1280, density, scale, pane });
combos.push({ width: 640, density: "comfortable", scale: 1, pane: "right" });
combos.push({ width: 900, density: "comfortable", scale: 2, pane: "right" });

for (const combo of combos) {
  const name = `${combo.width}-${combo.density}-${combo.scale}x-${combo.pane}`;
  test(`F1/F5 geometry ${name}`, async ({ page }) => {
    await page.setViewportSize({ width: combo.width, height: 800 });
    await page.goto(
      `/?rowMix=1&density=${combo.density}&scale=${combo.scale}&pane=${combo.pane}`,
    );
    await expect(page.locator(".mailbox-filter-control")).toBeVisible();
    const m = await page.evaluate(() => {
      const band = document.querySelector(".mailbox-filter") as HTMLElement;
      const control = document.querySelector(
        ".mailbox-filter-control",
      ) as HTMLElement;
      const pane = band.closest(".message-pane") as HTMLElement;
      const h1 = document.querySelector(".pane-heading h1") as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(h1);
      const kids = [...control.querySelectorAll(".mailbox-filter-segment")].map(
        (n) => n.getBoundingClientRect(),
      );
      return {
        overflow: band.scrollWidth - band.clientWidth,
        controlLeft: control.getBoundingClientRect().left,
        controlRight: control.getBoundingClientRect().right,
        paneRight: pane.getBoundingClientRect().right,
        h1Left: range.getBoundingClientRect().left,
        segments: kids.length,
        minHeight: Math.min(...kids.map((k) => k.height)),
      };
    });
    expect(m.segments).toBe(4);
    expect(m.overflow).toBeLessThanOrEqual(0);
    expect(m.controlRight).toBeLessThanOrEqual(m.paneRight + 0.5);
    expect(Math.abs(m.controlLeft - m.h1Left)).toBeLessThanOrEqual(1);
    expect(m.minHeight).toBeGreaterThan(20);
  });
}

test("F8 forced colors keep the checked segment and focus visible", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/?rowMix=1");
  const checked = page.locator("label.mailbox-filter-segment", {
    has: page.getByRole("radio", { name: "All", checked: true }),
  });
  await expect(checked).toBeVisible();
  const outline = await checked.evaluate((node) => {
    const style = getComputedStyle(node);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  expect(outline.style).not.toBe("none");
  expect(parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
  await moreButton(page).focus();
  const focus = await moreButton(page).evaluate((node) => {
    const style = getComputedStyle(node);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  expect(focus.style).not.toBe("none");
  expect(parseFloat(focus.width)).toBeGreaterThanOrEqual(2);
});
