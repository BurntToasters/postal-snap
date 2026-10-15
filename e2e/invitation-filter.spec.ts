import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Invitations keeps the message that contains a calendar invitation.
// 2. A mailbox with none says so.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/invitation-filter-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("Invitations lists only mail with a calendar invitation", async ({
  page,
}) => {
  await page.goto("/?threadGap=1&invite=request");
  await expect(
    page.getByRole("treeitem", { name: /Library hours/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^More filters/ }).click();
  await page
    .getByRole("menuitemradio", { name: "Invitations", exact: true })
    .click();
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("treeitem", { name: /Library hours/i }),
  ).toHaveCount(0);
  const listed = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__?.ipcCalls.some(
      (call) =>
        call.command === "list_messages" && call.args.filter === "invitations",
    ),
  );
  expect(listed).toBe(true);
});

test("a mailbox without invitations says so", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^More filters/ }).click();
  await page
    .getByRole("menuitemradio", { name: "Invitations", exact: true })
    .click();
  await expect(page.getByText("No calendar invitations.")).toBeVisible();
});
