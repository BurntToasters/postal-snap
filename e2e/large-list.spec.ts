import { writeFileSync } from "node:fs";
import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Every row mounts at once, so long lists lag.
// 2. Rows outside the window drop out of the keyboard order or set size.
// 3. End and Home cannot reach rows that are not mounted.
// The run writes test-results/large-list.json and a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test("a 1500-message list mounts a window of rows and stays navigable", async ({
  page,
}, testInfo: TestInfo) => {
  const started = Date.now();
  await page.goto("/?hugeList=1500");
  const rows = page.getByRole("option");
  await expect(rows.first()).toBeVisible();
  const loadMs = Date.now() - started;

  // Only a window of rows is in the DOM; the set size still counts all 1500.
  const mounted = await page.locator(".message-list .message-row").count();
  expect(mounted).toBeGreaterThan(0);
  expect(mounted).toBeLessThan(120);
  await expect(rows.first()).toHaveAttribute("aria-setsize", "1500");

  await rows.first().focus();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("option", { name: /Archive note 1500/ }),
  ).toBeFocused();
  await expect(
    page.getByRole("option", { name: /Archive note 1500/ }),
  ).toHaveAttribute("aria-posinset", "1500");
  await page.keyboard.press("Home");
  await expect(
    page.getByRole("option", { name: /Archive note 1\b/ }),
  ).toBeFocused();

  const path = "test-results/large-list.png";
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
  writeFileSync(
    "test-results/large-list.json",
    JSON.stringify({ rows: 1500, mountedRows: mounted, loadMs }, null, 2),
  );
});
