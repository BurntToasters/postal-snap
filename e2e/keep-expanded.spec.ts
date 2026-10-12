import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Leaving a folder closes a conversation you had opened.
// 2. A conversation you left closed opens on its own when you return.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/keep-expanded-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("an opened conversation stays open when you come back", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  const older = page.getByRole("treeitem", { name: /Older family note/i });
  await expect(older).toHaveCount(0);
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page.getByRole("menuitem", { name: "Expand conversations" }).click();
  await expect(older).toBeVisible();

  const folders = page.getByRole("navigation", { name: "Mailboxes" });
  await folders.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
  await folders.getByRole("button", { name: /^Inbox/ }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(older).toBeVisible();
});

test("a closed conversation stays closed when you come back", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  const older = page.getByRole("treeitem", { name: /Older family note/i });
  await expect(older).toHaveCount(0);
  const folders = page.getByRole("navigation", { name: "Mailboxes" });
  await folders.getByRole("button", { name: "Archive", exact: true }).click();
  await folders.getByRole("button", { name: /^Inbox/ }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(older).toHaveCount(0);
});
