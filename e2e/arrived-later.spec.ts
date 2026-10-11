import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A message that reached the server hours after its date says so on the row.
// 2. A message whose arrival matches its date leaves that label off.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/arrived-later-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a late message says so in the list", async ({ page }) => {
  await page.goto("/?arrived=1");
  const row = page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }));
  await expect(row.locator(".message-arrived")).toHaveText("Arrived later");
  await expect(row).toHaveAccessibleName(/Arrived later/);
});

test("a message that arrived with its date leaves that label off", async ({
  page,
}) => {
  await page.goto("/");
  const row = page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }));
  await expect(row).toBeVisible();
  await expect(page.locator(".message-arrived")).toHaveCount(0);
});
