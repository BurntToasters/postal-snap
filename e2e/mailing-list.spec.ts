import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A message with a usable List-Post address shows the mailing list.
// 2. A message without one does not.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/mailing-list-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a mailing list message names the list", async ({ page }) => {
  await page.goto("/?listMail=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("note", { name: "Mailing list: list@example.test" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reply to list" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.getByText("Mailing list:", { exact: true })).toBeVisible();
});

test("an ordinary message does not name a mailing list", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(page.getByRole("note", { name: /Mailing list/i })).toHaveCount(
    0,
  );
});
