import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Save as .eml is only available from the original-message dialog.
// 2. The save request includes a path or the wrong message.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/save-message-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("the open message can be saved as an eml file", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page
    .getByRole("menuitem", { name: "Save as .eml", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Original message" }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
            (call) => call.command === "save_message_eml",
          ) ?? [],
      ),
    )
    .toEqual([
      {
        command: "save_message_eml",
        args: { accountId: "account-1", messageId: 10 },
      },
    ]);
});
