import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Marking a row read opens the message.
// 2. The row stays labeled unread after the click.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/list-read-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a listed message can be marked read without opening it", async ({
  page,
}) => {
  await page.goto("/");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await expect(row).toHaveAccessibleName(/Unread/i);
  await page
    .getByRole("button", {
      name: "Mark read",
      exact: true,
      includeHidden: true,
    })
    .click();
  await expect(row).not.toHaveAttribute("aria-selected", "true");
  await expect(row).not.toHaveAccessibleName(/Unread/i);
  await expect(
    page.getByRole("button", {
      name: "Mark unread",
      exact: true,
      includeHidden: true,
    }),
  ).toBeVisible();
});
