import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A blocked remote image names its host before the pictures load.
// 2. A message without remote images does not name a host.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/remote-image-hosts-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a blocked picture names the site it would load from", async ({
  page,
}) => {
  await page.goto("/?remote=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(page.getByText("images.example.test")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load images", exact: true }),
  ).toBeVisible();
});

test("a message without remote pictures does not name an image site", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(page.getByText("images.example.test")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Load images" })).toHaveCount(
    0,
  );
});
