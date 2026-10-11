import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

test.beforeEach(async ({ page }) => installMockIpc(page));

test("localizes server folder roles and collapses nested folders", async ({
  page,
}) => {
  await page.goto("/?nestedFolders=1");

  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^INBOX/ })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Projects", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Projects / 2026, 1 unread" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Projects / 2026 / Launch, 1 unread" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Collapse Projects" }).click();
  await expect(
    page.getByRole("button", { name: "Projects / 2026, 1 unread" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Expand Projects" }).click();
  await expect(
    page.getByRole("button", { name: "Projects / 2026, 1 unread" }),
  ).toBeVisible();
});
