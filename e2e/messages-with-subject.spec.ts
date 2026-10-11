import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The action searches the whole account.
// 2. Reply and forward prefixes stay off the query.
// The run ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/messages-with-subject.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("messages with this subject searches the whole account", async ({
  page,
}) => {
  await page.goto("/?subjectPrefix=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page
    .getByRole("menuitem", { name: "Messages with this subject" })
    .click();
  await expect(
    page.getByRole("searchbox", { name: "Search mail" }),
  ).toHaveValue('subject:"Weekend plans"');
  await expect(
    page.getByRole("button", { name: "This account" }),
  ).toHaveAttribute("aria-pressed", "true");
});
