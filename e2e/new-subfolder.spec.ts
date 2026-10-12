import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. New folder on a mailbox asks for a name inside that mailbox.
// 2. The created folder keeps the parent in its name.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/new-subfolder.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a new folder can be created inside another folder", async ({ page }) => {
  await page.goto("/?nestedFolders=1");
  await page
    .getByRole("button", { name: "Projects", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "New folder" }).click();
  await expect(page.getByText("New folder inside Projects")).toBeVisible();
  await page.getByPlaceholder("Folder name").fill("Notes");
  await page.getByRole("button", { name: "Create folder" }).click();
  await expect(
    page.getByRole("button", { name: "Projects / Notes", exact: true }),
  ).toBeVisible();
});
