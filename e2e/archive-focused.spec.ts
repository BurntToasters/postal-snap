import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. e archives the focused row and leaves the message closed.
// 2. The move is the Archive role for that message.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/archive-focused.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("e archives the focused message without opening it", async ({ page }) => {
  await page.goto("/");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await row.focus();
  await page.keyboard.press("e");
  await expect(row).toBeHidden();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__POSTAL_SNAP_TEST__?.ipcCalls.find(
            (call) => call.command === "move_message",
          )?.args,
      ),
    )
    .toMatchObject({ messageId: 10, role: "archive" });
});
