import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Renaming a nested folder edits only its own name.
// 2. The folders above it stay, including a folder inside the renamed one.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/rename-nested-folder.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("renaming a nested folder keeps the folders above it", async ({
  page,
}) => {
  await page.goto("/?nestedFolders=1");
  // Nested rows use the context menu for Rename; inline actions are depth-0.
  await page
    .getByRole("button", { name: "Projects / 2026, 1 unread", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await expect(page.getByText("Inside Projects")).toBeVisible();
  const input = page.getByPlaceholder("Folder name");
  await expect(input).toHaveValue("2026");
  await input.fill("Notes");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Projects / Notes, 1 unread",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Projects / Notes / Launch, 1 unread",
      exact: true,
    }),
  ).toBeVisible();
});
