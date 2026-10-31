import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A single message has no conversation copy.
// 2. Copy conversation text copies every loaded message, oldest first, and
//    keeps the open message on screen.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await installMockIpc(page);
});

async function readClipboardText(page: import("@playwright/test").Page) {
  return (await page.evaluate(() => navigator.clipboard.readText())).replace(
    /\r\n/g,
    "\n",
  );
}

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/copy-conversation-text-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a single message cannot copy a conversation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Copy conversation text", exact: true }),
  ).toHaveCount(0);
});

test("copy conversation text copies every loaded letter oldest first", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await page
    .getByRole("menuitem", { name: "Copy conversation text", exact: true })
    .click();

  await expect
    .poll(() => readClipboardText(page))
    .toBe(
      "Older family note\n\nAre we still meeting on Saturday?\n\nWeekend plans\n\nAre we still meeting on Saturday?",
    );
  const copied = await readClipboardText(page);
  expect(copied).not.toContain("Library hours");
  expect(copied).not.toContain("<p>");
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
});
