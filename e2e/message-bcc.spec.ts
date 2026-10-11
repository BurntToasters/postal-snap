import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A hidden copy shows before Details is opened, and stays in Details.
// 2. A message without one does not show a Bcc row.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/message-bcc-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a hidden copy appears before the details are opened", async ({
  page,
}) => {
  await page.goto("/?bcc=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  const header = page.locator(".message-header");
  await expect(page.getByRole("button", { name: "Details" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(header.getByText("Bcc:", { exact: true })).toBeVisible();
  await expect(header.getByText("hidden@example.com")).toBeVisible();
  await page.getByRole("button", { name: "Details" }).click();
  const details = page.locator("#message-details-panel");
  await expect(details.getByText("Bcc:", { exact: true })).toBeVisible();
  await expect(details.getByText("hidden@example.com")).toBeVisible();
});

test("a message without a hidden copy leaves that row out", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.getByText("Bcc:", { exact: true })).toHaveCount(0);
});
