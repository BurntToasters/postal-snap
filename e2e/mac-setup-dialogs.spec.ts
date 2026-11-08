import type { Locator, Page, TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifacts, attachArtifactsAfterEach } from "./ipc";

test.afterEach(attachArtifactsAfterEach);

// Failure modes covered here (WP4.8):
// FM1. The setup card paints a gradient, lacks xl radius, or loses its window shadow.
// FM2. A modal scrim uses backdrop blur, or its color is not the theme's --scrim.
// FM3. Setup steps overflow horizontally or push Continue off a 620x540 window at 200% text.
// FM4. Focus escapes a confirm dialog on Tab, or Escape does not close it.
// FM5. Forced colors remove the card or dialog boundary.
// FM6. Reduced motion leaves transitions running on setup or dialog controls.
// FM7. Setup or a confirm dialog has serious or critical axe violations.

const DENSITIES = ["normal", "comfortable", "compact"] as const;
const THEMES = ["light", "dark"] as const;
const SETUP_VIEWPORT = { width: 620, height: 540 };
const DESKTOP_VIEWPORT = { width: 1280, height: 840 };

test.beforeEach(async ({ page }) => installMockIpc(page));

async function scrollWidths(page: Page) {
  return page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    const page = document.querySelector<HTMLElement>(".setup-page");
    return {
      root: root.scrollWidth - root.clientWidth,
      setupPage: page ? page.scrollWidth - page.clientWidth : 0,
    };
  });
}

async function computedBox(locator: Locator) {
  return locator.evaluate((node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return {
      backgroundImage: style.backgroundImage,
      backgroundColor: style.backgroundColor,
      backdropFilter: style.backdropFilter,
      radius: style.borderTopLeftRadius,
      shadow: style.boxShadow,
      borderStyle: style.borderTopStyle,
      borderWidth: style.borderTopWidth,
      borderColor: style.borderTopColor,
      right: rect.right,
      bottom: rect.bottom,
    };
  });
}

/** Resolved value of var(--scrim) in the current theme, as the browser computes it. */
async function resolvedScrim(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--scrim)";
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
}

async function advanceTo(page: Page, heading: string) {
  const continueButton = page.getByRole("button", {
    name: "Continue",
    exact: true,
  });
  const target = page.getByRole("heading", { name: heading });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await target.isVisible().catch(() => false)) return;
    await continueButton.click();
  }
  await expect(target).toBeVisible();
}

async function openMoveFolder(page: Page, query = "") {
  await page.goto(`/?nestedFolders=1${query ? `&${query}` : ""}`);
  await page
    .getByRole("button", { name: "Projects", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move folder" }).click();
  const dialog = page.getByRole("dialog", { name: "Move folder" });
  await expect(dialog).toBeVisible();
  return dialog;
}

function seriousViolations(
  results: Awaited<ReturnType<AxeBuilder["analyze"]>>,
) {
  return results.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact ?? ""),
  );
}

test("FM1: setup card is flat, xl radius, with a window shadow", async ({
  page,
}, testInfo: TestInfo) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.goto("/?firstRun=1");
  const card = await computedBox(page.locator(".setup-card.setup-flow"));
  expect(card.backgroundImage).toBe("none");
  expect(card.radius).toBe("16px");
  expect(card.shadow).not.toBe("none");
  await attachArtifacts(page, testInfo, "fm1-setup-card", { card });
});

test("FM2: scrims are theme-colored and never blurred", async ({
  page,
}, testInfo: TestInfo) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  for (const theme of THEMES) {
    await page.goto(`/?nestedFolders=1&theme=${theme}`);
    const dialog = await openMoveFolder(page, `theme=${theme}`);
    const overlay = dialog.locator("xpath=..");
    const scrim = await resolvedScrim(page);
    const style = await computedBox(overlay);
    expect(style.backdropFilter).toBe("none");
    expect(style.backgroundColor).toBe(scrim);
    expect(scrim).toBe(
      theme === "dark" ? "rgba(0, 0, 0, 0.4)" : "rgba(0, 0, 0, 0.2)",
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
  await page.goto("/?theme=light");
  await page.getByRole("button", { name: "Add account" }).click();
  const addAccount = page.getByRole("dialog", { name: "Add email account" });
  await expect(addAccount).toBeVisible();
  const backdrop = await computedBox(page.locator(".modal-backdrop"));
  expect(backdrop.backdropFilter).toBe("none");
  expect(backdrop.backgroundColor).toBe(await resolvedScrim(page));
  await attachArtifacts(page, testInfo, "fm2-scrim", { backdrop });
});

test("FM3: setup fits 620x540 at 200% text in every density", async ({
  page,
}, testInfo: TestInfo) => {
  await page.setViewportSize(SETUP_VIEWPORT);
  const results: Record<string, unknown> = {};
  for (const density of DENSITIES) {
    await page.goto(`/?firstRun=1&scale=2&density=${density}`);
    const steps = ["Choose how mail looks", "Choose your options"] as const;
    for (const heading of steps) {
      await advanceTo(page, heading);
      const widths = await scrollWidths(page);
      expect(widths.root).toBeLessThanOrEqual(0);
      expect(widths.setupPage).toBeLessThanOrEqual(0);
      const primary = await computedBox(
        page.locator(".setup-actions .primary-button").first(),
      );
      expect(primary.right).toBeLessThanOrEqual(SETUP_VIEWPORT.width);
      results[`${density}:${heading}`] = {
        widths,
        primaryRight: primary.right,
      };
    }
  }
  await attachArtifacts(page, testInfo, "fm3-setup-fit", { results });
});

test("FM4: Tab stays inside a confirm dialog and Escape closes it", async ({
  page,
}, testInfo: TestInfo) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const dialog = await openMoveFolder(page);
  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.press("Tab");
    const inside = await dialog.evaluate((node) =>
      node.contains(document.activeElement),
    );
    expect(inside).toBe(true);
  }
  await attachArtifacts(page, testInfo, "fm4-focus-trap");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("FM5: forced colors keep card and dialog boundaries visible", async ({
  page,
}, testInfo: TestInfo) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/?firstRun=1");
  const card = await computedBox(page.locator(".setup-card.setup-flow"));
  expect(card.borderStyle).toBe("solid");
  expect(parseFloat(card.borderWidth)).toBeGreaterThanOrEqual(1);

  const dialog = await openMoveFolder(page);
  const boundary = await computedBox(dialog);
  expect(boundary.borderStyle).toBe("solid");
  expect(parseFloat(boundary.borderWidth)).toBeGreaterThanOrEqual(1);
  await attachArtifacts(page, testInfo, "fm5-forced-colors", {
    card,
    boundary,
  });
});

test("FM6: reduced motion removes transitions on setup and dialogs", async ({
  page,
}, testInfo: TestInfo) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?firstRun=1");
  const setupDurations = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".setup-card *")].map(
      (node) => parseFloat(getComputedStyle(node).transitionDuration) || 0,
    ),
  );
  expect(Math.max(0, ...setupDurations)).toBeLessThanOrEqual(0.001);

  const dialog = await openMoveFolder(page);
  const dialogDurations = await dialog.evaluate((node) =>
    [node, ...node.querySelectorAll<HTMLElement>("*")].map(
      (item) => parseFloat(getComputedStyle(item).transitionDuration) || 0,
    ),
  );
  expect(Math.max(0, ...dialogDurations)).toBeLessThanOrEqual(0.001);
  await attachArtifacts(page, testInfo, "fm6-reduced-motion");
});

test("FM7: setup and confirm dialog have no serious axe violations", async ({
  page,
}, testInfo: TestInfo) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.goto("/?firstRun=1");
  const setup = await new AxeBuilder({ page })
    .include(".setup-card.setup-flow")
    .analyze();
  expect(seriousViolations(setup)).toEqual([]);

  await openMoveFolder(page);
  const confirm = await new AxeBuilder({ page })
    .include(".settings-confirm-card")
    .analyze();
  expect(seriousViolations(confirm)).toEqual([]);
  await attachArtifacts(page, testInfo, "fm7-axe");
});

for (const density of DENSITIES) {
  for (const theme of THEMES) {
    test(`screenshots: setup and confirm at ${density} ${theme}`, async ({
      page,
    }, testInfo: TestInfo) => {
      await page.setViewportSize(SETUP_VIEWPORT);
      await page.goto(`/?firstRun=1&density=${density}&theme=${theme}`);
      await advanceTo(page, "Choose how mail looks");
      await attachArtifacts(page, testInfo, `setup-${theme}-${density}`);

      await page.setViewportSize(DESKTOP_VIEWPORT);
      await openMoveFolder(page, `density=${density}&theme=${theme}`);
      await attachArtifacts(page, testInfo, `confirm-${theme}-${density}`);
    });
  }
}
