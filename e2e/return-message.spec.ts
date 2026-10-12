import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Leaving a folder and coming back reopens the message that was open.
// 2. Closing that message first leaves the folder without it when you return.
// 3. A message marked unread before leaving is reopened and silently marked read.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/return-message-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("coming back to a folder reopens the message you left open", async ({
  page,
}) => {
  await page.goto("/");
  const folders = page.getByRole("navigation", { name: "Mailboxes" });
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();

  await folders.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toHaveCount(0);

  await folders.getByRole("button", { name: /^Inbox/ }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
});

test("a message you closed stays closed when you come back", async ({
  page,
}) => {
  await page.goto("/?pane=hidden");
  const folders = page.getByRole("navigation", { name: "Mailboxes" });
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
  await page.getByRole("button", { name: "Close message" }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toHaveCount(0);

  await folders.getByRole("button", { name: "Archive", exact: true }).click();
  await folders.getByRole("button", { name: /^Inbox/ }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toHaveCount(0);
});

test("a message you marked unread is not reopened or marked read", async ({
  page,
}) => {
  await page.goto("/");
  const folders = page.getByRole("navigation", { name: "Mailboxes" });
  const row = page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }));
  await row.click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await expect(row).not.toHaveAccessibleName(/^Unread/);
  await row.click({ button: "right" });
  await page
    .getByRole("menu", { name: "Actions" })
    .getByRole("menuitem", { name: "Mark unread", exact: true })
    .click();
  await expect(row).toHaveAccessibleName(/^Unread/);

  await folders.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
  await folders.getByRole("button", { name: /^Inbox/ }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(row).toHaveAccessibleName(/^Unread/);
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toHaveCount(0);
});
