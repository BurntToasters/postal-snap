import { writeFileSync } from "node:fs";
import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Off-screen rows still pay layout and paint, so long lists lag.
// 2. Skipped rows drop out of the accessibility tree or keyboard order.
// 3. End and Home cannot reach rows that were never painted.
// The run writes test-results/large-list.json and a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test("a 1500-message list skips off-screen work and stays navigable", async ({
  page,
}, testInfo: TestInfo) => {
  const started = Date.now();
  await page.goto("/?hugeList=1500");
  const rows = page.getByRole("option");
  await expect(rows).toHaveCount(1500);
  const loadMs = Date.now() - started;

  const lastWrap = page.locator(".message-row-wrap").last();
  expect(
    await lastWrap.evaluate((node) => getComputedStyle(node).contentVisibility),
  ).toBe("auto");

  await rows.first().focus();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("option", { name: /Archive note 1500/ }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(
    page.getByRole("option", { name: /Archive note 1\b/ }),
  ).toBeFocused();

  const path = "test-results/large-list.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
  writeFileSync(
    "test-results/large-list.json",
    JSON.stringify({ rows: 1500, loadMs, contentVisibility: "auto" }, null, 2),
  );
});
