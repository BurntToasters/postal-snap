import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. In dark mode, plain HTML mail glares as a white page.
// 2. Mail that sets its own colors is recolored and becomes unreadable.
// 3. Light mode stops showing mail on white.
// 4. Plain-text mail sits on a white page in dark mode.

test.beforeEach(async ({ page }) => installMockIpc(page));

async function frameBackground(page: Page) {
  await page.getByRole("option", { name: /Weekend plans/ }).click();
  const frame = page.frameLocator(".message-body iframe");
  await expect(frame.locator("body")).toBeVisible();
  return frame
    .locator("body")
    .evaluate((body) => getComputedStyle(body).backgroundColor);
}

test("plain HTML mail follows dark mode", async ({ page }) => {
  await page.goto("/?theme=dark");
  expect(await frameBackground(page)).not.toBe("rgb(255, 255, 255)");
  await page.screenshot({ path: "test-results/design-dark-plain-mail.png" });
});

test("mail with its own colors keeps its white page", async ({ page }) => {
  await page.goto("/?theme=dark&styledMail=1");
  expect(await frameBackground(page)).toBe("rgb(255, 255, 255)");
});

test("light mode shows mail on white", async ({ page }) => {
  await page.goto("/?theme=light");
  expect(await frameBackground(page)).toBe("rgb(255, 255, 255)");
});

test("plain-text mail follows dark mode", async ({ page }) => {
  await page.goto("/?theme=dark&plainOnly=1");
  await page.getByRole("option", { name: /Weekend plans/ }).click();
  const body = page.locator(".message-body");
  await expect(body).toContainText("Are we still meeting on Saturday?");
  expect(
    await body.evaluate((node) => getComputedStyle(node).backgroundColor),
  ).not.toBe("rgb(255, 255, 255)");
});
