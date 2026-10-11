import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A conversation with two senders names only the newest one.
// 2. A conversation with one sender repeats that name.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/conversation-people-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a conversation names each person in it", async ({ page }) => {
  await page.goto("/?threadGap=1&threadPeople=1");
  await expect(
    page.getByRole("treeitem", { name: /Conversation, Jane, Lee/i }),
  ).toBeVisible();
});

test("a conversation with one sender names that sender once", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  const header = page.getByRole("treeitem", {
    name: /Conversation, Jane, jane@example.com/i,
  });
  await expect(header).toBeVisible();
  await expect(header).not.toHaveAccessibleName(/Lee/);
});
