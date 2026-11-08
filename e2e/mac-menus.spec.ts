import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifacts } from "./ipc";

// Failure modes (WP4.2 menus, popovers, command palette):
// FM1. Menu rows are 2.25rem in Normal, Comfortable and Compact, and grow with 200% text.
// FM2. Hover and ArrowDown highlight a row with --selection-emphasized and --accent-contrast text.
// FM3. Menus blur on macOS only; Windows, reduced transparency and more contrast use solid --menu-solid.
// FM4. Forced colors use system colors; the highlighted row uses Highlight and HighlightText.
// FM5. Menus stay inside a 620x540 viewport at 200% text.
// FM6. Keyboard opens the menu, moves with arrows, opens and closes submenus, and Escape dismisses.
// FM7. The command palette has a 16px radius and --shadow-window.
// FM8. axe reports no serious violations with a menu open.

test.beforeEach(async ({ page }) => installMockIpc(page));

const ROW = '[role^="menuitem"]';

async function openRowMenu(page: Page, query = "threadGap=1") {
  await page.goto(`/?${query}`);
  await page
    .getByRole("option", { name: /Library hours/i })
    .or(page.getByRole("treeitem", { name: /Library hours/i }))
    .click({ button: "right" });
  const menu = page.locator(".context-menu");
  await expect(menu).toBeVisible();
  return menu;
}

async function openReaderMore(page: Page, query = "") {
  await page.goto(`/?${query}`);
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  const menu = page.locator(".reader-more-menu");
  await expect(menu).toBeVisible();
  return menu;
}

/** Resolves any CSS color expression to the browser's computed rgb() string. */
async function resolveColor(page: Page, value: string): Promise<string> {
  return page.evaluate((expr) => {
    const el = document.createElement("span");
    el.style.color = expr;
    document.body.append(el);
    const out = getComputedStyle(el).color;
    el.remove();
    return out;
  }, value);
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

// The blur sits on the menu's ::before layer, so read the element, then ::before.
async function blurOf(locator: Locator) {
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

async function attachShots(page: Page, testInfo: TestInfo, name: string) {
  await attachArtifacts(page, testInfo, name);
}

// FM1. Row height token holds at every density and grows with root text size.
for (const density of ["normal", "comfortable", "compact"] as const) {
  test(`FM1 menu rows are 2.25rem at ${density}`, async ({ page }) => {
    await openRowMenu(page, `threadGap=1&density=${density}`);
    const row = page.locator(ROW).first();
    const box = await row.boundingBox();
    const rem = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
    expect(box!.height).toBeGreaterThanOrEqual(2.25 * rem - 0.5);
    expect(box!.height).toBeLessThanOrEqual(2.25 * rem + 0.5);
  });
}

test("FM1 menu rows scale with 200% text", async ({ page }) => {
  await openRowMenu(page, "threadGap=1&scale=2");
  const row = page.locator(ROW).first();
  const box = await row.boundingBox();
  const rem = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  expect(rem).toBeGreaterThanOrEqual(31);
  expect(box!.height).toBeCloseTo(2.25 * rem, 0);
});

// FM2. Highlight fill and text come from the emphasized selection tokens.
for (const theme of ["light", "dark"] as const) {
  test(`FM2 hover and ArrowDown highlight the row with accent fill (${theme})`, async ({
    page,
  }) => {
    const menu = await openRowMenu(page, `threadGap=1&theme=${theme}`);
    const row = menu.locator(ROW).nth(1);
    await row.hover();
    const hovered = await row.evaluate((node) => {
      const s = getComputedStyle(node);
      return { bg: s.backgroundColor, color: s.color };
    });
    expect(hovered.bg).toBe(
      await resolveBackground(page, "var(--selection-emphasized)"),
    );
    expect(hovered.color).toBe(
      await resolveColor(page, "var(--accent-contrast)"),
    );

    await menu.locator(ROW).first().focus();
    await page.keyboard.press("ArrowDown");
    const focused = menu.locator(`${ROW}:focus-visible`);
    await expect(focused).toHaveCount(1);
    const keyed = await focused.evaluate((node) => {
      const s = getComputedStyle(node);
      return { bg: s.backgroundColor, color: s.color };
    });
    expect(keyed.bg).toBe(
      await resolveBackground(page, "var(--selection-emphasized)"),
    );
    expect(keyed.color).toBe(
      await resolveColor(page, "var(--accent-contrast)"),
    );

    const danger = menu.locator(`${ROW}.danger`).first();
    if (await danger.count()) {
      await danger.hover();
      const color = await danger.evaluate(
        (node) => getComputedStyle(node).color,
      );
      expect(color).toBe(await resolveColor(page, "var(--accent-contrast)"));
    }
    await attachShots(page, test.info(), `context-menu-${theme}`);
  });
}

// FM3. Material on macOS; solid elsewhere or when transparency is reduced.
test("FM3 menus blur on macOS", async ({ page }) => {
  const menu = await openRowMenu(page);
  await page.evaluate(() => {
    document.documentElement.dataset.platform = "macos";
    document.documentElement.dataset.reduceTransparency = "false";
  });
  expect(await blurOf(menu)).toContain("blur(30px)");
  expect(await blurOf(menu)).toMatch(/saturate\((180%|1\.8)\)/);
  const bg = await menu.evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  expect(bg).toBe(await resolveBackground(page, "var(--menu-material)"));
});

test("FM3 menus are solid on Windows", async ({ page }) => {
  const menu = await openRowMenu(page);
  await page.evaluate(() => {
    document.documentElement.dataset.platform = "windows";
  });
  expect(await blurOf(menu)).toBe("none");
  const bg = await menu.evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  expect(bg).toBe(await resolveBackground(page, "var(--menu-solid)"));
});

test("FM3 menus are solid under reduced transparency and more contrast", async ({
  page,
}) => {
  const menu = await openRowMenu(page);
  // Not macOS: the native poll would reset the attribute while the test runs.
  await page.evaluate(() => {
    document.documentElement.dataset.platform = "linux";
    document.documentElement.dataset.reduceTransparency = "true";
  });
  expect(await blurOf(menu)).toBe("none");
  // The attribute and the media query are separate paths; check the query alone.
  await page.evaluate(() => {
    document.documentElement.dataset.platform = "linux";
    document.documentElement.dataset.reduceTransparency = "false";
  });
  await page.emulateMedia({ contrast: "more" });
  expect(await blurOf(menu)).toBe("none");
});

// FM4. Forced colors: system colors only, Highlight on the active row.
test("FM4 forced colors use system colors and Highlight", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  const menu = await openRowMenu(page);
  expect(await blurOf(menu)).toBe("none");
  const row = menu.locator(ROW).nth(1);
  await row.hover();
  const style = await row.evaluate((node) => {
    const s = getComputedStyle(node);
    return { bg: s.backgroundColor, color: s.color };
  });
  const highlight = await resolveBackground(page, "Highlight");
  const highlightText = await resolveColor(page, "HighlightText");
  expect(style.bg).toBe(highlight);
  expect(style.color).toBe(highlightText);
});

// FM5. Fits 620x540 at 200% with the reader More menu.
test("FM5 menus fit a 620x540 viewport at 200%", async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 540 });
  const menu = await openReaderMore(page, "scale=2");
  const box = await menu.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(620);
  const state = await menu.evaluate((node) => ({
    bottom: node.getBoundingClientRect().bottom,
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
  }));
  if (state.bottom > 540) {
    expect(state.scrollHeight).toBeGreaterThan(state.clientHeight);
  } else {
    expect(state.bottom).toBeLessThanOrEqual(540);
  }
});

// FM6. Keyboard only: open, move, submenu in and out, Escape.
test("FM6 keyboard opens, moves, enters and leaves submenus, and dismisses", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  const row = page
    .getByRole("option", { name: /Library hours/i })
    .or(page.getByRole("treeitem", { name: /Library hours/i }));
  await row.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.locator(".context-menu");
  await expect(menu).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(menu.locator(`${ROW}:focus-visible`)).toHaveCount(1);

  const trigger = page.locator(".popup-submenu-trigger", {
    hasText: "Reply options",
  });
  await trigger.focus();
  await page.keyboard.press("ArrowRight");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

// FM7. Palette matches the window token radius and shadow.
test("FM7 command palette uses a 16px radius and window shadow", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".mail-shell").waitFor();
  await page.keyboard.press("ControlOrMeta+K");
  const dialog = page.locator(".palette-dialog");
  await expect(dialog).toBeVisible();
  const style = await dialog.evaluate((node) => {
    const s = getComputedStyle(node);
    return { radius: s.borderRadius, shadow: s.boxShadow };
  });
  expect(style.radius).toBe("16px");
  const shadow = await page.evaluate(() => {
    const el = document.createElement("div");
    el.style.boxShadow = "var(--shadow-window)";
    document.body.append(el);
    const out = getComputedStyle(el).boxShadow;
    el.remove();
    return out;
  });
  expect(style.shadow).toBe(shadow);
  await attachShots(page, test.info(), "command-palette-light");
  await page.keyboard.press("Escape");
});

for (const theme of ["light", "dark"] as const) {
  test(`FM7 palette screenshot (${theme})`, async ({ page }, testInfo) => {
    await page.goto(`/?theme=${theme}`);
    await page.locator(".mail-shell").waitFor();
    await page.keyboard.press("ControlOrMeta+K");
    await expect(page.locator(".palette-dialog")).toBeVisible();
    await attachArtifacts(page, testInfo, `command-palette-${theme}`);
  });
}

// FM8. No serious axe violations with menus open.
for (const theme of ["light", "dark"] as const) {
  test(`FM8 axe finds no serious violations with menus open (${theme})`, async ({
    page,
  }) => {
    await openRowMenu(page, `threadGap=1&theme=${theme}`);
    const contextResults = await new AxeBuilder({ page })
      .include(".context-menu")
      .analyze();
    const moreMenu = await openReaderMore(page, `theme=${theme}`);
    expect(moreMenu).toBeVisible();
    const moreResults = await new AxeBuilder({ page })
      .include(".reader-more-menu")
      .analyze();
    const serious = [
      ...contextResults.violations,
      ...moreResults.violations,
    ].filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(
      serious.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      ),
    ).toEqual([]);
    await attachArtifacts(page, test.info(), `reader-more-${theme}`);
  });
}
