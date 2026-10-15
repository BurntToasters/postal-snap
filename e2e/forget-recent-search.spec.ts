import { mkdirSync } from "node:fs";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Removing one recent search leaves the others in the menu.
// 2. The removed search is the one sent to the app.
// 3. A mouse user cannot forget one recent search (P5).
// 4. The item hint omits right-click (P6); Shift+F10 opens nothing (P7).
// 5. Focus is lost after the forget, or Escape drops the search field (P8).
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/forget-recent-search.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("one recent search can be removed", async ({ page }) => {
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Search mail" });
  await search.fill("Picnic");
  await search.press("Enter");
  await search.fill("Budget");
  await search.press("Enter");
  await search.fill("");
  await search.blur();
  await search.focus();
  await search.press("ArrowDown");
  const picnic = page.getByRole("menuitem", { name: "Picnic", exact: true });
  await picnic.focus();
  await page.keyboard.press("Delete");
  await expect(
    page.getByRole("menuitem", { name: "Picnic", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Budget", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const call = window.__POSTAL_SNAP_TEST__?.ipcCalls.find(
          (entry) => entry.command === "forget_recent_search",
        );
        return call?.args.query;
      }),
    )
    .toBe("Picnic");
});

async function seed(page: Page) {
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Search mail" });
  for (const text of ["Picnic", "Budget", "Roadmap"]) {
    await search.fill(text);
    await search.press("Enter");
  }
  await search.fill("");
  await search.blur();
  await search.focus();
  return search;
}

const recent = (page: Page, name: string) =>
  page.getByRole("menuitem", { name, exact: true });

test("right-click forgets one recent search and keeps focus", async ({
  page,
}) => {
  const search = await seed(page);
  await expect(recent(page, "Budget")).toHaveAttribute(
    "title",
    /Right-click or press Delete/,
  );
  await recent(page, "Budget").click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Actions" });
  await expect(menu).toBeVisible();
  mkdirSync("artifacts/0.4.3", { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: "artifacts/0.4.3/recent-search-context-menu.png",
  });
  // Capturing blurs the window, which dismisses the menu; reopen it.
  if ((await menu.count()) === 0) {
    await recent(page, "Budget").click({ button: "right" });
  }
  await menu.getByRole("menuitem", { name: "Forget this search" }).click();
  await expect(recent(page, "Budget")).toHaveCount(0);
  await expect(recent(page, "Picnic")).toBeVisible();
  await expect(recent(page, "Roadmap")).toBeVisible();
  await expect(menu).toHaveCount(0);
  await expect(
    page.locator(".search-recent [role='menuitem']:focus"),
  ).toHaveCount(1);
  await expect(search).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__POSTAL_SNAP_TEST__?.ipcCalls
          .filter((entry) => entry.command === "forget_recent_search")
          .map((entry) => entry.args.query),
      ),
    )
    .toEqual(["Budget"]);
});

test("Shift+F10 opens the forget menu and Escape keeps the search", async ({
  page,
}) => {
  const search = await seed(page);
  await search.press("ArrowDown");
  const first = page.locator(".search-recent [role='menuitem']").first();
  await expect(first).toBeFocused();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Actions" });
  await expect(
    menu.getByRole("menuitem", { name: "Forget this search" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(first).toBeFocused();
  await expect(
    page.getByRole("menu", { name: "Recent searches" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).toBeFocused();
  expect(
    await page.evaluate(() =>
      window.__POSTAL_SNAP_TEST__?.ipcCalls.some(
        (entry) => entry.command === "forget_recent_search",
      ),
    ),
  ).toBe(false);
});

test("forgetting the last recent search returns focus to the field", async ({
  page,
}) => {
  const search = await seed(page);
  for (const name of ["Roadmap", "Budget"]) {
    await recent(page, name).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Forget this search" }).click();
  }
  await recent(page, "Picnic").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Forget this search" }).click();
  await expect(page.getByRole("menu", { name: "Recent searches" })).toHaveCount(
    0,
  );
  await expect(search).toBeFocused();
});
