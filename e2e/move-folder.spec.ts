import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A folder can move under another folder, and the folders inside it follow.
// 2. The dialog leaves out the folder itself, its children, and where it already sits.
// 3. A nested folder can move back to the top of the list.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/move-folder-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a folder can move under another folder", async ({ page }) => {
  await page.goto("/?nestedFolders=1");
  await page
    .getByRole("button", { name: "Projects", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move folder" }).click();
  const dialog = page.getByRole("dialog", { name: "Move folder" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Top level" })).toHaveCount(
    0,
  );
  await expect(
    dialog.getByRole("button", { name: "Projects / 2026" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Archive / Projects", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Archive / Projects / 2026, 1 unread",
      exact: true,
    }),
  ).toBeVisible();
});

test("a nested folder can move to the top of the list", async ({ page }) => {
  await page.goto("/?nestedFolders=1");
  await page
    .getByRole("button", { name: "Projects / 2026, 1 unread" })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move folder" }).click();
  const dialog = page.getByRole("dialog", { name: "Move folder" });
  await expect(dialog.getByRole("button", { name: "Projects" })).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Projects / 2026 / Launch" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Top level" }).click();
  await expect(
    page.getByRole("button", { name: "2026 / Launch, 1 unread", exact: true }),
  ).toBeVisible();
});
