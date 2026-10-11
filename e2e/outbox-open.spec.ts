import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Opening a queued message shows its letter and leaves it in Outbox.
// 2. A queued message with no text says so, and still stays in Outbox.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/outbox-open-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("opening a queued message leaves it in Outbox", async ({ page }) => {
  await page.goto("/?localMail=1");
  await page.getByRole("button", { name: /^Outbox/ }).click();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Could not confirm" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Please review")).toBeVisible();
  await expect(dialog.getByText("To: lee@example.com")).toBeVisible();
  await expect(dialog.getByText("notes.txt")).toBeVisible();
  const restored = await page.evaluate(
    () =>
      window.__POSTAL_SNAP_TEST__?.ipcCalls.some(
        (call) => call.command === "restore_outbox",
      ) ?? false,
  );
  expect(restored).toBe(false);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByText("Could not confirm")).toBeVisible();
  await expect(page.getByText("Needs attention")).toBeVisible();
});

test("a queued message with no text stays in Outbox", async ({ page }) => {
  await page.goto("/?localMail=1&emptyOutbox=1");
  await page.getByRole("button", { name: /^Outbox/ }).click();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Could not confirm" });
  await expect(dialog.getByText("This message has no text yet.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByText("Needs attention")).toBeVisible();
});
