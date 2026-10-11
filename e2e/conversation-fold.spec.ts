import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A mailbox with no conversation hides the fold actions.
// 2. Expand shows every loaded message, and collapse hides them again.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/conversation-fold-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a flat mailbox has no conversation fold actions", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Expand conversations" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Collapse conversations" }),
  ).toHaveCount(0);
});

test("expand and collapse show every loaded message in a conversation", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await expect(
    page.getByRole("treeitem", { name: /Older family note/i }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page.getByRole("menuitem", { name: "Expand conversations" }).click();
  await expect(
    page.getByRole("treeitem", { name: /Older family note/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page.getByRole("menuitem", { name: "Collapse conversations" }).click();
  await expect(
    page.getByRole("treeitem", { name: /Older family note/i }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("treeitem", { name: /Weekend plans/i }),
  ).toBeVisible();
});
