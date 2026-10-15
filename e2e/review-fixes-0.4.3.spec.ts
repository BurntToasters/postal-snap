import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// V1. A failed channel save still discards the downloaded update.
// V2. The account switcher menu ignores arrow keys, Home/End and Tab-out.
// Artifacts: artifacts/0.4.3/review-fixes/*.

test.beforeEach(async ({ page }) => installMockIpc(page));

const artifactDir = "artifacts/0.4.3/review-fixes";

function updateCalls(page: Page) {
  return page.evaluate(() => window.__POSTAL_SNAP_TEST__?.updateCalls ?? []);
}

test("a failed channel save keeps the downloaded update", async ({ page }) => {
  await page.goto("/?update=1&failChannelSave=1");
  const ready = page.getByRole("button", {
    name: "Update Ready · Click to Restart",
  });
  await expect(ready).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Advanced" }).click();
  const picker = page.getByRole("combobox", { name: "Update channel" });
  await picker.selectOption("beta");
  await expect(picker).toHaveValue("auto");
  await page.keyboard.press("Escape");
  await expect(ready).toBeVisible();
  const readyFlags = (await updateCalls(page))
    .filter((call) => call.command === "set_update_ready")
    .map((call) => call.args.ready);
  expect(readyFlags).not.toContain(false);
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    `${artifactDir}/failed-channel-save-calls.json`,
    JSON.stringify(await updateCalls(page), null, 2),
  );
});

test("account switcher menu supports arrow keys and Tab-out", async ({
  page,
}) => {
  await page.goto("/?multiAccount=1");
  await page.getByRole("button", { name: /Sam.*sam@icloud\.com/i }).click();
  const menu = page.getByRole("menu", { name: "Email accounts" });
  const radios = menu.getByRole("menuitemradio");
  await radios.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(radios.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(radios.first()).toBeFocused();
  await page.keyboard.press("End");
  const last = menu.locator('[role="menuitem"], [role="menuitemradio"]').last();
  await expect(last).toBeFocused();
  await page.keyboard.press("Home");
  await expect(radios.first()).toBeFocused();
  mkdirSync(artifactDir, { recursive: true });
  await page.screenshot({ path: `${artifactDir}/account-menu-keyboard.png` });
  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
});
