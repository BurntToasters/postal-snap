import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A draft's first line can be searched, and a miss says so.
// 2. A queued message's first line can be searched the same way.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/search-local-text-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a draft's first line can be searched", async ({ page }) => {
  await page.goto("/?localMail=1&draftPreview=1");
  await page.getByRole("button", { name: /^Drafts/ }).click();
  const search = page.getByRole("searchbox", { name: "Search mail" });
  await search.fill("Friday");
  await expect(page.getByText("Family update")).toBeVisible();
  await search.fill("zzzz");
  await expect(page.getByText("No drafts match this search.")).toBeVisible();
  await search.fill("");
  await expect(page.getByText("Family update")).toBeVisible();
});

test("a queued message's first line can be searched", async ({ page }) => {
  await page.goto("/?localMail=1&outboxPreview=1");
  await page.getByRole("button", { name: /^Outbox/ }).click();
  const search = page.getByRole("searchbox", { name: "Search mail" });
  await search.fill("notes");
  await expect(page.getByText("Could not confirm")).toBeVisible();
  await search.fill("zzzz");
  await expect(
    page.getByText("No queued messages match this search."),
  ).toBeVisible();
});
