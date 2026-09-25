import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

test.beforeEach(async ({ page }) => installMockIpc(page));

test("localizes server folder roles and collapses nested folders", async ({
  page,
}) => {
  await page.goto("/?nestedFolders=1");

  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^INBOX/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Projects/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^2026/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Launch/ })).toBeVisible();

  await page.getByRole("button", { name: "Collapse Projects" }).click();
  await expect(page.getByRole("button", { name: /^2026/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Expand Projects" }).click();
  await expect(page.getByRole("button", { name: /^2026/ })).toBeVisible();
});
