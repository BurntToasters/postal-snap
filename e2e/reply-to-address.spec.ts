import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Identity starts with a blank Reply-To address.
// 2. Saving one address is sent to the account and shown again.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/reply-to-address.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a Reply-To address is saved for mail from this account", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();
  await page.getByRole("button", { name: "Manage Sam", exact: true }).click();
  await page.getByRole("button", { name: "Identity", exact: true }).click();
  const input = page.getByLabel("Reply-To address");
  await expect(input).toHaveValue("");
  await input.fill("replies@example.com");
  await page.getByRole("button", { name: "Save Reply-To" }).click();
  await expect(page.getByText("Reply-To address saved.")).toBeVisible();
  await expect(input).toHaveValue("replies@example.com");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__POSTAL_SNAP_TEST__?.ipcCalls.find(
            (call) => call.command === "update_account_reply_to",
          )?.args.replyTo,
      ),
    )
    .toBe("replies@example.com");
});
