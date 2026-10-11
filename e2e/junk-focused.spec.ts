import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. An account without Junk says so and leaves the message in place.
// 2. ! marks the focused row as junk and leaves it closed.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/junk-focused-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("says when the account has no Junk mailbox", async ({ page }) => {
  await page.goto("/");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await row.focus();
  await page.keyboard.press("!");
  await expect(page.getByRole("alert")).toContainText(
    "This account does not have that folder.",
  );
  await expect(row).toBeVisible();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
});

test("! marks the focused message as junk without opening it", async ({
  page,
}) => {
  await page.goto("/?junkRow=1");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await row.focus();
  await page.keyboard.press("!");
  await expect(row).toBeHidden();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__POSTAL_SNAP_TEST__?.ipcCalls.find(
            (call) => call.command === "move_message",
          )?.args,
      ),
    )
    .toMatchObject({ messageId: 10, role: "junk" });
});
