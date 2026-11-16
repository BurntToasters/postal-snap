import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifactsAfterEach, ipcCalls } from "./ipc";

test.afterEach(attachArtifactsAfterEach);

// Failure modes covered here:
// FM1. A submenu panel is offset from its parent menu (left edge not beside it, top not on its row).
// FM2. A pointer click on a submenu item misses because another surface takes the press.
// FM3. At 200% text near the bottom edge, the submenu extends past the viewport.
// FM4. ArrowRight, ArrowLeft, or Escape no longer opens, closes, or returns focus correctly.
// FM5. The menu loses its macOS material, or is translucent on Windows.

test.beforeEach(async ({ page }) => installMockIpc(page));

const VIEWPORT = { width: 1240, height: 820 };

function weekendRow(page: Page) {
  return page.getByRole("option", { name: /Weekend plans/i });
}

function flagTrigger(page: Page) {
  return page.locator(".popup-submenu-trigger", { hasText: "Flag color" });
}

async function openRowMenu(page: Page) {
  await weekendRow(page).click({ button: "right" });
  const menu = page.locator(".context-menu");
  await expect(menu).toBeVisible();
  return menu;
}

/** Hover opens the submenu, as a pointer user would. */
async function hoverFlagSubmenu(page: Page) {
  const trigger = flagTrigger(page);
  await trigger.hover();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  return page.locator(".popup-submenu-panel");
}

async function colorCalls(page: Page) {
  return (await ipcCalls(page)).filter(
    (call) => call.command === "set_messages_flag_color",
  );
}

/** Backdrop material on the element, or on its ::before layer. */
async function materialOf(locator: Locator) {
  return locator.evaluate((node) => {
    const pick = (s: CSSStyleDeclaration) =>
      s.backdropFilter ||
      (s as CSSStyleDeclaration & { webkitBackdropFilter?: string })
        .webkitBackdropFilter ||
      "none";
    const own = pick(getComputedStyle(node));
    return own !== "none" ? own : pick(getComputedStyle(node, "::before"));
  });
}

async function resolveBackground(page: Page, value: string): Promise<string> {
  return page.evaluate((expr) => {
    const el = document.createElement("span");
    el.style.backgroundColor = expr;
    document.body.append(el);
    const out = getComputedStyle(el).backgroundColor;
    el.remove();
    return out;
  }, value);
}

// FM1. The submenu sits beside the parent menu and its top aligns with the trigger row.
test("FM1 submenu panel sits beside its parent menu and aligns with the row", async ({
  page,
}) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("/");
  const menu = await openRowMenu(page);
  const panel = await hoverFlagSubmenu(page);
  const parent = (await menu.boundingBox())!;
  const row = (await flagTrigger(page).boundingBox())!;
  const box = (await panel.boundingBox())!;
  const onRight = box.x >= parent.x + parent.width / 2;
  const edgeGap = onRight
    ? Math.abs(box.x - (parent.x + parent.width))
    : Math.abs(parent.x - (box.x + box.width));
  expect(edgeGap).toBeLessThanOrEqual(8);
  expect(Math.abs(box.y - row.y)).toBeLessThanOrEqual(8);
});

// FM2. A pointer click on a submenu item reaches the item and applies it.
test("FM2 pointer click on a submenu item applies the flag", async ({
  page,
}) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("/");
  const id = Number(await weekendRow(page).getAttribute("data-message-id"));
  await openRowMenu(page);
  const panel = await hoverFlagSubmenu(page);
  await panel
    .getByRole("menuitem", { name: "Orange", exact: true })
    .click({ timeout: 5000 });
  await expect.poll(async () => (await colorCalls(page)).length).toBe(1);
  expect((await colorCalls(page))[0].args).toMatchObject({
    messageIds: [id],
    color: 1,
  });
});

// FM2b. A press on a submenu item in the mailbox More menu is not an outside press.
test("FM2 pointer click on a mailbox More submenu item is not an outside press", async ({
  page,
}) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("/");
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  const trigger = page.locator(".popup-submenu-trigger", {
    hasText: "Sort by",
  });
  await trigger.hover();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page
    .locator(".popup-submenu-panel")
    .getByRole("menuitemradio", { name: "From", exact: true })
    .click({ timeout: 5000 });
  // The click closes the menu; reopening shows the choice applied.
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page.locator(".popup-submenu-trigger", { hasText: "Sort by" }).hover();
  await expect(
    page
      .locator(".popup-submenu-panel")
      .getByRole("menuitemradio", { name: "From", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
});

// FM3. Near the bottom edge at 200% text, the submenu stays inside the viewport.
// A short viewport puts the Flag color row near the bottom edge.
const SHORT = { width: 1240, height: 560 };

test("FM3 submenu stays inside the viewport at 200% near the bottom edge", async ({
  page,
}) => {
  await page.setViewportSize(SHORT);
  await page.goto("/?scale=2");
  const row = weekendRow(page);
  await row.evaluate((el) => el.scrollIntoView({ block: "end" }));
  await row.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.locator(".context-menu")).toBeVisible();
  const panel = await hoverFlagSubmenu(page);
  const trigger = (await flagTrigger(page).boundingBox())!;
  // The menu must sit low enough that a fixed-offset bug would overflow.
  expect(trigger.y).toBeGreaterThan(SHORT.height * 0.5);
  const box = (await panel.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(SHORT.height);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(SHORT.width);
});

// FM4. Arrow and Escape keys drive the submenu; Escape closes only the submenu first.
test("FM4 ArrowRight, ArrowLeft, and Escape drive the submenu", async ({
  page,
}) => {
  await page.goto("/");
  await weekendRow(page).focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.locator(".context-menu");
  await expect(menu).toBeVisible();
  const trigger = flagTrigger(page);
  await trigger.focus();
  await page.keyboard.press("ArrowRight");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(
    page
      .locator(".popup-submenu-panel")
      .getByRole("menuitem", { name: "Red", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator(".popup-submenu-panel")).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

// FM5. Translucent material on macOS for the menu and its submenu; solid on Windows.
test("FM5 menu and submenu are translucent on macOS and solid on Windows", async ({
  page,
}) => {
  await page.goto("/");
  const menu = await openRowMenu(page);
  const panel = await hoverFlagSubmenu(page);
  await page.evaluate(() => {
    document.documentElement.dataset.platform = "macos";
    document.documentElement.dataset.reduceTransparency = "false";
  });
  for (const surface of [menu, panel]) {
    expect(await materialOf(surface)).toContain("blur(30px)");
  }

  await page.evaluate(() => {
    document.documentElement.dataset.platform = "windows";
  });
  const solid = await resolveBackground(page, "var(--menu-solid)");
  for (const surface of [menu, panel]) {
    expect(await materialOf(surface)).toBe("none");
    expect(
      await surface.evaluate((node) => getComputedStyle(node).backgroundColor),
    ).toBe(solid);
  }
});
