import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A short list date still shows, and pointing at it names the full time.
// 2. The open message keeps a short date and names the full time too.
// 3. A draft's short date names when it was saved.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/exact-message-time-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a short message date names the exact time", async ({ page }) => {
  await page.goto("/");
  const when = page.locator(".message-date").first();
  await expect(when).toBeVisible();
  const title = await when.getAttribute("title");
  expect(title).toMatch(/2026/);
  expect(title).toMatch(/August/i);
  expect(title).not.toBe((await when.textContent())?.trim());
  const row = page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }));
  await expect(row).toHaveAccessibleName(/August/i);

  await row.click();
  const headerTime = page.locator(".message-header time");
  await expect(headerTime).toHaveAttribute("title", /August/i);
  await expect(headerTime).toHaveAttribute("title", /2026/);
  await expect(headerTime).not.toHaveText(title ?? "");
});

test("a draft date names when the draft was saved", async ({ page }) => {
  await page.goto("/?localMail=1");
  await page.getByRole("button", { name: /^Drafts/ }).click();
  const when = page.locator(".local-mail-row time");
  await expect(when).toHaveAttribute("title", /2026/);
  await expect(when).toHaveAttribute("title", /August/i);
});
