import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A single message has no conversation print.
// 2. Print conversation includes every loaded message, oldest first, and
//    keeps the open message on screen.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/print-conversation-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a single message cannot print a conversation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Print conversation", exact: true }),
  ).toHaveCount(0);
});

test.describe("macOS print", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  });

  test("print conversation keeps the open message and pages every loaded letter", async ({
    page,
  }) => {
    await page.goto("/?threadGap=1");
    await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
    await expect(
      page.getByRole("heading", { name: "Weekend plans" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "More actions" }).click();
    await page
      .getByRole("menuitem", { name: "Print conversation", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Weekend plans" }),
    ).toBeVisible();

    const frame = page.locator("body > .print-host iframe");
    await expect(frame).toHaveCount(1);
    const srcdoc = await frame.getAttribute("srcdoc");
    expect(srcdoc?.indexOf("Older family note")).toBeLessThan(
      srcdoc?.indexOf("Weekend plans") ?? -1,
    );
    expect(srcdoc).toContain("break-before:page");
    expect(srcdoc).not.toContain("<script");
    await expect
      .poll(() =>
        page.evaluate(() => window.__POSTAL_SNAP_TEST__?.printCalls ?? 0),
      )
      .toBe(1);
  });
});
