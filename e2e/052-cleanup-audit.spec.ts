import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifactsAfterEach } from "./ipc";

test.afterEach(attachArtifactsAfterEach);

// Failure modes covered here:
// 1. Done setup steps paint the screen-reader "completed" word as a blue dot.
// 2. Setup actions fall below a short (812px) window instead of fitting.
// 3. The setup drag strip paints an opaque band over the page gradient.
// 4. Dark selected rows still use the old #0a84ff accent.
// 5. Dark primary controls keep a hard-to-read accent-contrast color.
// 6. Toolbar, title band, filter band, avatar, and size chip regrow.
// 7. The drag strip returns over setup or the selected row loses contrast.

const ARTIFACT_DIR = "artifacts/0.5.2/cleanup";

test.beforeEach(async ({ page }) => installMockIpc(page));

async function artifact(name: string, data: unknown) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(
    join(ARTIFACT_DIR, name),
    `${JSON.stringify(data, null, 2)}\n`,
  );
  return join(ARTIFACT_DIR, name);
}

async function shot(page: Page, name: string, fullPage = false) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const path = join(ARTIFACT_DIR, name);
  await page.screenshot({ path, fullPage });
  return path;
}

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  if (!value) throw new Error("Element has no layout box");
  return value;
}

async function insideViewport(page: Page, locator: Locator) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Test needs an explicit viewport");
  const value = await box(locator);
  return {
    fits:
      value.y >= 0 &&
      value.y + value.height <= viewport.height - 2 &&
      value.x >= 0 &&
      value.x + value.width <= viewport.width,
    box: value,
    viewport,
  };
}

async function hiddenStepWord(page: Page) {
  return page.evaluate(() => {
    const node = document.querySelector(
      ".setup-flow-progress .done .visually-hidden",
    );
    if (!node) return { present: false, width: 0, height: 0, hidden: false };
    const rect = node.getBoundingClientRect();
    return {
      present: true,
      width: rect.width,
      height: rect.height,
      hidden: rect.width <= 1 && rect.height <= 1,
    };
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

async function setupMetrics(page: Page, step: 2 | 3) {
  const hiddenWord = await hiddenStepWord(page);
  const back = await insideViewport(
    page,
    page.locator(".setup-actions.split .secondary-button"),
  );
  const next = await insideViewport(
    page,
    page.locator(".setup-actions.split .primary-button"),
  );
  const card = await box(page.locator(".setup-card.setup-flow"));
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Test needs an explicit viewport");
  return {
    hiddenWord,
    back,
    next,
    cardBottom: card.y + card.height,
    cardFits: card.y + card.height <= viewport.height - 2,
    step,
  };
}

test("setup steps fit and never paint the hidden step word", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 812 });
  await page.goto("/?firstRun=1");

  await advanceTo(page, "Choose how mail looks");
  const step2 = await setupMetrics(page, 2);
  expect(step2.hiddenWord.present).toBe(true);
  expect(step2.hiddenWord.hidden).toBe(true);
  expect(step2.back.fits).toBe(true);
  expect(step2.next.fits).toBe(true);
  expect(step2.cardFits).toBe(true);
  const setupStep2 = await shot(page, "setup-step2.png", true);

  await advanceTo(page, "Choose your options");
  const step3 = await setupMetrics(page, 3);
  expect(step3.hiddenWord.present).toBe(true);
  expect(step3.hiddenWord.hidden).toBe(true);
  expect(step3.back.fits).toBe(true);
  expect(step3.next.fits).toBe(true);
  expect(step3.cardFits).toBe(true);
  const setupStep3 = await shot(page, "setup-step3.png", true);

  const dragStrip = await page.evaluate(() => {
    const node = document.querySelector(".window-drag-strip");
    if (!node) {
      return { found: false, backgroundColor: "rgba(0, 0, 0, 0)", height: 0 };
    }
    const style = getComputedStyle(node);
    return {
      found: true,
      backgroundColor: style.backgroundColor,
      height: node.getBoundingClientRect().height,
    };
  });
  expect(
    dragStrip.backgroundColor === "rgba(0, 0, 0, 0)" || dragStrip.height === 0,
  ).toBe(true);

  const metrics = {
    step2cardBottom: step2.cardFits,
    step2Continue: step2.next.fits,
    step3cardBottom: step3.cardFits,
    step3Continue: step3.next.fits,
    hiddenWord: step2.hiddenWord.hidden && step3.hiddenWord.hidden,
    dragStrip,
    screenshots: [setupStep2, setupStep3],
  };
  await artifact("step-fits.json", metrics);
  expect(metrics).toMatchObject({
    step2cardBottom: true,
    step2Continue: true,
    step3cardBottom: true,
    step3Continue: true,
    hiddenWord: true,
  });
});

test("dark selected row and primary controls pass contrast", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 812 });
  await page.goto("/?theme=dark");
  await expect(page.locator(".mail-shell")).toBeVisible();

  const candidate = page.locator(".message-row:not(.thread-header)").first();
  const rowCount = await candidate.count();
  const row = rowCount > 0 ? candidate : page.locator(".message-row").first();
  await row.click();

  // Focus the list so the accent (focused) selection fill applies (D12).
  const selected = page.locator(".message-row.selected").first();
  await expect(selected).toBeVisible();
  await selected.focus();
  await expect(page.locator(".message-list:focus-within")).toHaveCount(1);
  // Poll: the fill transitions in after focus.
  await expect
    .poll(() =>
      selected.evaluate((node) => getComputedStyle(node).backgroundColor),
    )
    .toBe("rgb(0, 104, 214)");
  const background = await selected.evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  expect(background).not.toBe("rgb(10, 132, 255)");

  const accentContrast = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--accent-contrast")
      .trim(),
  );
  expect(accentContrast).toBe("#ffffff");

  const composeColor = await page
    .locator(".compose-button")
    .evaluate((node) => getComputedStyle(node).color);
  expect(composeColor).toBe("rgb(255, 255, 255)");

  const rowScan = await new AxeBuilder({ page })
    .include(".message-row.selected")
    .analyze();
  const rowViolations = rowScan.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact ?? ""),
  );
  expect(rowViolations).toEqual([]);

  const toolbarScan = await new AxeBuilder({ page })
    .include(".mail-shell .app-toolbar")
    .analyze();
  const toolbarViolations = toolbarScan.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact ?? ""),
  );
  expect(toolbarViolations).toEqual([]);

  const darkShot = await shot(page, "dark-selected.png");
  await artifact("dark-contrast.json", {
    selectedBackground: background,
    accentContrast,
    composeColor,
    rowViolations: rowViolations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
    })),
    toolbarViolations: toolbarViolations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
    })),
    screenshot: darkShot,
  });
});

const CHROME_VARIANTS = [
  {
    label: "comfortable",
    density: "comfortable",
    toolbarMax: 56,
    headingMax: 62,
    avatar: 36,
  },
  {
    label: "normal",
    density: "normal",
    toolbarMax: 46,
    headingMax: 46,
    avatar: 32,
  },
  // Compact tokens: --toolbar-height and --pane-heading-height 2.75rem (44px,
  // with the same 2px slack as Normal), --sender-avatar-size 1.875rem (30px).
  {
    label: "compact",
    density: "compact",
    toolbarMax: 46,
    headingMax: 46,
    avatar: 30,
  },
] as const;

for (const variant of CHROME_VARIANTS) {
  test(`${variant.label} chrome bands drop to the densified heights`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 812 });
    await page.goto(`/?density=${variant.density}&theme=light`);
    await expect(page.locator(".mail-shell")).toBeVisible();

    const row = page.locator(".message-row:not(.thread-header)").first();
    await row.click();
    await expect(page.locator(".message-header .sender-avatar")).toBeVisible();

    const heights = await page.evaluate(() => {
      const rect = (selector: string) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return { width: box.width, height: box.height };
      };
      const size = document.querySelector(".message-size");
      return {
        toolbar: rect(".app-toolbar"),
        paneHeading: rect(".pane-heading"),
        filter: rect(".mailbox-filter"),
        avatar: rect(".message-header .sender-avatar"),
        sizeDisplay: size ? getComputedStyle(size).display : null,
      };
    });

    expect(heights.toolbar).not.toBeNull();
    expect(heights.toolbar?.height ?? Infinity).toBeLessThanOrEqual(
      variant.toolbarMax,
    );
    expect(heights.paneHeading).not.toBeNull();
    expect(heights.paneHeading?.height ?? Infinity).toBeLessThanOrEqual(
      variant.headingMax,
    );
    expect(heights.filter).not.toBeNull();
    expect(heights.filter?.height ?? 0).toBeGreaterThan(0);
    expect(heights.avatar).not.toBeNull();
    expect(heights.avatar?.width ?? 0).toBeGreaterThanOrEqual(
      variant.avatar - 0.5,
    );
    expect(heights.avatar?.width ?? 0).toBeLessThanOrEqual(
      variant.avatar + 0.5,
    );
    expect(heights.sizeDisplay).toBe("none");

    const chromeShot = await shot(page, `${variant.label}-mail-chrome.png`);
    await artifact(`${variant.label}-chrome-heights.json`, {
      toolbarHeight: heights.toolbar?.height ?? null,
      paneHeadingHeight: heights.paneHeading?.height ?? null,
      filterBandHeight: heights.filter?.height ?? null,
      senderAvatarWidth: heights.avatar?.width ?? null,
      messageSizeDisplay: heights.sizeDisplay,
      passes: {
        toolbar: (heights.toolbar?.height ?? Infinity) <= variant.toolbarMax,
        paneHeading:
          (heights.paneHeading?.height ?? Infinity) <= variant.headingMax,
        filterBand: (heights.filter?.height ?? 0) > 0,
        avatar: heights.avatar
          ? Math.abs(heights.avatar.width - variant.avatar) <= 0.5
          : false,
        sizeChipHidden: heights.sizeDisplay === "none",
      },
      screenshot: chromeShot,
    });
  });
}
