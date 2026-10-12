import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A short mailbox list has no find field.
// 2. A long list can hide other mailboxes and open the match.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/find-mailbox.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a long mailbox list can find one folder", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("searchbox", { name: "Find a mailbox" }),
  ).toHaveCount(0);
  await page.goto("/?manyFolders=1");
  const find = page.getByRole("searchbox", { name: "Find a mailbox" });
  await expect(find).toBeVisible();
  await find.fill("Launch");
  await expect(page.getByRole("button", { name: /^Inbox/ })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Projects / Launch", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Projects / Launch", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: /^Inbox/ })).toBeVisible();
});
