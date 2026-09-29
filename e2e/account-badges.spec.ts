import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Unread badges show zero, or a count above 999 spills the layout.
// 2. Screen readers hear "12" with no meaning instead of "12 unread".
// 3. Refresh all accounts has no toolbar or keyboard path, or ignores
//    a partial failure.
// 4. Counts stay stale after a refresh instead of following the server.
// 5. Shift+F5 refreshes only one account, or F5 refreshes all of them.
// Each test attaches a screenshot and the recorded IPC calls.

test.beforeEach(async ({ page }) => installMockIpc(page));

type Call = { command: string; args: Record<string, unknown> };

function ipcCalls(page: Page): Promise<Call[]> {
  return page.evaluate(() => window.__POSTAL_SNAP_TEST__?.ipcCalls ?? []);
}

async function commandCount(page: Page, command: string) {
  return (await ipcCalls(page)).filter((call) => call.command === command)
    .length;
}

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/account-badges-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
  await testInfo.attach("ipc-calls.json", {
    body: JSON.stringify(await ipcCalls(page), null, 2),
    contentType: "application/json",
  });
});

test("badges show other-account unread with spoken counts", async ({
  page,
}) => {
  await page.goto("/?multiAccount=1");
  const trigger = page.locator(".account-switcher-trigger");
  await expect(trigger).toContainText("Sam");
  await expect(trigger.locator(".account-unread")).toHaveText(
    /^3\s*3 unread in other accounts$/,
  );
  await trigger.click();
  const work = page.getByRole("menuitem", { name: /Work.*3 unread/ });
  await expect(work).toBeVisible();
  await expect(work.locator(".account-unread [aria-hidden='true']")).toHaveText(
    "3",
  );
  await expect(
    page.getByRole("menuitem", { name: /Sam.*1 unread/ }),
  ).toBeVisible();
  expect(await commandCount(page, "get_account_inbox_counts")).toBeGreaterThan(
    0,
  );
});

test("badges hide at zero and cap the visible count", async ({ page }) => {
  await page.goto("/?multiAccount=1&badgeCounts=0,1200");
  const trigger = page.locator(".account-switcher-trigger");
  const badge = trigger.locator(".account-unread");
  await expect(badge.locator("[aria-hidden='true']")).toHaveText("999+");
  await expect(badge).toContainText("1200 unread in other accounts");
  await trigger.click();
  const menu = page.getByRole("menu", { name: "Email accounts" });
  await expect(menu.locator(".account-unread")).toHaveCount(1);
  await expect(
    menu.getByRole("menuitem", { name: /Sam/ }).locator(".account-unread"),
  ).toHaveCount(0);
});

test("all badges disappear when nothing is unread", async ({ page }) => {
  await page.goto("/?multiAccount=1&badgeCounts=0,0");
  await expect(page.locator(".account-switcher-trigger")).toBeVisible();
  await expect(page.locator(".account-unread")).toHaveCount(0);
});

test("toolbar menu refreshes every account and updates badges", async ({
  page,
}) => {
  await page.goto("/?multiAccount=1&syncAddsMail=1");
  const trigger = page.locator(".account-switcher-trigger");
  await expect(trigger.locator(".account-unread")).toContainText("3 unread");
  await page.getByRole("button", { name: "More ways to get mail" }).click();
  await page
    .getByRole("menuitem", { name: "Get mail for all accounts" })
    .click();
  await expect(trigger.locator(".account-unread")).toContainText(
    "5 unread in other accounts",
  );
  expect(await commandCount(page, "sync_all_accounts")).toBe(1);
  expect(await commandCount(page, "sync_account")).toBe(0);
});

test("toolbar menu is keyboard operable and closes on Escape", async ({
  page,
}) => {
  await page.goto("/?multiAccount=1");
  const more = page.getByRole("button", { name: "More ways to get mail" });
  await more.focus();
  await page.keyboard.press("Enter");
  const item = page.getByRole("menuitem", {
    name: "Get mail for all accounts",
  });
  await expect(item).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(item).toHaveCount(0);
  await expect(more).toBeFocused();
});

test("Shift+F5 refreshes all accounts and F5 only one", async ({ page }) => {
  await page.goto("/?multiAccount=1");
  await expect(page.locator(".account-switcher-trigger")).toBeVisible();
  await page.keyboard.press("F5");
  await expect.poll(() => commandCount(page, "sync_account")).toBe(1);
  expect(await commandCount(page, "sync_all_accounts")).toBe(0);
  await page.keyboard.press("Shift+F5");
  await expect.poll(() => commandCount(page, "sync_all_accounts")).toBe(1);
  expect(await commandCount(page, "sync_account")).toBe(1);
});

test("a partly failed refresh is reported plainly", async ({ page }) => {
  await page.goto("/?multiAccount=1&syncAllPartial=1");
  await page.keyboard.press("Shift+F5");
  await expect(page.getByRole("alert")).toContainText(
    "1 account could not be refreshed",
  );
});

test("single-account setups have no refresh-all menu", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Get Mail" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "More ways to get mail" }),
  ).toHaveCount(0);
  await expect(page.locator(".account-unread")).toHaveCount(0);
});
