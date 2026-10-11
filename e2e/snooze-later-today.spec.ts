import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Later today is missing while 6 PM is still an hour away.
// 2. Later today stays available after 6 PM, or snoozes to the wrong hour.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-09T15:00:00") });
  await installMockIpc(page);
});

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/snooze-later-today.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a message can wait until later today", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Snooze", exact: true }).click();
  await page.getByRole("button", { name: "Later today" }).click();
  const snoozed = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__?.ipcCalls.find(
      (call) => call.command === "snooze_message",
    ),
  );
  const until = (snoozed?.args as { untilIso?: string } | undefined)?.untilIso;
  expect(until).toBeTruthy();
  expect(new Date(until ?? "").getHours()).toBe(18);
});

test("later today is unavailable in the evening", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-09T19:00:00"));
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Snooze", exact: true }).click();
  await expect(page.getByRole("button", { name: "Later today" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Tomorrow morning" }),
  ).toBeVisible();
});
