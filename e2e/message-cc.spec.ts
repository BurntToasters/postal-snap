import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Cc addresses show on the open message before Details is opened.
// 2. A message with no Cc leaves that line out.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/message-cc-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("copied recipients show before the details are opened", async ({
  page,
}) => {
  await page.goto("/?groupReply=1");
  const row = page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }));
  await row.click();
  const header = page.locator(".message-header");
  await expect(header.getByText("Cc:", { exact: true })).toBeVisible();
  await expect(header.getByText("pat@example.com")).toBeVisible();
  await expect(page.getByRole("button", { name: "Details" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("a message with no copied recipients leaves that line out", async ({
  page,
}) => {
  await page.goto("/");
  const row = page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }));
  await row.click();
  await expect(
    page.locator(".message-header").getByText("Cc:", { exact: true }),
  ).toHaveCount(0);
});
