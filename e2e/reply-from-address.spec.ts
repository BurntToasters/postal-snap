import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A reply uses the account address in To, even when another address was used last.
// 2. A reply uses an alias in Cc when To is someone else.
// 3. A message that names none of your addresses keeps the address used last.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/reply-from-address-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

async function reply(page: import("@playwright/test").Page) {
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
}

test("a reply uses the address the message was sent to", async ({ page }) => {
  await page.goto("/?fromAlias=1&lastFrom=work@example.com");
  await reply(page);
  await expect(
    page.getByRole("combobox", { name: "From address" }),
  ).toHaveValue("sam@icloud.com");
});

test("a reply uses an alias copied on the message", async ({ page }) => {
  await page.goto("/?fromAlias=1&lastFrom=sam@icloud.com&addressed=cc");
  await reply(page);
  await expect(
    page.getByRole("combobox", { name: "From address" }),
  ).toHaveValue("work@example.com");
});

test("a reply keeps the last address when the message names none of yours", async ({
  page,
}) => {
  await page.goto("/?fromAlias=1&lastFrom=work@example.com&addressed=none");
  await reply(page);
  await expect(
    page.getByRole("combobox", { name: "From address" }),
  ).toHaveValue("work@example.com");
});
