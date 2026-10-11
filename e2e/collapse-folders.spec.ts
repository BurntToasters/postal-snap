import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Collapse folders hides every nested folder, and Expand folders shows them.
// 2. A mailbox list with no nested folders leaves those actions off.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/collapse-folders-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("collapse folders hides nested folders until they are expanded", async ({
  page,
}) => {
  await page.goto("/?nestedFolders=1");
  const nested = page.getByRole("button", {
    name: "Projects / 2026, 1 unread",
  });
  await expect(nested).toBeVisible();
  await page.getByRole("button", { name: "Collapse folders" }).click();
  await expect(nested).toHaveCount(0);
  await page.getByRole("button", { name: "Expand folders" }).click();
  await expect(nested).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Projects / 2026 / Launch, 1 unread" }),
  ).toBeVisible();
});

test("a mailbox without nested folders leaves those actions off", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Inbox" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Collapse folders" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Expand folders" }),
  ).toHaveCount(0);
});
