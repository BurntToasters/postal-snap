import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Removing one recent search leaves the others in the menu.
// 2. The removed search is the one sent to the app.
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
  await page
    .getByRole("button", { name: "Remove “Picnic” from recent searches" })
    .click();
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
