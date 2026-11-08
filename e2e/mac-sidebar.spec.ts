import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifacts, attachArtifactsAfterEach } from "./ipc";

test.afterEach(attachArtifactsAfterEach);

// WP4.3 macOS source-list sidebar.
// FM1. Section titles are not keyboard toggles, or Enter/Space do not flip aria-expanded.
// FM2. The toggle's accessible name omits the section title.
// FM3. Collapse is lost on mailbox switch, or leaks across accounts.
// FM4. Selection is emphasized without pane focus, or not emphasized with focus.
// FM5. Folder or section targets are under 36px (Normal) or 44px (Comfortable), at 1x or 2x.
// FM6. Forced colors drop the selection boundary or the folder icon is not CanvasText.
// FM7. Vibrant mode paints the sidebar opaque.
// FM8. The narrow-window drawer does not open or close.

test.beforeEach(async ({ page }) => installMockIpc(page));

const ACCENT_DARK = "rgb(0, 104, 214)";

function sectionToggle(page: Page, title: string) {
  return page.getByRole("button", { name: title, exact: true });
}

function sectionBody(page: Page, id: string) {
  return page.locator(`#folder-section-${id}`);
}

async function bg(locator: ReturnType<Page["locator"]>) {
  return locator.evaluate((node) => getComputedStyle(node).backgroundColor);
}

test("FM1 section titles toggle with Enter and Space and hide their rows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.goto("/?nestedFolders=1");
  const toggle = sectionToggle(page, "Mailboxes");
  await toggle.focus();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(sectionBody(page, "mailboxes")).toBeHidden();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(sectionBody(page, "mailboxes")).toBeVisible();
  await expect(page.locator(".folder-tree-row").first()).toBeVisible();
  await toggle.click();
  await expect(page.locator(".folder-tree-row").first()).toBeHidden();
  await attachArtifacts(page, test.info(), "fm1-section-toggle");
});

test("FM2 the toggle name includes its section title", async ({ page }) => {
  await page.goto("/?nestedFolders=1");
  await expect(
    page.getByRole("button", { name: /On this computer/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Mailboxes/ }),
  ).toHaveAccessibleName(/Mailboxes/);
  await expect(
    page.getByRole("button", { name: "Mailboxes", exact: true }),
  ).toHaveAttribute("aria-controls", "folder-section-mailboxes");
});

test("FM3 collapse survives mailbox switches and is kept per account", async ({
  page,
}) => {
  await page.goto("/?multiAccount=1&nestedFolders=1");
  const trigger = page.locator(".account-switcher-trigger");
  await expect(trigger).toContainText("Sam");
  await sectionToggle(page, "Mailboxes").click();
  await expect(sectionBody(page, "mailboxes")).toBeHidden();
  await page
    .locator(".folder.local-nav, .folder")
    .filter({ hasText: "Drafts" })
    .first()
    .click();
  await expect(sectionBody(page, "mailboxes")).toBeHidden();
  await expect(sectionToggle(page, "Mailboxes")).toHaveAttribute(
    "aria-expanded",
    "false",
  );

  await trigger.click();
  await page.getByRole("menuitemradio", { name: /Work/ }).click();
  await expect(trigger).toContainText("Work");
  await expect(sectionToggle(page, "Mailboxes")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(sectionBody(page, "mailboxes")).toBeVisible();

  await trigger.click();
  await page.getByRole("menuitemradio", { name: /Sam/ }).click();
  await expect(trigger).toContainText("Sam");
  await expect(sectionToggle(page, "Mailboxes")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("FM4 selection is inactive until the folder pane holds focus", async ({
  page,
}) => {
  await page.goto("/?theme=dark");
  const active = page.locator(".folder.active").first();
  await expect(active).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  const idle = await bg(active);
  expect(idle).not.toBe(ACCENT_DARK);
  await expect(active.locator("span").first()).not.toHaveCSS(
    "color",
    "rgb(255, 255, 255)",
  );

  await active.focus();
  await expect(active).toHaveCSS("background-color", ACCENT_DARK);
  await expect(active).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(active.locator("svg")).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(active.locator("strong").first()).toHaveCSS(
    "color",
    "rgb(255, 255, 255)",
  );
  await attachArtifacts(page, test.info(), "fm4-emphasized-dark");
});

const TARGET_CASES = [
  { density: "normal", min: 36 },
  { density: "comfortable", min: 44 },
] as const;

for (const scale of [1, 2] as const) {
  test.describe(`targets at ${scale}x`, () => {
    test.use({ deviceScaleFactor: scale });
    for (const { density, min } of TARGET_CASES) {
      test(`FM5 folder and section targets reach ${min}px in ${density}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 1280, height: 840 });
        await page.goto(`/?nestedFolders=1&density=${density}`);
        await expect(page.locator(".folder").first()).toBeVisible();
        const heights = await page.evaluate(() => {
          const pick = (selector: string) =>
            Array.from(document.querySelectorAll<HTMLElement>(selector)).map(
              (node) => node.getBoundingClientRect().height,
            );
          return {
            folders: pick(".folder-pane .folder"),
            toggles: pick(".sidebar-section-toggle"),
          };
        });
        expect(heights.folders.length).toBeGreaterThan(0);
        expect(heights.toggles.length).toBeGreaterThan(0);
        for (const height of [...heights.folders, ...heights.toggles]) {
          expect(height).toBeGreaterThanOrEqual(min - 0.5);
        }
      });
    }
  });
}

test("FM6 forced colors keep a selection boundary and CanvasText icons", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/?nestedFolders=1");
  const active = page.locator(".folder.active").first();
  await expect(active).toBeVisible();
  await expect(active).toHaveCSS("outline-style", "solid");
  await expect(active).toHaveCSS("outline-width", "2px");
  const icon = await active.evaluate((node) => ({
    icon: getComputedStyle(node.querySelector("svg")!).color,
    text: getComputedStyle(node.querySelector("span")!).color,
  }));
  const rgbOnly = (color: string) =>
    color
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .join(",");
  expect(rgbOnly(icon.icon)).toBe(rgbOnly(icon.text));
  expect(icon.icon).not.toMatch(/0,\s*111,\s*201|0,\s*104,\s*214/);
});

test.describe("macOS vibrant sidebar", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
  });

  test("FM7 vibrant mode keeps the sidebar transparent", async ({ page }) => {
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto("/");
    await page.locator(".mail-shell").waitFor();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    await page.getByLabel("Translucent window background").check();
    await expect(page.locator("html")).toHaveAttribute(
      "data-window-fx",
      "vibrant",
    );
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator(".folder-pane")).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
  });
});

test("FM8 the narrow-window drawer opens and closes", async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 800 });
  await page.goto("/?nestedFolders=1");
  const toggle = page.getByRole("button", { name: /^(Show|Hide) mailboxes$/ });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.locator(".mail-shell.sidebar-open")).toBeVisible();
  await page.locator(".sidebar-mobile-header button").click();
  await expect(page.locator(".mail-shell.sidebar-open")).toHaveCount(0);
});

for (const theme of ["light", "dark"] as const) {
  for (const density of ["normal", "comfortable", "compact"] as const) {
    test(`artifacts: sidebar ${theme} ${density}`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 840 });
      await page.goto(`/?nestedFolders=1&theme=${theme}&density=${density}`);
      await expect(page.locator(".folder").first()).toBeVisible();
      await attachArtifacts(page, test.info(), `sidebar-${theme}-${density}`, {
        theme,
        density,
      });
    });
  }
}
