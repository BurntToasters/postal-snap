import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A message with no files has no reply-with-attachments action.
// 2. An inline image alone does not count as a file.
// 3. Reply with attachments opens a reply that includes the file.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/reply-with-attachments-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a message without files cannot reply with attachments", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Reply with attachments", exact: true }),
  ).toHaveCount(0);
});

test("an inline image is not a file to reply with", async ({ page }) => {
  await page.goto("/?inline=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Reply with attachments", exact: true }),
  ).toHaveCount(0);
});

test("reply with attachments includes the file", async ({ page }) => {
  await page.goto("/?previewable=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await page
    .getByRole("menuitem", { name: "Reply with attachments", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Reply", exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "To", exact: true }),
  ).toHaveValue(/jane@example.com/);
  await expect(dialog.getByText("family.png")).toBeVisible();
  const prepared = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__?.ipcCalls.find(
      (call) => call.command === "prepare_reply_attachments",
    ),
  );
  expect(prepared?.args).toMatchObject({
    accountId: "account-1",
    messageId: 10,
  });
});
