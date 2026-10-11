import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Oldest first keeps the newest-first list until it is chosen.
// 2. Oldest first lists loaded mail from earliest to latest, then Date
//    returns to newest first.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/oldest-first-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("oldest first lists earlier mail before later mail", async ({ page }) => {
  await page.goto("/?threadGap=1");
  await expect(
    page.getByRole("treeitem", { name: /Weekend plans/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "Oldest first", exact: true })
    .click();

  const options = page.getByRole("option");
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toHaveAccessibleName(/Older family note/i);
  await expect(options.nth(1)).toHaveAccessibleName(/Library hours/i);
  await expect(options.nth(2)).toHaveAccessibleName(/Weekend plans/i);
  const calls = await page.evaluate(
    () => window.__POSTAL_SNAP_TEST__?.ipcCalls ?? [],
  );
  expect(
    calls.some(
      (call) =>
        call.command === "list_messages" && call.args.sort === "dateOldest",
    ),
  ).toBe(true);

  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page.getByRole("menuitemradio", { name: "Date", exact: true }).click();
  await expect(
    page.getByRole("treeitem", { name: /Weekend plans/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: /Older family note/i }),
  ).toHaveCount(0);
});
