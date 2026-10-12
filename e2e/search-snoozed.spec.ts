import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A search on Snoozed keeps the matching message and hides the other.
// 2. A search with no match says so, and clearing the search shows both messages.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/search-snoozed-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("search keeps the matching snoozed message", async ({ page }) => {
  await page.goto("/?snoozedList=1");
  await page.getByRole("button", { name: /^Snoozed/ }).click();
  await expect(page.getByText("Dentist reminder")).toBeVisible();
  await expect(page.getByText("Weekend plans")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search mail" }).fill("clinic");
  await expect(page.getByText("Dentist reminder")).toBeVisible();
  await expect(page.getByText("Weekend plans")).toHaveCount(0);
});

test("a search with no snoozed match can be cleared", async ({ page }) => {
  await page.goto("/?snoozedList=1");
  await page.getByRole("button", { name: /^Snoozed/ }).click();
  const search = page.getByRole("searchbox", { name: "Search mail" });
  await search.fill("zzzz");
  await expect(
    page.getByText("No snoozed messages match this search."),
  ).toBeVisible();
  await search.fill("");
  await expect(page.getByText("Dentist reminder")).toBeVisible();
  await expect(page.getByText("Weekend plans")).toBeVisible();
});
