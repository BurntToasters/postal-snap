import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A single row shows its size beside the date.
// 2. A conversation header shows the newest message size, and each loaded
//    message shows its own size.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/message-size-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a message row shows its size", async ({ page }) => {
  await page.goto("/");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await expect(row).toContainText("512 B");
  await expect(row).toHaveAccessibleName(/512 B/);
});

test("a conversation shows the newest size and each message size", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  const header = page.getByRole("treeitem", { name: /Weekend plans/i });
  await expect(header).toContainText("512 B");
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page.getByRole("menuitem", { name: "Expand conversations" }).click();
  await expect(
    page.getByRole("treeitem", { name: /Older family note/i }),
  ).toContainText("512 B");
  await expect(
    page.getByRole("treeitem", { name: /Library hours/i }),
  ).toContainText("512 B");
});
