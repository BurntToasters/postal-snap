import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Typing "/" in the search box jumps focus instead of typing.
// 2. macOS Ctrl+E (end of line) in a text field archives the open message.
// 3. macOS Ctrl+N / Ctrl+P (next / previous line) open a message or print.
// 4. The documented ⌘ shortcuts stop working on macOS.

test.beforeEach(async ({ page }) => installMockIpc(page));

test("types a slash into the search box", async ({ page }) => {
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Search mail" });
  await search.click();
  await page.keyboard.type("1/2");
  await expect(search).toHaveValue("1/2");
  await page.screenshot({ path: "test-results/shortcuts-search-slash.png" });
});

test("slash still focuses search from the message list", async ({ page }) => {
  await page.goto("/");
  await page.locator('[role="option"]').first().click();
  await page.keyboard.press("/");
  await expect(
    page.getByRole("searchbox", { name: "Search mail" }),
  ).toBeFocused();
});

test.describe("macOS text editing keys", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  });

  test("Control+E, N and P edit text instead of acting on mail", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator('[role="option"]').first().click();
    const search = page.getByRole("searchbox", { name: "Search mail" });
    await search.click();
    await page.keyboard.type("plans");
    await page.keyboard.press("Control+E");
    await page.keyboard.press("Control+N");
    await page.keyboard.press("Control+P");

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("body > .print-host")).toHaveCount(0);
    expect(await page.evaluate(() => window.__POSTAL_SNAP_TEST__?.moved)).toBe(
      false,
    );
    expect(
      await page.evaluate(() => window.__POSTAL_SNAP_TEST__?.printCalls),
    ).toBe(0);
    await expect(search).toHaveValue("plans");
  });

  test("Command shortcuts still work", async ({ page }) => {
    await page.goto("/");
    await page.locator('[role="option"]').first().click();
    await page.keyboard.press("Meta+E");
    await expect
      .poll(() => page.evaluate(() => window.__POSTAL_SNAP_TEST__?.moved))
      .toBe(true);
    await page.keyboard.press("Meta+N");
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});
