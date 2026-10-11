import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Find next walks forward through two matches.
// 2. Find previous walks back and wraps to the last match.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/find-previous-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

async function selectedText(page: import("@playwright/test").Page) {
  return page.locator("iframe[title='Message content']").evaluate((frame) => {
    const doc = (frame as HTMLIFrameElement).contentDocument;
    return doc?.getSelection()?.anchorNode?.textContent ?? "";
  });
}

test("find previous walks back through matches in the open message", async ({
  page,
}) => {
  await page.goto("/?findTwice=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("heading", { name: "Weekend plans" }).click();
  await page.keyboard.press("Alt+Meta+f");
  const find = page.getByRole("textbox", { name: "Find in message" });
  await find.fill("Saturday");
  await find.press("Enter");
  await expect(page.getByText("1 of 2")).toBeVisible();
  await expect.poll(() => selectedText(page)).toContain("morning");

  await page.getByRole("button", { name: "Find next" }).click();
  await expect(page.getByText("2 of 2")).toBeVisible();
  await expect.poll(() => selectedText(page)).toContain("evening");

  await page.getByRole("button", { name: "Find previous" }).click();
  await expect(page.getByText("1 of 2")).toBeVisible();
  await expect.poll(() => selectedText(page)).toContain("morning");

  await find.press("Shift+Enter");
  await expect(page.getByText("2 of 2")).toBeVisible();
  await expect.poll(() => selectedText(page)).toContain("evening");
});
