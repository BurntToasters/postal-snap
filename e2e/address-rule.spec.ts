import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A recipient address starts a rule that matches To.
// 2. The rule is ready to file matching mail in Archive.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/address-rule-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("an address on the message can start a mail rule", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "Details" }).click();
  await page
    .locator("#message-details-panel .address-chip", {
      hasText: "sam@icloud.com",
    })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", {
      name: "Create rule for this address",
      exact: true,
    })
    .click();

  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings.getByLabel("Match by")).toHaveValue("to");
  await expect(settings.getByLabel("Text to match")).toHaveValue(
    "sam@icloud.com",
  );
  await expect(settings.getByLabel("Then")).toHaveValue("move_archive");
});
