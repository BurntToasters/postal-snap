import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The subject rule form opens with this message's subject.
// 2. Match by is Subject, and the sender rule stays a separate action.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/subject-rule-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("create rule from subject fills the rule form", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page
    .getByRole("menuitem", { name: "Create rule from subject", exact: true })
    .click();

  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  await expect(settings.getByLabel("Match by")).toHaveValue("subject");
  await expect(settings.getByLabel("Text to match")).toHaveValue(
    "Weekend plans",
  );
  await expect(settings.getByLabel("Then")).toHaveValue("move_archive");
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
});
