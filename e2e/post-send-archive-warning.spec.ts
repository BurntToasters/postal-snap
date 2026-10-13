import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A scheduled send's archive warning survives a reload.
// 2. Retrying the warning archives only; it never calls an SMTP retry.
// 3. Saving a pending Sent copy can leave a separate archive retry behind.
// 4. A sent message cannot be discarded or restored as if it were unsent.
// Each test produces a screenshot artifact.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/post-send-archive-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a scheduled send keeps its archive warning after restart and retries filing only", async ({
  page,
}, testInfo) => {
  await page.goto("/?localMail=1&scheduled=1&scheduledPast=1&archiveWarning=1");
  await page.getByRole("button", { name: /^Outbox/ }).click();

  const row = page.locator('[data-state="archive_pending"]');
  await expect(row).toContainText("Message sent");
  await expect(row).toContainText("archive status needs attention");
  await expect(
    row.getByRole("button", { name: "Retry archive", exact: true }),
  ).toBeVisible();
  await expect(row.getByRole("button", { name: "Discard" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Retry sending" })).toHaveCount(
    0,
  );

  const screenshot = "test-results/post-send-archive-warning-persisted.png";
  await page.screenshot({ path: screenshot });
  await testInfo.attach("persisted archive warning", {
    path: screenshot,
    contentType: "image/png",
  });

  await page.reload();
  await page.getByRole("button", { name: /^Outbox/ }).click();
  const afterRestart = page.locator('[data-state="archive_pending"]');
  await expect(afterRestart).toContainText("Message sent");
  await expect(
    afterRestart.getByRole("button", { name: "Retry archive", exact: true }),
  ).toBeVisible();

  const beforeRetry = await page.evaluate(() => {
    const value = localStorage.getItem("postal-snap-e2e-archive-warning");
    return value ? JSON.parse(value) : null;
  });
  expect(beforeRetry.sendCount).toBe(1);

  await afterRestart
    .getByRole("button", { name: "Retry archive", exact: true })
    .click();
  await expect(page.locator('[data-state="archive_pending"]')).toHaveCount(0);

  const result = await page.evaluate(() => {
    const value = localStorage.getItem("postal-snap-e2e-archive-warning");
    const calls = window.__POSTAL_SNAP_TEST__?.ipcCalls ?? [];
    return {
      persisted: value ? JSON.parse(value) : null,
      archiveCalls: calls.filter(
        (call) => call.command === "retry_archive_after_send",
      ),
      smtpRetryCalls: calls.filter((call) => call.command === "retry_outbox"),
    };
  });
  expect(result.persisted.sendCount).toBe(1);
  expect(result.persisted.archiveRetryCount).toBe(1);
  expect(result.archiveCalls).toHaveLength(1);
  expect(result.archiveCalls[0]?.args.accountId).toBe("account-1");
  expect(result.smtpRetryCalls).toHaveLength(0);
});

test("a Sent-copy retry preserves a separate archive retry", async ({
  page,
}) => {
  await page.goto("/?localMail=1&sentCopy=1&sentCopyArchiveWarning=1");
  await page.getByRole("button", { name: /^Outbox/ }).click();
  const row = page.locator('[data-state="sent_copy_pending"]');
  await expect(row).toContainText("Message sent");

  await row.getByRole("button", { name: "Save Sent copy" }).click();
  const archiveRow = page.locator('[data-state="archive_pending"]');
  await expect(archiveRow).toContainText("Message sent");
  await expect(
    archiveRow.getByRole("button", { name: "Retry archive", exact: true }),
  ).toBeVisible();

  const calls = await page.evaluate(
    () => window.__POSTAL_SNAP_TEST__?.ipcCalls ?? [],
  );
  expect(
    calls.filter((call) => call.command === "retry_sent_copy"),
  ).toHaveLength(1);
  expect(calls.filter((call) => call.command === "retry_outbox")).toHaveLength(
    0,
  );
});

test("dismissing an archive warning never retries the sent message", async ({
  page,
}) => {
  await page.goto("/?localMail=1&scheduled=1&scheduledPast=1&archiveWarning=1");
  await page.getByRole("button", { name: /^Outbox/ }).click();
  const row = page.locator('[data-state="archive_pending"]');
  await expect(row).toContainText("Message sent");

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("The message was sent");
    void dialog.accept();
  });
  await row.getByRole("button", { name: "Dismiss warning" }).click();
  await expect(page.locator('[data-state="archive_pending"]')).toHaveCount(0);

  const result = await page.evaluate(() => {
    const value = localStorage.getItem("postal-snap-e2e-archive-warning");
    const calls = window.__POSTAL_SNAP_TEST__?.ipcCalls ?? [];
    return {
      persisted: value ? JSON.parse(value) : null,
      dismissCalls: calls.filter(
        (call) => call.command === "dismiss_archive_warning",
      ),
      smtpRetryCalls: calls.filter((call) => call.command === "retry_outbox"),
    };
  });
  expect(result.persisted.state).toBe("dismissed");
  expect(result.persisted.sendCount).toBe(1);
  expect(result.dismissCalls).toHaveLength(1);
  expect(result.smtpRetryCalls).toHaveLength(0);
});

test("archive actions stay visible at 200% text in both densities", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  for (const density of ["comfortable", "compact"] as const) {
    await page.goto(
      `/?localMail=1&scheduled=1&scheduledPast=1&archiveWarning=1&density=${density}&scale=2`,
    );
    await page.getByRole("button", { name: /^Outbox/ }).click();
    const row = page.locator('[data-state="archive_pending"]');
    await expect(row).toContainText("Message sent");
    const retry = row.getByRole("button", { name: "Retry archive" });
    const dismiss = row.getByRole("button", { name: "Dismiss warning" });
    await expect(retry).toBeVisible();
    await expect(dismiss).toBeVisible();
    for (const button of [retry, dismiss]) {
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(1180);
    }
    const screenshot = `test-results/post-send-archive-${density}-200.png`;
    await page.screenshot({ path: screenshot });
  }
  const persisted = await page.evaluate(() => {
    const value = localStorage.getItem("postal-snap-e2e-archive-warning");
    return value ? JSON.parse(value) : null;
  });
  expect(persisted.sendCount).toBe(1);
});
