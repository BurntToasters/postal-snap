import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A link whose text is a different address says so before it opens.
// 2. The confirmation still names the real destination.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/link-text-address.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a different address in the link text is named before opening", async ({
  page,
}) => {
  await page.goto("/?mismatchLink=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  page.once("dialog", async (dialog) => {
    const text = dialog.message();
    expect(text).toContain("phish.example.test");
    expect(text).toContain(
      "The link text shows a different address: https://bank.example/login",
    );
    expect(text).not.toMatch(/\bSafe\b/);
    await dialog.accept();
  });
  await page
    .frameLocator('iframe[title="Message content"]')
    .getByRole("link", { name: "https://bank.example/login" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__POSTAL_SNAP_TEST__?.openedUrls ?? []),
    )
    .toEqual(["https://phish.example.test/login"]);
});
