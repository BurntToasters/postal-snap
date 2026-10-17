import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here (inventory B7, B8, G5):
// 1. The "?" overlay lists a shortcut that Settings does not, or omits one.
// 2. "?" typed into the search field or composer opens the overlay.
// 3. The overlay does not restore focus when closed.
// 4. The overlay clips at 200% text or in a narrow window.

test.beforeEach(async ({ page }) => installMockIpc(page));

const overlay = (page: Page) =>
  page.getByRole("dialog", { name: "Keyboard shortcuts" });

async function overlayRows(page: Page) {
  return page
    .locator(".shortcut-dialog .shortcut-row")
    .evaluateAll((rows) =>
      rows.map((row) => row.textContent?.replace(/\s+/g, " ").trim() ?? ""),
    );
}

async function settingsRows(page: Page) {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Shortcuts" }).click();
  return page
    .locator(".shortcut-row")
    .evaluateAll((rows) =>
      rows.map((row) => row.textContent?.replace(/\s+/g, " ").trim() ?? ""),
    );
}

test("? opens the overlay, lists the same entries as Settings, and closes with focus restored", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/");
  const invoker = page.getByRole("button", { name: "Get Mail", exact: true });
  await invoker.focus();
  await page.keyboard.press("?");
  await expect(overlay(page)).toBeVisible();
  await expect(
    overlay(page).getByRole("heading", {
      name: "Keyboard shortcuts",
      level: 2,
    }),
  ).toBeVisible();
  const fromOverlay = await overlayRows(page);
  expect(fromOverlay.length).toBeGreaterThan(20);
  await expect(overlay(page).getByText("Command palette")).toBeVisible();
  await attachArtifacts(page, testInfo, "shortcut-overlay-open");

  await page.keyboard.press("Escape");
  await expect(overlay(page)).toHaveCount(0);
  await expect(invoker).toBeFocused();

  // Both read the same registry; the overlay groups rows, so compare sets.
  const fromSettings = await settingsRows(page);
  expect([...fromOverlay].sort()).toEqual([...fromSettings].sort());
});

test("overlay groups entries by scope under named headings", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/");
  await page.keyboard.press("?");
  await expect(overlay(page)).toBeVisible();
  for (const name of ["General", "Message list", "Message", "Composer"]) {
    await expect(
      overlay(page).getByRole("heading", { name, level: 3, exact: true }),
    ).toBeVisible();
  }
  const scan = await new AxeBuilder({ page })
    .include(".shortcut-dialog")
    .analyze();
  expect(scan.violations).toEqual([]);
  await attachArtifacts(page, testInfo, "shortcut-overlay-groups");
});

test("? typed into the search field stays text", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/");
  const search = page.getByLabel("Search mail").first();
  await search.click();
  await page.keyboard.type("who?");
  await expect(search).toHaveValue("who?");
  await expect(overlay(page)).toHaveCount(0);
  await attachArtifacts(page, testInfo, "shortcut-overlay-search-field");
});

test("? typed into the composer body stays text", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const body = page.getByRole("textbox", { name: "Message body" });
  await body.click();
  await page.keyboard.type("Really?");
  await expect(body).toContainText("Really?");
  await expect(overlay(page)).toHaveCount(0);
  await attachArtifacts(page, testInfo, "shortcut-overlay-composer");
});

test("Keyboard shortcuts runs from the palette and restores focus on close", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/");
  const invoker = page.getByRole("button", { name: "Get Mail", exact: true });
  await invoker.focus();
  await page.keyboard.press("ControlOrMeta+K");
  await page
    .getByRole("combobox", { name: /Search commands/ })
    .fill("keyboard shortcuts");
  await page.keyboard.press("Enter");
  await expect(overlay(page)).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Command palette" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(invoker).toBeFocused();
  await attachArtifacts(page, testInfo, "shortcut-overlay-from-palette");
});

const densities = ["comfortable", "compact"] as const;
const scales = [1, 2] as const;

for (const density of densities) {
  for (const scale of scales) {
    test(`overlay fits a narrow window in ${density} density at ${scale * 100}% text`, async ({
      page,
    }, testInfo: TestInfo) => {
      await page.setViewportSize({ width: 420, height: 800 });
      await page.goto(`/?density=${density}&scale=${scale}`);
      await page.keyboard.press("?");
      const box = await overlay(page).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(420);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(overflow).toBe(false);
      const clipped = await page
        .locator(".shortcut-dialog .shortcut-row")
        .evaluateAll(
          (rows) =>
            rows.filter((row) => row.scrollWidth > row.clientWidth + 1).length,
        );
      expect(clipped).toBe(0);
      await attachArtifacts(
        page,
        testInfo,
        `shortcut-overlay-${density}-${scale * 100}`,
      );
    });
  }
}
