import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A "+" in a plus address turns into a space and breaks the address.
// 2. A capitalized field name (Subject=, CC=) is ignored.
// 3. An encoded "%" is decoded twice.
// The run ends with a screenshot of the prefilled composer.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const path = "test-results/mailto-link.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("mailto links keep plus addresses, any-case fields, and literal text", async ({
  page,
}) => {
  const link =
    "mailto:jane+family@example.test?CC=sam+club@example.test&Subject=C%2B%2B%20night&body=100%2525%20ready";
  await page.goto(`/?startupMailto=${encodeURIComponent(link)}`);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "To", exact: true }),
  ).toHaveValue(/jane\+family@example\.test/);
  await expect(
    dialog.getByRole("combobox", { name: "Cc", exact: true }),
  ).toHaveValue(/sam\+club@example\.test/);
  await expect(dialog.getByRole("textbox", { name: "Subject" })).toHaveValue(
    "C++ night",
  );
  await expect(
    dialog.getByRole("textbox", { name: "Message body" }),
  ).toContainText("100%25 ready");
});
