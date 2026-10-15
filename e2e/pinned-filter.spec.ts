import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Pinned shows only messages pinned on this computer.
// 2. A mailbox with no pins says so.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/pinned-filter-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("Pinned lists only pinned mail", async ({ page }) => {
  await page.goto("/?threadGap=1&pinned=1");
  await expect(
    page.getByRole("treeitem", { name: /Weekend plans/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^More filters/ }).click();
  await page
    .getByRole("menuitemradio", { name: "Pinned", exact: true })
    .click();
  await expect(
    page.getByRole("option", { name: /Library hours/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("treeitem", { name: /Weekend plans/i }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("option", { name: /Older family note/i }),
  ).toHaveCount(0);
  const listed = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__?.ipcCalls.some(
      (call) =>
        call.command === "list_messages" && call.args.filter === "pinned",
    ),
  );
  expect(listed).toBe(true);
});

test("Pinned says when the mailbox has no pins", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^More filters/ }).click();
  await page
    .getByRole("menuitemradio", { name: "Pinned", exact: true })
    .click();
  await expect(page.getByText("No pinned messages.")).toBeVisible();
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toHaveCount(0);
});
