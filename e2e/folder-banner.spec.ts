import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A Junk message says so and Not junk moves it to Inbox.
// 2. A Trash message says so and offers Move to Inbox.
// 3. An Inbox message leaves that note off.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/folder-banner-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

async function openWeekend(page: import("@playwright/test").Page) {
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
}

test("a Junk message can be moved back to Inbox", async ({ page }) => {
  await page.goto("/?inJunk=1");
  await openWeekend(page);
  await expect(page.getByText("This message is in Junk.")).toBeVisible();
  await page.getByRole("button", { name: "Not junk", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__POSTAL_SNAP_TEST__?.ipcCalls.find(
            (call) => call.command === "move_message_to_mailbox",
          )?.args,
      ),
    )
    .toMatchObject({ messageId: 10, destinationMailboxId: 1 });
});

test("a Trash message offers a move back to Inbox", async ({ page }) => {
  await page.goto("/?inTrash=1");
  await openWeekend(page);
  await expect(page.getByText("This message is in Trash.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Move to Inbox", exact: true }),
  ).toBeVisible();
});

test("an Inbox message leaves the folder note off", async ({ page }) => {
  await page.goto("/");
  await openWeekend(page);
  await expect(page.getByText("This message is in Junk.")).toHaveCount(0);
  await expect(page.getByText("This message is in Trash.")).toHaveCount(0);
});
