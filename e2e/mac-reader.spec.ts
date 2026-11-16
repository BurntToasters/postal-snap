import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifactsAfterEach } from "./ipc";

test.afterEach(attachArtifactsAfterEach);
test.beforeEach(async ({ page }) => installMockIpc(page));

// WP4.6 macOS-style reader. Failure modes:
// FM1. Subject is weight 700; sender name is weight 600.
// FM2. The action bar does not wrap in any density at 1x or 2x, and every
//      button meets the inset target token.
// FM3. Attachment chips use radius md (10px) with a hairline border.
// FM4. Empty reader: aria-hidden icon, title and hint text, sized by CSS only.
// FM5. Bottom and hidden panes and the narrow overlay reader all render.
// FM6. Forced colors keep chip borders and button focus outlines visible.
// FM7. axe finds no serious or critical violations in the open reader.
// FM8. The letter iframe sandbox is exactly "allow-same-origin allow-popups".
// Screenshots: artifacts/0.5.2/mac-reader/ (light and dark, three densities).

const DENSITIES = ["normal", "comfortable", "compact"] as const;
const SCALES = [1, 2] as const;
type Scale = (typeof SCALES)[number];

const SHOT_DIR = join(process.cwd(), "artifacts", "0.5.2", "mac-reader");

async function openReader(page: Page, query = "", scale: Scale = 1) {
  const sep = query ? "&" : "";
  await page.goto(`/?scale=${scale}${sep}${query}`);
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(page.locator("#message-title")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function probePx(page: Page, token: string) {
  return page.evaluate((name) => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;visibility:hidden;height:0;";
    probe.style.width = `var(${name})`;
    document.body.append(probe);
    const px = probe.getBoundingClientRect().width;
    probe.remove();
    return px;
  }, token);
}

function visibleButtons(page: Page): Locator {
  return page.locator(".reader-actions button").filter({ visible: true });
}

test.describe("reader typography and action bar", () => {
  test("FM1 subject weight 700, sender weight 600", async ({ page }) => {
    await openReader(page);
    const title = await page
      .locator("#message-title")
      .evaluate((el) => getComputedStyle(el).fontWeight);
    const sender = await page
      .locator(".message-header .sender-name")
      .first()
      .evaluate((el) => getComputedStyle(el).fontWeight);
    expect(title).toBe("700");
    expect(sender).toBe("600");
  });

  for (const density of DENSITIES) {
    for (const scale of SCALES) {
      test(`FM2 action bar: one row, targets met (${density} ${scale}x)`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 1280, height: 840 });
        await page.goto(`/?density=${density}&scale=${scale}`);
        await page.getByRole("option", { name: /Weekend plans/i }).click();
        await expect(page.locator("#message-title")).toBeVisible();
        const target = await probePx(page, "--target-size-inset");
        const buttons = await visibleButtons(page).evaluateAll((nodes) =>
          nodes.map((node) => {
            const r = node.getBoundingClientRect();
            return { top: r.top, height: r.height };
          }),
        );
        expect(buttons.length, "reader buttons exist").toBeGreaterThan(0);
        // The bar height syncs to the list heading, so count button rows instead.
        const group = await page
          .locator(".reader-unified-actions")
          .evaluate((el) => el.getBoundingClientRect().height);
        const rowHeight = Math.max(...buttons.map((b) => b.height));
        const spread =
          Math.max(...buttons.map((b) => b.top)) -
          Math.min(...buttons.map((b) => b.top));
        expect(group, "actions form one row").toBeLessThan(rowHeight * 2);
        expect(spread, "buttons share a row").toBeLessThan(rowHeight / 2);
        for (const button of buttons) {
          expect(button.height).toBeGreaterThanOrEqual(target - 0.5);
        }
      });
    }
  }
});

test.describe("attachments and empty state", () => {
  test("FM3 attachment chip radius md with hairline border", async ({
    page,
  }) => {
    await openReader(page, "previewable=1&filePair=1");
    const chip = page.locator(".attachment-row button").first();
    await expect(chip).toBeVisible();
    const style = await chip.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        radius: s.borderTopLeftRadius,
        width: s.borderTopWidth,
        style: s.borderTopStyle,
        color: s.borderTopColor,
      };
    });
    expect(style.radius).toBe("10px");
    expect(style.width).toBe("1px");
    expect(style.style).toBe("solid");
    expect(style.color).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("FM4 empty reader: icon, title and hint, accessible text", async ({
    page,
  }) => {
    await page.goto("/");
    const reader = page.locator("#reader-pane.empty-reader");
    await expect(reader).toBeVisible();
    await expect(reader).toContainText("No message selected");
    await expect(reader).toContainText("Choose a message to read it.");
    const icon = reader.locator("svg");
    await expect(icon).toHaveCount(1);
    await expect(icon).toHaveAttribute("aria-hidden", "true");
    const box = await icon.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    const rem = await probePx(page, "--fs-base");
    // 2.5rem at the root font size (16px at 100% text).
    expect(box.width).toBeGreaterThanOrEqual(rem * 2.5 - 1);
    expect(box.width).toBeLessThanOrEqual(rem * 2.5 + 1);
    expect(box.height).toBeCloseTo(box.width, 0);
    const title = reader.locator("p").first();
    await expect(title).toHaveText("No message selected");
    const weight = await title.evaluate(
      (el) => getComputedStyle(el).fontWeight,
    );
    expect(weight).toBe("600");
  });
});

test.describe("pane modes", () => {
  test("FM5 bottom pane renders the reader and its actions", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 840 });
    await openReader(page, "pane=bottom&readerPaneHeight=420");
    await expect(page.locator(".mail-shell.pane-bottom")).toBeVisible();
    const pane = await page
      .locator("#reader-pane")
      .evaluate((el) => el.getBoundingClientRect());
    expect(pane.height).toBeGreaterThan(200);
    await expect(page.locator(".reader-actions")).toBeVisible();
  });

  test("FM5 hidden pane opens the message full screen", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 840 });
    await openReader(page, "pane=hidden");
    const pane = await page
      .locator("#reader-pane")
      .evaluate((el) => el.getBoundingClientRect());
    expect(pane.width).toBeGreaterThan(1200);
    expect(pane.height).toBeGreaterThan(700);
    await expect(page.locator("#message-title")).toBeVisible();
  });

  test("FM5 narrow window: reader overlays with a back control", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 700, height: 800 });
    await openReader(page);
    await expect(page.locator(".mobile-reader-back").first()).toBeVisible();
    const pane = await page
      .locator("#reader-pane")
      .evaluate((el) => el.getBoundingClientRect());
    expect(pane.width).toBeGreaterThan(680);
    await expect(page.locator("#message-title")).toBeVisible();
  });
});

test.describe("forced colors", () => {
  test.use({ forcedColors: "active" });

  test("FM6 chip border and button focus outline stay visible", async ({
    page,
  }) => {
    await openReader(page, "previewable=1&filePair=1");
    const chip = page.locator(".attachment-row button").first();
    const border = await chip.evaluate((el) => ({
      style: getComputedStyle(el).borderTopStyle,
      width: getComputedStyle(el).borderTopWidth,
    }));
    expect(border.style).toBe("solid");
    expect(border.width).toBe("1px");

    const button = visibleButtons(page).first();
    // WebKit does not tab to buttons, so its focus ring is checked only in Chromium.
    if (test.info().project.name === "webkit") return;
    await button.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    const focus = await button.evaluate((el) => ({
      visible: el.matches(":focus-visible"),
      outline: getComputedStyle(el).outlineStyle,
    }));
    expect(focus.visible, "keyboard focus is visible").toBe(true);
    expect(focus.outline).not.toBe("none");
  });
});

test("FM7 open reader has no serious or critical axe violations", async ({
  page,
}) => {
  await openReader(page, "previewable=1&filePair=1");
  // The letter iframe holds sender HTML; the reader chrome is what we own.
  const results = await new AxeBuilder({ page })
    .include("#reader-pane")
    .exclude(".message-body")
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(serious.map((v) => v.id)).toEqual([]);
});

test("FM8 letter iframe sandbox is unchanged", async ({ page }) => {
  await openReader(page);
  const frame = page.locator(".message-body iframe").first();
  await expect(frame).toHaveAttribute(
    "sandbox",
    "allow-same-origin allow-popups",
  );
});

test("Screenshots: open and empty reader, light and dark", async ({ page }) => {
  await mkdir(SHOT_DIR, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    for (const density of DENSITIES) {
      await page.setViewportSize({ width: 1280, height: 840 });
      await page.goto(`/?density=${density}&theme=${theme}`);
      await page.getByRole("option", { name: /Weekend plans/i }).click();
      await expect(page.locator("#message-title")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: join(SHOT_DIR, `open-${density}-${theme}.png`),
      });
      await page.goto(`/?density=${density}&theme=${theme}`);
      await expect(page.locator("#reader-pane.empty-reader")).toBeVisible();
      await page.screenshot({
        path: join(SHOT_DIR, `empty-${density}-${theme}.png`),
      });
    }
  }
});
