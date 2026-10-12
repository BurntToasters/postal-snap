import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Quiet hours start blank, so alerts stay on.
// 2. Two different times are saved for the next new-mail alert.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/quiet-hours.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("quiet hours are saved for new-mail alerts", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Notifications" }).click();
  const from = page.getByLabel("From", { exact: true });
  const until = page.getByLabel("Until", { exact: true });
  await expect(from).toHaveValue("");
  await expect(until).toHaveValue("");
  await from.fill("22:00");
  await until.fill("07:00");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const saved = window.__POSTAL_SNAP_TEST__?.savedSettings ?? [];
        const last = saved.at(-1) as
          { quietHoursStart?: string; quietHoursEnd?: string } | undefined;
        return `${last?.quietHoursStart ?? ""}|${last?.quietHoursEnd ?? ""}`;
      }),
    )
    .toBe("22:00|07:00");
});
