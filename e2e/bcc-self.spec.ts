import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The preference starts off, so a new message has no Bcc line.
// 2. Turning it on puts this account on Bcc, and the address can be removed.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/bcc-self-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

test("a new message has no Bcc copy until the preference is on", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Bcc" })).toHaveCount(0);
  await page.getByRole("button", { name: "Save draft and close" }).click();

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Reading & Sending" }).click();
  const copy = page.getByRole("checkbox", { name: /Send a copy to myself/ });
  await copy.click();
  await expect(copy).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);

  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const bcc = page.getByRole("combobox", { name: "Bcc" });
  await expect(bcc).toHaveValue("sam@icloud.com");
  await bcc.fill("");
  await expect(bcc).toHaveValue("");
});
