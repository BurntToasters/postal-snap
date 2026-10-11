import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The reply box text is dropped when the composer opens.
// 2. The original letter is left out of the reply.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/quick-reply.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a note under the message starts the reply", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  const box = page.getByRole("textbox", { name: "Write a reply" });
  await box.fill("See you then");
  await page.getByRole("button", { name: "Start reply" }).click();
  const body = page.locator(".composer-editor");
  await expect(body).toContainText("See you then");
  await expect(body).toContainText("Saturday");
  await expect(box).toHaveValue("");
});
