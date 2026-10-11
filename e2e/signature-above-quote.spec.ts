import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The preference starts on, so the signature stays above quoted text.
// 2. Turning it off is saved for the next send.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/signature-above-quote.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("the signature can move to the end of a message", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Reading & Sending" }).click();
  const placement = page.getByRole("checkbox", {
    name: /Place signature above quoted text/,
  });
  await expect(placement).toBeChecked();
  await placement.click();
  await expect(placement).not.toBeChecked();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const saved = window.__POSTAL_SNAP_TEST__?.savedSettings ?? [];
        const last = saved.at(-1) as
          { signatureAboveQuote?: boolean } | undefined;
        return last?.signatureAboveQuote;
      }),
    )
    .toBe(false);
});
