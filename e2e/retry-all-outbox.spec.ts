import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Two messages that need attention can be retried together after one confirmation.
// 2. Cancelling the confirmation leaves both messages in place.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/retry-all-outbox-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("retries every message that needs attention", async ({ page }) => {
  await page.goto("/?localMail=1&attentionPair=1");
  await page.getByRole("button", { name: /^Outbox/ }).click();
  await expect(page.getByText("Second unsent")).toBeVisible();
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("Retry 2 messages?");
    void dialog.accept();
  });
  await page.getByRole("button", { name: "Retry all" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const calls = window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
          (call) => call.command === "retry_outbox",
        );
        return calls?.map((call) => call.args.outboxId).sort();
      }),
    )
    .toEqual(["outbox-1", "outbox-2"]);
});

test("a cancelled retry leaves both messages in Outbox", async ({ page }) => {
  await page.goto("/?localMail=1&attentionPair=1");
  await page.getByRole("button", { name: /^Outbox/ }).click();
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("button", { name: "Retry all" }).click();
  await expect(page.getByText("Could not confirm")).toBeVisible();
  await expect(page.getByText("Second unsent")).toBeVisible();
  const retried = await page.evaluate(
    () =>
      window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
        (call) => call.command === "retry_outbox",
      ).length ?? 0,
  );
  expect(retried).toBe(0);
});
