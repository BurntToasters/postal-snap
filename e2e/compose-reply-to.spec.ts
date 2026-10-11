import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A new message starts with the account Reply-To address.
// 2. Clearing that field sends this message with no Reply-To address.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/compose-reply-to.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a message can leave off the account Reply-To address", async ({
  page,
}) => {
  await page.goto("/?accountReplyTo=1");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const field = page.getByRole("textbox", { name: "Reply-To" });
  await expect(field).toHaveValue("replies@example.com");
  await field.fill("");
  await page
    .getByRole("combobox", { name: "To", exact: true })
    .fill("jane@example.com");
  await page.getByRole("textbox", { name: "Subject" }).fill("Tonight");
  await page.getByLabel("Message body").pressSequentially("Hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".composer-window")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window.__POSTAL_SNAP_TEST__?.sentDraft as
              { replyTo?: string } | undefined
          )?.replyTo,
      ),
    )
    .toBe("");
});
