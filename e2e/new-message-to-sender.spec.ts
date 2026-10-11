import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The message menu starts a blank letter to the sender.
// 2. The open message menu does the same, with an empty subject.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/new-message-to-sender-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

async function expectBlankLetter(page: import("@playwright/test").Page) {
  await expect(
    page.getByRole("combobox", { name: "To", exact: true }),
  ).toHaveValue("jane@example.com");
  await expect(page.getByRole("textbox", { name: "Subject" })).toHaveValue("");
}

test("the message menu starts a new letter to the sender", async ({ page }) => {
  await page.goto("/");
  const row = page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }));
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "New message to sender" }).click();
  await expectBlankLetter(page);
});

test("the open message menu starts a new letter to the sender", async ({
  page,
}) => {
  await page.goto("/");
  const row = page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }));
  await row.click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "New message to sender" }).click();
  await expectBlankLetter(page);
});
