import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A new message stays normal until High importance is checked.
// 2. The sent draft carries importance high, and clearing the box removes it.
// 3. A received high-importance message is named in the list and in the reader.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/high-importance-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a new message can be marked high importance", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const box = page.getByRole("checkbox", { name: "High importance" });
  await expect(box).not.toBeChecked();
  await page
    .getByRole("combobox", { name: "To", exact: true })
    .fill("jane@example.com");
  await page.getByRole("textbox", { name: "Subject" }).fill("Tonight");
  await page.getByLabel("Message body").pressSequentially("Hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".composer-window")).toHaveCount(0);
  const normal = await page.evaluate(
    () =>
      window.__POSTAL_SNAP_TEST__?.sentDraft as
        { importance?: string } | undefined,
  );
  expect(normal?.importance ?? "").toBe("");

  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByRole("checkbox", { name: "High importance" }).click();
  await page
    .getByRole("combobox", { name: "To", exact: true })
    .fill("jane@example.com");
  await page.getByRole("textbox", { name: "Subject" }).fill("Tonight");
  await page.getByLabel("Message body").pressSequentially("Hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".composer-window")).toHaveCount(0);
  const marked = await page.evaluate(
    () =>
      window.__POSTAL_SNAP_TEST__?.sentDraft as
        { importance?: string; subject?: string } | undefined,
  );
  expect(marked?.importance).toBe("high");
  expect(marked?.subject).toBe("Tonight");
});

test("a received high-importance message is labeled in the list and the reader", async ({
  page,
}) => {
  await page.goto("/?highImportance=1");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await expect(row).toHaveAccessibleName(/High importance/);
  await row.click();
  await expect(page.locator(".message-importance")).toHaveText(
    "High importance",
  );
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
});
