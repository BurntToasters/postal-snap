import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Cancel leaves the message in place and records no mute.
// 2. Confirm files the open message.
// 3. Unmute leaves the message and does not file it.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/mute-conversation-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("cancel does not mute the conversation", async ({ page }) => {
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Mute conversation" }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  const muted = await page.evaluate(
    () => window.__POSTAL_SNAP_TEST__?.muted ?? null,
  );
  expect(muted).toBeNull();
});

test("mute conversation files the open message", async ({ page }) => {
  page.once("dialog", (dialog) => dialog.accept());
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Mute conversation" }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toHaveCount(0);
  const muted = await page.evaluate(() => window.__POSTAL_SNAP_TEST__?.muted);
  expect(muted).toEqual({ accountId: "account-1", messageId: 10 });
});

test("unmute leaves the message in place", async ({ page }) => {
  await page.goto("/?conversationMuted=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Unmute conversation" }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  const state = await page.evaluate(() => ({
    muted: window.__POSTAL_SNAP_TEST__?.muted ?? null,
    unmuted: window.__POSTAL_SNAP_TEST__?.unmuted ?? null,
  }));
  expect(state.muted).toBeNull();
  expect(state.unmuted).toBe(10);
});
