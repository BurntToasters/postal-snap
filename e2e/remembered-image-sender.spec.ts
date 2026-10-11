import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A remembered sender's images load without a click in Inbox.
// 2. The same message in Junk does not auto-load; Load images still works.
// 3. A display name carrying a different address does not auto-load.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/remembered-image-sender-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

function remoteFetches(page: Page) {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __POSTAL_SNAP_TEST__: { remoteFetches: number };
        }
      ).__POSTAL_SNAP_TEST__.remoteFetches,
  );
}

test("a remembered sender loads images without a click in Inbox", async ({
  page,
}) => {
  await page.goto("/?remote=1&imageSender=jane@example.com");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect.poll(() => remoteFetches(page)).toBe(1);
  await expect(
    page.getByRole("button", { name: "Load images", exact: true }),
  ).toHaveCount(0);
});

test("a remembered sender does not auto-load images for a Junk message", async ({
  page,
}) => {
  await page.goto("/?remote=1&inJunk=1&imageSender=jane@example.com");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(page.getByText("This message is in Junk.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load images", exact: true }),
  ).toBeVisible();
  // Let any auto-load effect run before asserting that none did.
  await page.waitForTimeout(1000);
  expect(await remoteFetches(page)).toBe(0);
  await page.getByRole("button", { name: "Load images", exact: true }).click();
  await expect.poll(() => remoteFetches(page)).toBe(1);
});

test("a remembered sender does not auto-load when the display name shows another address", async ({
  page,
}) => {
  await page.goto("/?remote=1&nameConflict=1&imageSender=jane@example.com");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("button", { name: "Load images", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(1000);
  expect(await remoteFetches(page)).toBe(0);
});
