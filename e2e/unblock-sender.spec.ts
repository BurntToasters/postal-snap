import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A sender with no Junk rule still offers Block sender.
// 2. Unblock sender removes that rule and leaves an Inbox message open.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/unblock-sender-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("an open sender can still be blocked", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Block sender", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Unblock sender", exact: true }),
  ).toHaveCount(0);
});

test("unblock sender removes the Junk rule", async ({ page }) => {
  await page.goto("/?blockedSender=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain(
      "Future messages from this sender can stay in Inbox.",
    );
    void dialog.accept();
  });
  await page
    .getByRole("menuitem", { name: "Unblock sender", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  const rules = await page.evaluate(
    () => window.__POSTAL_SNAP_TEST__?.rules ?? [],
  );
  expect(rules).toEqual([]);
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Block sender", exact: true }),
  ).toBeVisible();
});
