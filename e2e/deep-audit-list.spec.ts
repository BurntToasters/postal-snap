import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

// Deep-audit follow-ups for the message list:
// 1. Selection mode keeps listbox semantics: the visual checkbox stays out
//    of the accessibility tree, so .message-list-items owns only options.
// 2. Mouse checkbox clicks, Shift-range clicks, and keyboard (x / Enter)
//    still update the bulk bar, asserted through accessible state.
// 3. Offline sidebar, command palette, and pane splitters meet contrast and
//    hit-target requirements in both themes.

test.beforeEach(async ({ page }) => installMockIpc(page));

async function enterSelectionMode(page: Page) {
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await expect(page.getByRole("toolbar", { name: /selected/i })).toBeVisible();
}

function selectedOptions(page: Page) {
  return page.locator('[role="option"][aria-selected="true"]');
}

const selectionAxeConfigs = [
  {
    name: "1280-comfortable-100",
    width: 1280,
    height: 800,
    density: "comfortable",
    scale: 1,
  },
  {
    name: "1280-compact-200",
    width: 1280,
    height: 800,
    density: "compact",
    scale: 2,
  },
  {
    name: "620-comfortable-200",
    width: 620,
    height: 800,
    density: "comfortable",
    scale: 2,
  },
] as const;

for (const { name, width, height, density, scale } of selectionAxeConfigs) {
  test(`selection mode has zero axe violations (${name})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.goto(`/?density=${density}&scale=${scale}`);
    await enterSelectionMode(page);
    // The listbox owns only options; the visual checkbox is decorative.
    await expect(
      page.locator(".message-list-items").getByRole("checkbox"),
    ).toHaveCount(0);
    const scan = await new AxeBuilder({ page })
      .include(".message-list-items")
      .analyze();
    expect(scan.violations).toEqual([]);
    await attachArtifacts(page, testInfo, `deep-audit-list-${name}`);
  });
}

test("checkbox click and Shift-range update the bulk bar", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?threadGap=1");
  await enterSelectionMode(page);
  const hits = page.locator(".message-select-hit");
  await hits.nth(0).click();
  await expect(page.getByRole("toolbar", { name: "1 selected" })).toBeVisible();
  await expect(selectedOptions(page)).toHaveCount(1);
  const checked = await page
    .locator(".message-select")
    .evaluateAll(
      (inputs) =>
        inputs.filter((input) => (input as HTMLInputElement).checked).length,
    );
  expect(checked).toBe(1);
  await hits.nth(2).click({ modifiers: ["Shift"] });
  await expect(page.getByRole("toolbar", { name: "3 selected" })).toBeVisible();
  await expect(selectedOptions(page)).toHaveCount(3);
  await attachArtifacts(page, testInfo, "deep-audit-list-shift-range");
});

test("keyboard selection still works (x key and row Enter)", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?threadGap=1");
  await enterSelectionMode(page);
  const rows = page.getByRole("option");
  await rows.nth(0).focus();
  await expect(rows.nth(0)).toBeFocused();
  await page.keyboard.press("x");
  await expect(page.getByRole("toolbar", { name: "1 selected" })).toBeVisible();
  await expect(rows.nth(0)).toHaveAttribute("aria-selected", "true");
  await rows.nth(1).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("toolbar", { name: "2 selected" })).toBeVisible();
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await rows.nth(0).focus();
  await page.keyboard.press("x");
  await expect(page.getByRole("toolbar", { name: "1 selected" })).toBeVisible();
  await expect(rows.nth(0)).toHaveAttribute("aria-selected", "false");
  await attachArtifacts(page, testInfo, "deep-audit-list-keyboard");
});

for (const theme of ["light", "dark"] as const) {
  test(`offline sidebar is clean for color-contrast (${theme})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/?offline=1&theme=${theme}`);
    await expect(
      page.getByRole("button", { name: "Connection", exact: true }),
    ).toBeVisible();
    const scan = await new AxeBuilder({ page })
      .include(".folder-pane")
      .withRules(["color-contrast"])
      .analyze();
    expect(scan.violations).toEqual([]);
    await attachArtifacts(page, testInfo, `deep-audit-list-offline-${theme}`);
  });

  test(`command palette is axe clean (${theme})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/?theme=${theme}`);
    await expect(
      page.getByRole("button", { name: "Get Mail", exact: true }),
    ).toBeVisible();
    // Match the platform the app reports, not the host OS (Playwright WebKit
    // reports macOS on Windows and would pick the wrong modifier).
    const modifier = await page.evaluate(() =>
      document.documentElement.dataset.platform === "macos"
        ? "Meta"
        : "Control",
    );
    await page.keyboard.press(`${modifier}+K`);
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();
    await expect(page.locator(".palette-option-hint").first()).toBeVisible();
    const scan = await new AxeBuilder({ page })
      .include(".palette-dialog")
      .analyze();
    expect(scan.violations).toEqual([]);
    await attachArtifacts(page, testInfo, `deep-audit-list-palette-${theme}`);
  });
}

test("pane splitter hit strip is at least 32px with a 5px visual line", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  for (const selector of [".folder-splitter", ".reader-splitter"]) {
    const splitter = page.locator(selector);
    await expect(splitter).toBeVisible();
    const hitWidth = await splitter.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element, "::before").width),
    );
    expect(hitWidth).toBeGreaterThanOrEqual(32);
    expect(await splitter.evaluate((element) => element.clientWidth)).toBe(5);
  }
  // Keyboard focus still shows the ring: Tab to the folder splitter and the
  // indicator pseudo-element must paint.
  const folderSplitter = page.locator(".folder-splitter");
  for (let tab = 0; tab < 80; tab += 1) {
    const focused = await folderSplitter.evaluate(
      (element) => element === document.activeElement,
    );
    if (focused) break;
    await page.keyboard.press("Tab");
  }
  await expect(folderSplitter).toBeFocused();
  await expect
    .poll(() =>
      folderSplitter.evaluate(
        (element) => getComputedStyle(element, "::after").backgroundColor,
      ),
    )
    .not.toBe("rgba(0, 0, 0, 0)");
});

test("splitter hit area does not block the folder rename action", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?nestedFolders=1");
  const splitter = page.locator(".folder-splitter");
  const hit = await splitter.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const before = Number.parseFloat(
      getComputedStyle(element, "::before").width,
    );
    const overhang = Math.max(0, (before - rect.width) / 2);
    return {
      left: rect.left - overhang,
      right: rect.right + overhang,
      top: rect.top,
      bottom: rect.bottom,
    };
  });
  expect(hit.right - hit.left).toBeGreaterThanOrEqual(32);
  const rename = page.getByRole("button", { name: "Rename folder Projects" });
  await page.locator(".folder-row", { hasText: "Projects" }).first().hover();
  await expect(rename).toBeVisible();
  const center = await rename.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  expect(
    center.x >= hit.left && center.x <= hit.right,
    "rename stays clear of the splitter hit strip",
  ).toBe(false);
  await rename.click();
  await expect(page.locator("form.folder-dialog input")).toBeVisible();
});
