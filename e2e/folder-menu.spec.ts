import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Get Mail on a folder checks that account and leaves the open folder in place.
// 2. Mark all read clears a folder that is not the open one.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/folder-menu-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("Get Mail on a folder checks that account", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  const before = await page.evaluate(
    () =>
      window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
        (call) => call.command === "sync_account",
      ).length ?? 0,
  );
  await page
    .getByRole("button", { name: "Archive", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Get Mail" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
            (call) => call.command === "sync_account",
          ).length,
      ),
    )
    .toBe(before + 1);
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
});

test("Mark all read clears a folder that is not open", async ({ page }) => {
  await page.goto("/?unreadArchive=1");
  const archive = page.getByRole("button", { name: /^Archive/ });
  await expect(archive).toContainText("2");
  await archive.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark all read" }).click();
  await expect(archive).not.toContainText("2");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__POSTAL_SNAP_TEST__?.ipcCalls.find(
            (call) => call.command === "mark_mailbox_read",
          )?.args.mailboxId,
      ),
    )
    .toBe(2);
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
});
