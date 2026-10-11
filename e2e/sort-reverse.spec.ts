import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Subject order stays newest-first until Subject is chosen.
// 2. Z to A reverses that subject order, and Subject returns to A to Z.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/sort-reverse-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("Z to A lists subjects from the end of the alphabet", async ({ page }) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page
    .getByRole("menuitemradio", { name: "Subject", exact: true })
    .click();

  let options = page.getByRole("option");
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toHaveAccessibleName(/Library hours/i);
  await expect(options.nth(2)).toHaveAccessibleName(/Weekend plans/i);

  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await expect(
    page.getByRole("menuitemcheckbox", { name: "Z to A", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("menuitemcheckbox", { name: "Z to A", exact: true })
    .click();

  options = page.getByRole("option");
  await expect(options.nth(0)).toHaveAccessibleName(/Weekend plans/i);
  await expect(options.nth(1)).toHaveAccessibleName(/Older family note/i);
  await expect(options.nth(2)).toHaveAccessibleName(/Library hours/i);
  const calls = await page.evaluate(
    () => window.__POSTAL_SNAP_TEST__?.ipcCalls ?? [],
  );
  expect(
    calls.some(
      (call) =>
        call.command === "list_messages" && call.args.sort === "subjectDesc",
    ),
  ).toBe(true);

  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page
    .getByRole("menuitemradio", { name: "Subject", exact: true })
    .click();
  await expect(page.getByRole("option").nth(0)).toHaveAccessibleName(
    /Library hours/i,
  );
});
