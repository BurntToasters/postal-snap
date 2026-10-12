import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A quiet-hours window that includes now is named beside the mailbox status.
// 2. A window that is still ahead stays off the status line.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/quiet-hours-status-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

async function setQuietHours(
  page: import("@playwright/test").Page,
  start: string,
  end: string,
) {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Notifications" }).click();
  await page.getByLabel("From", { exact: true }).fill(start);
  await page.getByLabel("Until", { exact: true }).fill(end);
  await page.getByRole("button", { name: "Close settings" }).click();
}

test("quiet hours show beside the mailbox status", async ({ page }) => {
  const now = new Date();
  const start = new Date(now.getTime() - 60 * 60 * 1000);
  const end = new Date(now.getTime() + 60 * 60 * 1000);
  const until = clock(end);
  await page.goto("/");
  await setQuietHours(page, clock(start), until);
  await expect(page.locator(".quiet-hours-status")).toHaveText(
    `Quiet hours until ${until}.`,
  );
});

test("a later quiet-hours window stays off the status line", async ({
  page,
}) => {
  const now = new Date();
  const start = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  await page.goto("/");
  await setQuietHours(page, clock(start), clock(end));
  await expect(page.locator(".quiet-hours-status")).toHaveCount(0);
  await expect(page.getByText("Mail is up to date")).toBeVisible();
});
