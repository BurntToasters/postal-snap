import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// U1 Tab skips <summary> and the contenteditable composer body.
// U4-U7 folder toggle, recent searches, account radio, scope toggle.
// U10-U15 indent, titles, names, copy, setup completion text.
// Screenshots are written to artifacts/0.4.3/.

const dir = process.env.UI_ARTIFACT_DIR_043 ?? join("artifacts", "0.4.3");

test.beforeEach(async ({ page }) => {
  await installMockIpc(page);
  await mkdir(dir, { recursive: true });
});

const shot = (page: Page, name: string) =>
  page.screenshot({ animations: "disabled", path: join(dir, `${name}.png`) });

async function seedSearches(page: Page) {
  const search = page.getByRole("searchbox", { name: "Search mail" });
  for (const text of ["Picnic", "Budget", "Roadmap"]) {
    await search.fill(text);
    await search.press("Enter");
  }
  await search.fill("");
  await search.blur();
  await search.focus();
}

test("U1 Tab reaches the Credits summary", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByRole("tab", { name: "About" }).click();
  await page.getByRole("button", { name: "Licenses and credits" }).click();
  const dialog = page.getByRole("dialog", { name: "Licenses and credits" });
  await expect(dialog.locator("summary").first()).toBeVisible();
  let reached = false;
  for (let i = 0; i < 40 && !reached; i += 1) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(
      () => document.activeElement?.tagName === "SUMMARY",
    );
  }
  expect(reached).toBe(true);
});

test("U1 Tab reaches the composer body when trapped", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await page.getByRole("button", { name: "Maximize editor" }).click();
  await page.getByRole("button", { name: "Restore editor" }).focus();
  let reached = false;
  for (let i = 0; i < 60 && !reached; i += 1) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(
      () => document.activeElement?.getAttribute("contenteditable") === "true",
    );
  }
  expect(reached).toBe(true);
});

test("U4 U10 folder toggle and indent at 200% text", async ({ page }) => {
  await page.goto("/?nestedFolders=1&scale=2");
  const toggle = page.getByRole("button", { name: "Collapse Projects" });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const indent = await page
    .locator(".folder-tree-row")
    .nth(1)
    .evaluate((n) => parseFloat(getComputedStyle(n).paddingInlineStart));
  const nested = await page
    .locator(".folder-tree-row")
    .filter({ hasText: "2026" })
    .first()
    .evaluate((n) => parseFloat(getComputedStyle(n).paddingInlineStart));
  expect(Math.max(indent, nested)).toBeGreaterThan(16);
  await shot(page, "folder-tree-200");
  await toggle.click();
  const expand = page.getByRole("button", { name: "Expand Projects" });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
});

test("U5 recent searches follow the menu pattern", async ({ page }) => {
  await page.goto("/");
  await seedSearches(page);
  const search = page.getByRole("searchbox", { name: "Search mail" });
  const menu = page.getByRole("menu", { name: "Recent searches" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("button")).toHaveCount(0);
  const items = menu.getByRole("menuitem");
  const count = await items.count();
  await search.press("ArrowDown");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.nth(count - 1)).toBeFocused();
  await expect(items.nth(count - 1)).toHaveText("Clear recent searches");
  await page.keyboard.press("ArrowUp");
  await expect(items.nth(count - 2)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  await shot(page, "recent-searches");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(search).toBeFocused();
});

test("U5 Delete forgets the focused recent search", async ({ page }) => {
  await page.goto("/");
  await seedSearches(page);
  const menu = page.getByRole("menu", { name: "Recent searches" });
  await page.getByRole("searchbox", { name: "Search mail" }).press("ArrowDown");
  const name = (await page.evaluate(
    () => document.activeElement?.textContent,
  ))!;
  await page.keyboard.press("Delete");
  await expect(menu.getByRole("menuitem", { name, exact: true })).toHaveCount(
    0,
  );
});

test("U6 active account is a checked radio item", async ({ page }) => {
  await page.goto("/");
  await page.locator(".account-switcher-trigger").click();
  const active = page.getByRole("menuitemradio", { checked: true });
  await expect(active).toHaveCount(1);
  await expect(active.locator("svg.account-check")).toBeVisible();
  await expect(active.locator("strong")).toHaveAttribute("title", /.+/);
  await shot(page, "account-switcher");
});

test("U7 scope toggle keeps one name and flips aria-pressed", async ({
  page,
}) => {
  await page.goto("/");
  const scope = page.getByRole("button", { name: "All folders" });
  await expect(scope).toHaveAttribute("aria-pressed", "false");
  await scope.click();
  await expect(scope).toHaveAttribute("aria-pressed", "true");
  await expect(scope).toHaveAccessibleName("All folders");
});

test("U11 U12 titles on truncated text and icon buttons", async ({ page }) => {
  await page.goto("/?nestedFolders=1");
  await expect(
    page.getByRole("button", { name: /^(Hide|Show) mailboxes$/ }),
  ).toHaveAttribute("title", /mailboxes$/);
  await page.locator(".account-switcher-trigger").click();
  await expect(
    page.locator(".account-switcher-menu small[title]").first(),
  ).toBeVisible();
});

test("U12 U13 folder action names are consistent", async ({ page }) => {
  await page.goto("/?nestedFolders=1");
  await expect(
    page.getByRole("button", { name: /^Rename folder / }).first(),
  ).toHaveAttribute("title", /^Rename folder /);
  await expect(
    page.getByRole("button", { name: /^Delete folder / }).first(),
  ).toHaveAttribute("title", /^Delete folder /);
});

test("U14 copy uses US spelling and sentence case", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("On This Computer", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText("Cancelled", { exact: true })).toHaveCount(0);
});

test("U15 completed setup steps are announced", async ({ page }) => {
  await page.goto("/?firstRun=1");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const done = page.locator(".setup-flow-progress .done");
  await expect(done.first()).toBeAttached();
  await expect(done.first()).toContainText("completed");
  await shot(page, "setup-steps");
});
