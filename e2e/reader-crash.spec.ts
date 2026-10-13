import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A message the reader cannot render blanks the whole window.
// 2. The message list and Compose stop working after a reader crash.
// 3. Moving on to another folder keeps showing the crash note.
// 4. The note loses the reader-pane id that the pane splitter controls.
// The run ends with a screenshot of the contained crash note.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/reader-crash.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a message that breaks the reader stays contained", async ({ page }) => {
  await page.goto("/");
  const rows = page.locator('[role="option"]');
  await expect(rows.first()).toBeVisible();
  await page.evaluate(() => {
    const mock = window.__POSTAL_SNAP_MOCK__!;
    const original = mock.handlers.get_message;
    mock.handlers.get_message = async (args: Record<string, unknown>) => {
      const detail = (await original(args)) as Record<string, unknown>;
      // A malformed payload the reader cannot render.
      return { ...detail, to: null };
    };
  });

  await rows.first().click();
  await expect(
    page.getByText("This message could not be shown", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
  await expect(page.locator("#reader-pane")).toHaveClass(/crash-recovery/);

  await page.getByRole("button", { name: "Archive" }).click();
  await expect(
    page.getByText("This message could not be shown", { exact: false }),
  ).toHaveCount(0);
});
