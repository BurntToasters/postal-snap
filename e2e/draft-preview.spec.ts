import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A draft with a first line shows that line in the drafts list.
// 2. A draft with no preview line does not invent one.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/draft-preview-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a draft list shows the first line of the message", async ({ page }) => {
  await page.goto("/?localMail=1&draftPreview=1");
  await page.getByRole("button", { name: /^Drafts/ }).click();
  const draft = page.getByRole("button", { name: /Family update/i });
  await expect(draft).toContainText("Seeing the family Friday.");
});

test("a draft with no written line leaves that space blank", async ({
  page,
}) => {
  await page.goto("/?localMail=1");
  await page.getByRole("button", { name: /^Drafts/ }).click();
  const draft = page.getByRole("button", { name: /Family update/i });
  await expect(draft).toBeVisible();
  await expect(draft).not.toContainText("Seeing the family Friday.");
});
