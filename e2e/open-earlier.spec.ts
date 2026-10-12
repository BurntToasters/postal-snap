import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A message with no earlier Message-ID hides the action.
// 2. A named earlier message that is not cached explains that.
// 3. A cached earlier message opens, including when it is in another folder.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/open-earlier-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a message with no earlier id hides the action", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Open earlier message" }),
  ).toHaveCount(0);
});

test("a missing earlier message stays on the open message", async ({
  page,
}) => {
  await page.goto("/?earlierMissing=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Open earlier message" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "That earlier message is not on this computer.",
  );
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
});

test("opens the earlier message in its folder", async ({ page }) => {
  await page.goto("/?earlier=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Open earlier message" }).click();
  await expect(
    page.getByRole("heading", { name: "Earlier note" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();
  await expect(
    page.getByRole("option", { name: /Earlier note/i }),
  ).toBeVisible();
});
