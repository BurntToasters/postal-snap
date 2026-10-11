import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A saved reply is named on the drafts list, and a search for that name keeps it.
// 2. A saved forward is named as a forward.
// 3. A new message leaves that line off.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/draft-kind-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a saved reply is named in Drafts", async ({ page }) => {
  await page.goto("/?localMail=1&replyDraft=reply");
  await page.getByRole("button", { name: /^Drafts/ }).click();
  const row = page.getByRole("button", { name: /Family update/ });
  await expect(row.locator(".draft-kind")).toHaveText("Unsent reply");
  await page
    .getByRole("searchbox", { name: "Search mail" })
    .fill("Unsent reply");
  await expect(row).toBeVisible();
});

test("a saved forward is named as a forward", async ({ page }) => {
  await page.goto("/?localMail=1&replyDraft=forward");
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await expect(page.locator(".draft-kind")).toHaveText("Unsent forward");
});

test("a new message leaves that line off", async ({ page }) => {
  await page.goto("/?localMail=1");
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await expect(page.getByText("Family update")).toBeVisible();
  await expect(page.locator(".draft-kind")).toHaveCount(0);
});
