import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Copy selected text stays unavailable until a message is checked.
// 2. Copy selected text copies the checked messages, oldest first, and
//    leaves the unchecked mail out of the clipboard.
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
  const path = `test-results/copy-selection-text-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("copy selected text stays disabled until a message is checked", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Copy selected text", exact: true }),
  ).toBeDisabled();
});

test("copy selected text copies the checked messages oldest first", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("option", { name: /Library hours/i }).click();
  await page.getByRole("option", { name: /Older family note/i }).click();
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page
    .getByRole("menuitem", { name: "Copy selected text", exact: true })
    .click();

  await expect
    .poll(() => readClipboardText(page))
    .toBe(
      "Older family note\n\nAre we still meeting on Saturday?\n\nLibrary hours\n\nAre we still meeting on Saturday?",
    );
  const copied = await readClipboardText(page);
  expect(copied).not.toContain("Weekend plans");
  expect(copied).not.toContain("<p>");
  await expect(
    page.getByRole("toolbar", { name: /2 selected/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
});
