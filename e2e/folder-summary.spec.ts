import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A mailbox names its unread count and how many messages it holds.
// 2. A larger folder names the full total before you open it.
// 3. An empty mailbox leaves that note off.
// 4. A mailbox with no unread mail names only how many messages it holds.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/folder-summary-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a mailbox names how much mail it holds", async ({ page }) => {
  await page.goto("/");
  const folders = page.getByRole("navigation", { name: "Mailboxes" });
  await expect(folders.getByRole("button", { name: /^Inbox/ })).toHaveAttribute(
    "title",
    "Inbox, 1 unread, 1 item",
  );
  await expect(
    folders.getByRole("button", { name: "Archive", exact: true }),
  ).toHaveAttribute("title", "Archive");
  await expect(folders.getByRole("button", { name: /^Trash/ })).toHaveAttribute(
    "title",
    "Trash, 2 items",
  );
});

test("a partly loaded folder names its full total from the mailbox list", async ({
  page,
}) => {
  await page.goto("/?folderTotal=40");
  const folders = page.getByRole("navigation", { name: "Mailboxes" });
  await expect(folders.getByRole("button", { name: /^Inbox/ })).toHaveAttribute(
    "title",
    "Inbox, 1 unread, 40 items",
  );
});
