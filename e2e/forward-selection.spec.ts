import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Forward selected stays unavailable until a message is checked.
// 2. Forward selected quotes the checked messages, oldest first, and leaves
//    the unchecked mail out of the letter.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/forward-selection-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("forward selected stays disabled until a message is checked", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Forward selected", exact: true }),
  ).toBeDisabled();
});

test("forward selected quotes the checked messages oldest first", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("option", { name: /Library hours/i }).click();
  await page.getByRole("option", { name: /Older family note/i }).click();
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page
    .getByRole("menuitem", { name: "Forward selected", exact: true })
    .click();

  const dialog = page.getByRole("dialog", { name: "Forward", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Subject" })).toHaveValue(
    "Fwd: Library hours",
  );
  await expect(
    dialog.getByRole("combobox", { name: "To", exact: true }),
  ).toHaveValue("");
  const editor = dialog.locator(".composer-editor");
  await expect(editor).toContainText("Older family note");
  const letter = await editor.innerText();
  expect(letter.indexOf("Older family note")).toBeLessThan(
    letter.indexOf("Library hours"),
  );
  expect(letter).not.toContain("Weekend plans");
  expect(letter).not.toContain("<script");
  await expect(
    page.getByRole("toolbar", { name: /2 selected/i }),
  ).toBeVisible();
});
