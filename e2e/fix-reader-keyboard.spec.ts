import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifacts, attachArtifactsAfterEach, ipcCalls } from "./ipc";

test.afterEach(attachArtifactsAfterEach);

// Failure modes covered here:
// FM1. Mod+, pressed while the letter iframe has focus does not open Settings.
// FM2. e pressed in the letter does not archive the open message (no move_message archive IPC).
// FM3. Escape closes more than one layer, or none, from the More menu (wide) or the letter (narrow).
// FM4. Shift+Mod+P prints from the letter, or Mod+P (positive control) does not print.
// FM5. Mod+, while the composer is open opens Settings over it.
// FM6. Settings > Shortcuts drops or changes the Settings, text size or Print chords.
// FM7. Mod+= inside open Settings does not change the text size (it must, as before).

test.beforeEach(async ({ page }) => installMockIpc(page));

const letter = (page: Page) =>
  page.frameLocator(".message-body iframe").locator("body");

async function openWeekend(page: Page) {
  await page.goto("/?threadGap=1");
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await letter(page).click();
}

async function printCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__POSTAL_SNAP_TEST__?.printCalls ?? 0);
}

test("FM1: Mod+, from the letter opens Settings", async ({ page }) => {
  await openWeekend(page);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.locator(".settings-layer")).toBeVisible();
});

test("FM2: e from the letter archives the open message", async ({
  page,
}, testInfo: TestInfo) => {
  await openWeekend(page);
  await page.keyboard.press("e");
  await expect
    .poll(async () =>
      (await ipcCalls(page)).find((call) => call.command === "move_message"),
    )
    .toMatchObject({ command: "move_message", args: { role: "archive" } });
  await attachArtifacts(page, testInfo, "archive-from-letter");
});

test("FM3: Escape closes the More menu only, and the message stays open", async ({
  page,
}, testInfo: TestInfo) => {
  await openWeekend(page);
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.locator(".reader-more-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".reader-more-menu")).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await attachArtifacts(page, testInfo, "escape-one-layer");
});

test("FM3b: Escape in the narrow drawer closes one layer per press, from the letter too", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 800 });
  await page.goto("/?threadGap=1");
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.locator(".reader-more-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".reader-more-menu")).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  // The letter forwards Escape; the overlay reader then closes the message.
  await letter(page).click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeHidden();
});

test("FM4: Shift+Mod+P does not print, Mod+P does", async ({ page }) => {
  await openWeekend(page);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.waitForTimeout(600);
  expect(await printCount(page)).toBe(0);
  await page.keyboard.press("ControlOrMeta+p");
  await expect.poll(() => printCount(page)).toBe(1);
});

test("FM5: Mod+, while the composer is open does nothing", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.locator(".composer-layer")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+,");
  await page.waitForTimeout(300);
  await expect(page.locator(".settings-layer")).toHaveCount(0);
  await expect(page.locator(".composer-layer")).toBeVisible();
});

test("FM6: Settings > Shortcuts keeps the Settings, text size and Print chords", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/");
  const mac = await page.evaluate(
    () => document.documentElement.dataset.platform === "macos",
  );
  const expected = mac
    ? { settings: "⌘,", size: "⌘+ / ⌘-", print: "⌘P" }
    : { settings: "Ctrl+,", size: "Ctrl++ / Ctrl+-", print: "Ctrl+P" };
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Shortcuts" }).click();
  const rows = page.locator(".shortcut-row");
  await expect(rows.filter({ hasText: "Settings" }).first()).toContainText(
    expected.settings,
  );
  await expect(rows.filter({ hasText: "Text size" }).first()).toContainText(
    expected.size,
  );
  await expect(rows.filter({ hasText: "Print message" }).first()).toContainText(
    expected.print,
  );
  await attachArtifacts(page, testInfo, "settings-shortcuts-chords");
});

test("FM7: Mod+= inside open Settings increases text size", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/");
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.locator(".settings-layer")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+=");
  await expect
    .poll(async () => {
      const saves = (await ipcCalls(page)).filter(
        (call) => call.command === "save_settings",
      );
      const match = /"textScale":\s*([\d.]+)/.exec(
        JSON.stringify(saves.at(-1)?.args ?? {}),
      );
      return match ? Number(match[1]) : 0;
    })
    .toBeGreaterThan(1);
  await attachArtifacts(page, testInfo, "text-larger-in-settings");
});
