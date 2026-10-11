import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Closing a folder hides unread mail that is inside it.
// 2. Opening the folder keeps that unread count on the parent.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/collapsed-unread.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a closed folder keeps unread mail from inside it", async ({ page }) => {
  await page.goto("/?nestedFolders=1");
  await expect(
    page.getByRole("button", { name: "Projects", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Collapse Projects" }).click();
  const projects = page.getByRole("button", {
    name: "Projects, 2 unread in subfolders",
  });
  await expect(projects).toBeVisible();
  await expect(projects).toHaveAttribute("title", "2 unread in subfolders");
  await page.getByRole("button", { name: "Expand Projects" }).click();
  await expect(
    page.getByRole("button", { name: "Projects", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Collapse 2026" }).click();
  await expect(
    page.getByRole("button", { name: "Projects / 2026, 2 unread" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Projects / 2026 / Launch, 1 unread" }),
  ).toHaveCount(0);
});
