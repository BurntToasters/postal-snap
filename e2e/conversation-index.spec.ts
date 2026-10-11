import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The open message hides the rest of the conversation.
// 2. Choosing another message in the list stays on the newest one.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/conversation-index.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("the open message lists the rest of the conversation", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  const list = page.getByRole("navigation", { name: "In this conversation" });
  await expect(
    list.getByRole("button", { name: /Weekend plans from Jane/ }),
  ).toHaveAttribute("aria-current", "true");
  await list
    .getByRole("button", { name: /Older family note from Jane/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Older family note" }),
  ).toBeVisible();
  await expect(
    list.getByRole("button", { name: /Older family note from Jane/ }),
  ).toHaveAttribute("aria-current", "true");
});
