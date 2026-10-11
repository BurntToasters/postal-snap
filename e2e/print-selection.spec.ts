import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Print selected stays unavailable until a message is checked.
// 2. Print selected pages the checked messages, oldest first, and leaves
//    the unchecked mail on screen.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/print-selection-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("print selected stays disabled until a message is checked", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Print selected", exact: true }),
  ).toBeDisabled();
});

test.describe("macOS print", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  });

  test("print selected pages the checked messages oldest first", async ({
    page,
  }) => {
    await page.goto("/?threadGap=1");
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await page.getByRole("option", { name: /Library hours/i }).click();
    await page.getByRole("option", { name: /Older family note/i }).click();
    await page.getByRole("button", { name: "More mailbox actions" }).click();
    await page
      .getByRole("menuitem", { name: "Print selected", exact: true })
      .click();

    const frame = page.locator("body > .print-host iframe");
    await expect(frame).toHaveCount(1);
    const srcdoc = await frame.getAttribute("srcdoc");
    expect(srcdoc?.indexOf("Older family note")).toBeLessThan(
      srcdoc?.indexOf("Library hours") ?? -1,
    );
    expect(srcdoc).not.toContain("Weekend plans");
    expect(srcdoc).toContain("break-before:page");
    expect(srcdoc).not.toContain("<script");
    await expect(
      page.getByRole("option", { name: /Weekend plans/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("toolbar", { name: /2 selected/i }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => window.__POSTAL_SNAP_TEST__?.printCalls ?? 0),
      )
      .toBe(1);
  });
});
