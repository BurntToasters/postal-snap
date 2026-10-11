import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A single message has no conversation forward.
// 2. Forward conversation quotes every loaded message, oldest first, with an
//    empty To field, and keeps the open message selected.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/forward-conversation-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a single message cannot forward a conversation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Forward conversation", exact: true }),
  ).toHaveCount(0);
});

test("forward conversation quotes every loaded letter and leaves To empty", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await page
    .getByRole("menuitem", { name: "Forward conversation", exact: true })
    .click();

  const dialog = page.getByRole("dialog", { name: "Forward", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Subject" })).toHaveValue(
    "Fwd: Weekend plans",
  );
  await expect(
    dialog.getByRole("combobox", { name: "To", exact: true }),
  ).toHaveValue("");
  const editor = dialog.locator(".composer-editor");
  await expect(editor).toContainText("Older family note");
  const letter = await editor.innerText();
  expect(letter.indexOf("Older family note")).toBeLessThan(
    letter.indexOf("Weekend plans"),
  );
  expect(letter).not.toContain("<script");
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  const fetched = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
      (call) => call.command === "get_message" && call.args.messageId === 9,
    ),
  );
  expect(fetched?.length).toBeGreaterThan(0);
});
