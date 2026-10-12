import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Reply without quoting still quotes the open message.
// 2. The reply subject or recipient is dropped.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/reply-without-quoting-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a reply can leave out the original message", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page
    .getByRole("menuitem", { name: "Reply without quoting", exact: true })
    .click();

  await expect(page.getByRole("textbox", { name: "Subject" })).toHaveValue(
    "Re: Weekend plans",
  );
  await expect(page.getByRole("combobox", { name: "To" })).toHaveValue(
    /jane@example.com/i,
  );
  await expect(
    page.getByRole("textbox", { name: "Message body" }),
  ).not.toContainText("Are we still meeting on Saturday?");
});
