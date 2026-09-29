import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Operator text is rewritten or dropped before it reaches the backend
//    (the Rust parser owns operators; the UI must pass the raw text).
// 2. The cached and server searches disagree on the query text.
// 3. A server-only body match is filtered out after the cached results.
// 4. The search tips popover cannot be opened or closed from the keyboard,
//    or Escape leaves focus lost.
// 5. The tips omit an operator the parser supports.
// Each test attaches a screenshot and the recorded IPC calls.

test.beforeEach(async ({ page }) => installMockIpc(page));

type Call = { command: string; args: Record<string, unknown> };

function ipcCalls(page: Page): Promise<Call[]> {
  return page.evaluate(() => window.__POSTAL_SNAP_TEST__?.ipcCalls ?? []);
}

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/search-operators-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
  await testInfo.attach("ipc-calls.json", {
    body: JSON.stringify(await ipcCalls(page), null, 2),
    contentType: "application/json",
  });
});

async function searchFor(page: Page, text: string) {
  const search = page.getByRole("searchbox", { name: "Search mail" });
  await search.fill(text);
  await search.press("Enter");
}

function queryTexts(calls: Call[], command: string) {
  return calls
    .filter((call) => call.command === command)
    .map((call) => (call.args.query as { text: string }).text);
}

test("operator text reaches cached and server search unchanged", async ({
  page,
}) => {
  const text = 'from:jane subject:"trip plans" is:unread before:2026-09-01';
  await page.goto("/");
  await searchFor(page, text);
  await expect(
    page.getByRole("option", { name: /Current mailbox/ }),
  ).toBeVisible();
  const calls = await ipcCalls(page);
  expect(queryTexts(calls, "search_cached_messages")).toEqual([text]);
  expect(queryTexts(calls, "search_server_messages")).toEqual([text]);
});

test("hostile search syntax is passed as plain text", async ({ page }) => {
  const text = 'a OR "b NEAR(x y) sender:* -c';
  await page.goto("/");
  await searchFor(page, text);
  await expect(
    page.getByRole("option", { name: /Current mailbox/ }),
  ).toBeVisible();
  const calls = await ipcCalls(page);
  expect(queryTexts(calls, "search_cached_messages")).toEqual([text]);
});

test("server-only body matches are listed after an empty cache", async ({
  page,
}) => {
  await page.goto("/");
  await searchFor(page, "bodyonly words");
  await expect(
    page.getByRole("option", { name: /Server body match/ }),
  ).toBeVisible();
  expect(queryTexts(await ipcCalls(page), "search_cached_messages")).toContain(
    "bodyonly words",
  );
});

test("search tips open and close from the keyboard", async ({ page }) => {
  await page.goto("/");
  const tips = page.getByRole("button", { name: "Search tips", exact: true });
  await tips.focus();
  await page.keyboard.press("Enter");
  await expect(tips).toHaveAttribute("aria-expanded", "true");
  const panel = page.getByRole("region", { name: "Search tips" });
  await expect(panel).toBeVisible();
  for (const syntax of [
    "from:jane",
    "to:sam@example.com",
    'subject:"trip plans"',
    "has:attachment",
    "is:unread",
    "is:flagged",
    "after:2026-08-01",
    "before:2026-09-01",
  ]) {
    await expect(panel.getByText(syntax, { exact: true })).toBeVisible();
  }
  await page.screenshot({ path: "test-results/search-operators-tips.png" });
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(tips).toBeFocused();
  await expect(tips).toHaveAttribute("aria-expanded", "false");
});

test("search tips close from the Close button and outside clicks", async ({
  page,
}) => {
  await page.goto("/");
  const tips = page.getByRole("button", { name: "Search tips", exact: true });
  await tips.click();
  const panel = page.getByRole("region", { name: "Search tips" });
  await panel.getByRole("button", { name: "Close search tips" }).click();
  await expect(panel).toHaveCount(0);
  await expect(tips).toBeFocused();
  await tips.click();
  await expect(panel).toBeVisible();
  await page.mouse.click(5, 300);
  await expect(panel).toHaveCount(0);
});
