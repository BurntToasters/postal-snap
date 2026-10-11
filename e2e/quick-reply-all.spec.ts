import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A message addressed only to you has no Reply all under the letter.
// 2. A note sent with Reply all includes the other recipients and the quote.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/quick-reply-all.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a note can reply to everyone on the message", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("button", { name: "Start reply to everyone" }),
  ).toHaveCount(0);
  await page.goto("/?groupReply=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  const box = page.getByRole("textbox", { name: "Write a reply" });
  const replyAll = page.getByRole("button", {
    name: "Start reply to everyone",
  });
  await expect(replyAll).toBeDisabled();
  await box.fill("See you then");
  await replyAll.click();
  await expect(
    page.getByRole("combobox", { name: "To", exact: true }),
  ).toHaveValue("jane@example.com");
  await expect(
    page.getByRole("combobox", { name: "Cc", exact: true }),
  ).toHaveValue("lee@example.com, pat@example.com");
  const body = page.locator(".composer-editor");
  await expect(body).toContainText("See you then");
  await expect(body).toContainText("Saturday");
  await expect(box).toHaveValue("");
});
