import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A reply hides the earlier message until More is opened.
// 2. A message with no earlier message still offers the button.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/open-earlier-button-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a reply can open the earlier message from the letter", async ({
  page,
}) => {
  await page.goto("/?earlier=1");
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
  await page.getByRole("button", { name: "Open earlier message" }).click();
  await expect(
    page.getByRole("heading", { name: "Earlier note" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();
});

test("a message with no earlier message leaves that button off", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
  await expect(
    page.getByRole("button", { name: "Open earlier message" }),
  ).toHaveCount(0);
});
