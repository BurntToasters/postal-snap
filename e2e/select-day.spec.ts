import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A day heading selects the loaded messages grouped under it.
// 2. A conversation stays together under its newest day, and another day stays unchecked.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/select-day-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a day heading selects that message", async ({ page }) => {
  await page.goto("/");
  await page.locator("button.list-day").click();
  await expect(page.getByRole("toolbar", { name: "1 selected" })).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Select Weekend plans" }),
  ).toBeChecked();
});

test("a day heading selects the conversation and leaves the other day", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await page.locator("button.list-day").first().click();
  await expect(page.getByRole("toolbar", { name: "2 selected" })).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Select Weekend plans" }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Select Older family note" }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Select Library hours" }),
  ).not.toBeChecked();
});
