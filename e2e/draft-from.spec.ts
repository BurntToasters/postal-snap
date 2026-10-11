import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A draft sent from another address names that address in the drafts list.
// 2. A draft that uses the account address leaves that line off.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/draft-from-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a draft from another address names that address", async ({ page }) => {
  await page.goto("/?localMail=1&draftFrom=1");
  await page.getByRole("button", { name: /^Drafts/ }).click();
  const row = page.getByRole("button", { name: /Family update/ });
  await expect(row.locator(".draft-from")).toHaveText(
    "From: alias@example.com",
  );
  const search = page.getByRole("searchbox", { name: "Search mail" });
  await search.fill("alias@example.com");
  await expect(row).toBeVisible();
});

test("a draft from the account address leaves that line off", async ({
  page,
}) => {
  await page.goto("/?localMail=1&draftFrom=account");
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await expect(page.getByText("Family update")).toBeVisible();
  await expect(page.locator(".draft-from")).toHaveCount(0);
});
