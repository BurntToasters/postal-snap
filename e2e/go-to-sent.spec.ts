import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. An account without Sent says so.
// 2. Go to Sent opens that mailbox.
// 3. The action stays unavailable while Sent is already open.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/go-to-sent-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("says when the account has no Sent mailbox", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page.getByRole("menuitem", { name: "Go to Sent" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "This account does not have a Sent mailbox.",
  );
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
});

test("opens the Sent mailbox", async ({ page }) => {
  await page.goto("/?sentRow=1");
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page.getByRole("menuitem", { name: "Go to Sent" }).click();
  await expect(page.getByRole("heading", { name: "Sent" })).toBeVisible();
});

test("stays unavailable while Sent is open", async ({ page }) => {
  await page.goto("/?sentRow=1");
  await page.getByRole("button", { name: "Sent", exact: true }).click();
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Go to Sent" }),
  ).toBeDisabled();
});
