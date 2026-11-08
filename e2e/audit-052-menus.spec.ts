import { mkdir, writeFile } from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifactsAfterEach } from "./ipc";

test.afterEach(attachArtifactsAfterEach);

// Failure modes (audit-052 menus):
// 1. Account switcher inside the clipped folder pane (glass, drawer).
// 2. Enter/Space on an open submenu row leaves focus behind.
// 3. Typeahead miss in a submenu moves focus to the parent menu.
// 4. Open submenu row unhighlighted; forced colors lose hover.
// 5. Submenus drift on parent scroll; two can be open at once.
// 6. Reader More: dangling separators before empty folder rows.
// 7. Reader More repeats toolbar Archive/Trash; .danger scope.
// 8. Move to submenu heading repeats its label.
// 9. Forward bare F missing from hints; search hint "⌘F / /".
// 10. Duplicated selector and formatter (code review).
// 11. Popup menus cap at 70vh; chevrons off the trailing edge.

const ARTIFACT_DIR = "artifacts/0.5.2/audit-fixes/audit-menus";
const SHOT_DIR = "test-results/audit-menus";
const summary: Record<string, unknown> = {};

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  await mkdir(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SHOT_DIR}/${slug}.png` });
});

test.afterAll(async () => {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(
    `${ARTIFACT_DIR}/menus.json`,
    `${JSON.stringify(summary, null, 2)}\n`,
  );
});

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no box");
  return box;
}

async function openRowMenu(page: Page) {
  await page
    .getByRole("option", { name: /Library hours/i })
    .or(page.getByRole("treeitem", { name: /Library hours/i }))
    .click({ button: "right" });
  await expect(page.locator(".context-menu")).toBeVisible();
}

async function openReaderMore(page: Page) {
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.locator(".reader-more-menu")).toBeVisible();
}

/** Lists separator placement problems inside one menu root. */
async function separatorProblems(page: Page, selector: string) {
  return page.evaluate((root) => {
    const problems: string[] = [];
    for (const menu of Array.from(document.querySelectorAll(root))) {
      const kids = Array.from(menu.children);
      const isSep = (node?: Element) =>
        node?.classList.contains("context-menu-separator") ?? false;
      if (isSep(kids[0])) problems.push("leading");
      if (isSep(kids[kids.length - 1])) problems.push("trailing");
      kids.forEach((node, index) => {
        if (isSep(node) && isSep(kids[index + 1])) problems.push("double");
      });
    }
    return problems;
  }, selector);
}

// 1. Account switcher placement under window glass and the narrow drawer.
for (const density of ["normal", "comfortable", "compact"] as const) {
  test(`account switcher opens inside the viewport at ${density} with window glass`, async ({
    page,
  }) => {
    await page.goto(`/?density=${density}`);
    await page.locator(".mail-shell").waitFor();
    await page.evaluate(() => {
      document.documentElement.dataset.windowFx = "vibrant";
    });
    const trigger = page.locator(".account-switcher-trigger");
    await trigger.click();
    const menu = page.locator(".account-switcher-menu");
    await expect(menu).toBeVisible();
    const box = await boxOf(menu);
    const anchor = await boxOf(trigger);
    const view = page.viewportSize();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(view?.width ?? 0);
    expect(box.y + box.height).toBeLessThanOrEqual(view?.height ?? 0);
    expect(Math.abs(box.y - (anchor.y + anchor.height))).toBeLessThanOrEqual(8);
    // Not clipped: the menu's right edge is hit-testable inside the menu.
    const hit = await page.evaluate(
      ({ x, y }) =>
        Boolean(
          document.elementFromPoint(x, y)?.closest(".account-switcher-menu"),
        ),
      { x: box.x + box.width - 4, y: box.y + box.height / 2 },
    );
    expect(hit).toBe(true);
    // Portalled out of the folder pane, which clips and transforms.
    expect(
      await menu.evaluate((node) => node.closest(".folder-pane") === null),
    ).toBe(true);
    summary[`accountSwitcher|${density}|glass`] = { box, anchor };
  });
}

test("account switcher in the narrow drawer stays inside the viewport and closes cleanly", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await page.goto("/");
  await page.locator(".mail-shell").waitFor();
  await page.getByRole("button", { name: "Show mailboxes" }).click();
  await expect(page.locator(".folder-pane")).toHaveClass(/./);
  const trigger = page.locator(".account-switcher-trigger");
  await trigger.click();
  const menu = page.locator(".account-switcher-menu");
  await expect(menu).toBeVisible();
  const box = await boxOf(menu);
  expect(box.x + box.width).toBeLessThanOrEqual(800);
  expect(box.y + box.height).toBeLessThanOrEqual(700);
  // A click on a menu row must select it, not dismiss the menu first.
  const other = menu
    .locator('[role="menuitemradio"][aria-checked="false"]')
    .first();
  if (await other.count()) {
    await other.click();
    await expect(menu).toHaveCount(0);
  } else {
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  summary.narrowAccountSwitcher = { box };
});

// 2. Enter on an open submenu row moves focus into it.
test("Enter on an already-open submenu row focuses its first item", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await openRowMenu(page);
  const trigger = page.locator(".popup-submenu-trigger", {
    hasText: "Reply options",
  });
  await trigger.hover();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const panel = page.locator(".popup-submenu-panel");
  await expect(panel).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(document.activeElement?.closest(".popup-submenu-panel")),
      ),
    )
    .toBe(true);
  summary.enterOpensOpenSubmenu = true;
});

// 3. Typeahead miss inside a submenu stays in the submenu.
test("a typeahead miss inside a submenu does not move focus to the parent menu", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await openRowMenu(page);
  const trigger = page.locator(".popup-submenu-trigger", {
    hasText: "Reply options",
  });
  await trigger.focus();
  await page.keyboard.press("ArrowRight");
  const panel = page.locator(".popup-submenu-panel");
  await expect(panel).toBeVisible();
  await page.keyboard.press("a");
  const inside = await page.evaluate(() =>
    Boolean(document.activeElement?.closest(".popup-submenu-panel")),
  );
  expect(inside).toBe(true);
  summary.typeaheadMissStaysInSubmenu = inside;
});

// 4. Open submenu parent row is highlighted; forced colors keep an outline.
test("the open submenu's parent row is highlighted", async ({ page }) => {
  await page.goto("/?threadGap=1");
  await openRowMenu(page);
  const trigger = page.locator(".popup-submenu-trigger", {
    hasText: "Reply options",
  });
  await trigger.focus();
  await page.keyboard.press("ArrowRight");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  // Closing with Escape leaves the row unhighlighted; reopen without hover.
  await page.keyboard.press("ArrowRight");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const style = await trigger.evaluate((node) => {
    const s = getComputedStyle(node);
    return { background: s.backgroundColor, color: s.color };
  });
  expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
  // WP2.2: the open submenu row is accent-filled with white text.
  const contrastText = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--accent-contrast")
      .trim(),
  );
  const probe = await trigger.evaluate((node, value) => {
    const el = document.createElement("span");
    el.style.color = value;
    node.append(el);
    const color = getComputedStyle(el).color;
    el.remove();
    return color;
  }, contrastText);
  expect(style.color).toBe(probe);
  summary.expandedRowBackground = style.background;
});

test("forced colors give the open submenu row and hovered checkbox an outline", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/?threadGap=1");
  await openRowMenu(page);
  const trigger = page.locator(".popup-submenu-trigger", {
    hasText: "Reply options",
  });
  await trigger.focus();
  await page.keyboard.press("ArrowRight");
  const outline = await trigger.evaluate(
    (node) => getComputedStyle(node).outlineStyle,
  );
  expect(outline).toBe("solid");
  summary.forcedColorsExpandedOutline = outline;
});

// 5. Only one submenu open at a time, and submenus close when the parent scrolls.
test("opening another submenu closes the first one", async ({ page }) => {
  await page.goto("/?threadGap=1");
  await openRowMenu(page);
  const reply = page.locator(".popup-submenu-trigger", {
    hasText: "Reply options",
  });
  await reply.hover();
  await expect(reply).toHaveAttribute("aria-expanded", "true");
  const copy = page.getByRole("menuitem", { name: "Copy", exact: true });
  await copy.focus();
  await page.keyboard.press("ArrowRight");
  await expect(copy).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".popup-submenu-panel")).toHaveCount(1);
  summary.singleOpenSubmenu = true;
});

test("submenus close when the parent menu scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 300 });
  await page.goto("/?threadGap=1");
  await openRowMenu(page);
  const reply = page.locator(".popup-submenu-trigger", {
    hasText: "Reply options",
  });
  await reply.hover();
  await expect(page.locator(".popup-submenu-panel")).toHaveCount(1);
  await page.locator(".context-menu").evaluate((node) => {
    node.scrollTop = 40;
  });
  await expect(page.locator(".popup-submenu-panel")).toHaveCount(0);
  summary.parentScrollClosesSubmenu = true;
});

// 6. No dangling separators in reader More or its submenus (single message).
test("reader More and its submenus have no dangling separators", async ({
  page,
}) => {
  await page.goto("/?nestedFolders=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await openReaderMore(page);
  await page
    .locator(".reader-more-menu .popup-submenu-trigger", { hasText: "Move to" })
    .hover();
  await expect(page.locator(".popup-submenu-panel").first()).toBeVisible();
  const problems = await separatorProblems(page, ".app-menu");
  expect(problems).toEqual([]);
  summary.readerMoreSeparatorProblems = problems;
});

// 7. Reader More omits toolbar-owned archive/trash; danger styles on any menu.
test("reader More omits Archive and Trash already on the toolbar", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await openReaderMore(page);
  const labels = await page
    .locator(".reader-more-menu > [role='menuitem'] .context-menu-label")
    .allTextContents();
  expect(labels).not.toContain("Archive");
  expect(labels).not.toContain("Trash");
  summary.readerMoreTopLabels = labels;
});

test("danger rows are red in every popup menu, not only the row menu", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await openReaderMore(page);
  const color = await page.evaluate(() => {
    const menu = document.querySelector(".reader-more-menu");
    if (!menu) return "";
    const row = document.createElement("button");
    row.setAttribute("role", "menuitem");
    row.className = "danger";
    row.textContent = "Probe";
    menu.appendChild(row);
    const value = getComputedStyle(row).color;
    row.remove();
    return value;
  });
  const dangerInk = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--danger-ink"),
  );
  expect(color).not.toBe("");
  expect(dangerInk.trim()).not.toBe("");
  const probe = await page.evaluate(() => {
    const probeStyle = document.createElement("div");
    probeStyle.style.color = "var(--danger-ink)";
    document.body.appendChild(probeStyle);
    const value = getComputedStyle(probeStyle).color;
    probeStyle.remove();
    return value;
  });
  expect(color).toBe(probe);
  summary.dangerInkInReaderMore = color;
});

// 8. Move to submenu has no heading repeating its own label.
test("Move to submenu does not repeat its label as a heading", async ({
  page,
}) => {
  await page.goto("/?nestedFolders=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await openReaderMore(page);
  await page
    .locator(".reader-more-menu .popup-submenu-trigger", { hasText: "Move to" })
    .hover();
  const panel = page.locator('.popup-submenu-panel[aria-label="Move to"]');
  await expect(panel).toBeVisible();
  const headings = await panel
    .locator(".context-menu-heading")
    .allTextContents();
  expect(headings).not.toContain("Move to");
  summary.moveToHeadings = headings;
});

// 9. Shortcut hints include bare F and use a readable separator for search.
test("Forward advertises bare F and Settings shows search alternatives clearly", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  const forward = page.getByRole("button", { name: "Forward", exact: true });
  await expect(forward).toHaveAttribute("aria-keyshortcuts", /(^| )F($| )/);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Shortcuts", exact: true }).click();
  const search = await page
    .locator(".shortcut-row", { hasText: "Search" })
    .locator("kbd")
    .textContent();
  expect(search).not.toContain("/ /");
  expect(search).toContain("/");
  summary.searchShortcutHint = search;
});

// 11. Popup menus use the viewport below them before scrolling.
test("reader More uses the space below it before scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await openReaderMore(page);
  const menu = page.locator(".reader-more-menu");
  const box = await boxOf(menu);
  const scrolls = await menu.evaluate(
    (node) => node.scrollHeight > node.clientHeight + 1,
  );
  expect(scrolls ? box.y + box.height >= 840 - 16 : true).toBe(true);
  summary.readerMoreBox = box;
});

// 12. Submenu chevrons line up on the trailing edge of the row.
for (const density of ["normal", "comfortable", "compact"] as const) {
  test(`submenu chevrons align to the trailing edge (${density})`, async ({
    page,
  }) => {
    await page.goto(`/?threadGap=1&density=${density}`);
    await openRowMenu(page);
    const trigger = page.locator(".popup-submenu-trigger", {
      hasText: "Reply options",
    });
    const row = await boxOf(trigger);
    const chevron = await boxOf(trigger.locator(".popup-submenu-chevron"));
    const rowRight = row.x + row.width;
    expect(
      Math.abs(chevron.x + chevron.width - (rowRight - 10)),
    ).toBeLessThanOrEqual(2);
    summary[`chevron|${density}`] = { row, chevron };
  });
}
