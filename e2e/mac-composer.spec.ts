import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifacts } from "./ipc";
import { axeInPage } from "./axe-inpage";

// WP4.9 macOS-style composer. Failure modes:
// FM1. Window radius is not 16px, or the shadow is not --shadow-window.
// FM2. Header is taller than 48px at 1x in any density.
// FM3. Send is not pill-radius on its outer corners.
// FM4. Focus ring is not a 3px solid accent, or To and the letter differ.
// FM5. Format toolbar selects lose the popup chevron.
// FM6. At 200% the footer takes more than 2 rows, or the page scrolls sideways.
// FM7. Forced colors remove the window border, separators or focus outline.
// FM8. axe reports a serious or critical violation in the composer.

test.beforeEach(async ({ page }) => installMockIpc(page));

const DENSITIES = ["normal", "comfortable", "compact"] as const;

async function openComposer(
  page: Page,
  query: string,
  width = 1280,
  height = 840,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(`/?${query}`);
  await expect(page.locator(".message-row").first()).toBeVisible();
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await expect(page.locator(".composer-window")).toBeVisible();
}

async function accentValue(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = getComputedStyle(document.documentElement)
      .getPropertyValue("--accent")
      .trim();
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
}

test.describe("macOS composer (WP4.9)", () => {
  // FM1: window radius and shadow in both schemes.
  for (const scheme of ["light", "dark"] as const) {
    test(`FM1 window is xl radius with window shadow (${scheme})`, async ({
      page,
    }, testInfo) => {
      await openComposer(page, `density=normal&theme=${scheme}`);
      const win = page.locator(".composer-window");
      const style = await win.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          radius: s.borderTopLeftRadius,
          shadow: s.boxShadow,
          expected: getComputedStyle(document.documentElement)
            .getPropertyValue("--shadow-window")
            .trim(),
        };
      });
      await attachArtifacts(page, testInfo, `window-${scheme}`, style);
      expect(style.radius).toBe("16px");
      expect(style.shadow).toContain("60px");
      expect(style.shadow).toContain(
        scheme === "dark" ? "rgba(0, 0, 0, 0.6)" : "rgba(0, 0, 0, 0.25)",
      );
    });
  }

  // FM2: header height at 1x in every density.
  for (const density of DENSITIES) {
    test(`FM2 header is at most 48px (${density})`, async ({
      page,
    }, testInfo) => {
      await openComposer(page, `density=${density}&theme=light`);
      const box = await page.locator(".composer-window > header").boundingBox();
      await attachArtifacts(page, testInfo, `header-${density}`, {
        height: box?.height ?? null,
      });
      expect(box?.height ?? Infinity).toBeLessThanOrEqual(48);
    });
  }

  // FM3: Send keeps pill outer corners in every density.
  for (const density of DENSITIES) {
    test(`FM3 Send is pill-shaped (${density})`, async ({ page }, testInfo) => {
      await openComposer(page, `density=${density}&theme=light`);
      const send = page.locator(".composer-window .send-button");
      const box = await send.boundingBox();
      const radii = await send.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          topLeft: parseFloat(s.borderTopLeftRadius),
          bottomLeft: parseFloat(s.borderBottomLeftRadius),
        };
      });
      await attachArtifacts(page, testInfo, `send-${density}`, {
        height: box?.height ?? null,
        ...radii,
      });
      const half = (box?.height ?? 0) / 2;
      expect(radii.topLeft).toBeGreaterThanOrEqual(half - 0.5);
      expect(radii.bottomLeft).toBeGreaterThanOrEqual(half - 0.5);
    });
  }

  // FM4: keyboard focus ring on the To field and the letter.
  test("FM4 To field and letter share a 3px accent focus ring", async ({
    page,
  }, testInfo) => {
    await openComposer(page, "density=normal&theme=light");
    const ringOf = (locator: ReturnType<Page["locator"]>) =>
      locator.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          style: s.outlineStyle,
          width: s.outlineWidth,
          color: s.outlineColor,
        };
      });
    await page.locator("#composer-to").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const to = await ringOf(page.locator("#composer-to"));
    await page.getByRole("textbox", { name: "Message body" }).click();
    const body = await ringOf(page.locator(".composer-window .tiptap"));
    const accent = await accentValue(page);
    await attachArtifacts(page, testInfo, "focus-rings", { to, body, accent });
    expect(to.style).toBe("solid");
    expect(to.width).toBe("3px");
    expect(to.color).toBe(accent);
    expect(body).toEqual(to);
  });

  // FM5: toolbar selects keep the popup chevron in both schemes.
  for (const scheme of ["light", "dark"] as const) {
    test(`FM5 toolbar selects show the popup chevron (${scheme})`, async ({
      page,
    }, testInfo) => {
      await openComposer(page, `density=normal&theme=${scheme}`);
      await page.getByRole("button", { name: "Show formatting" }).click();
      const selects = await page
        .locator(".format-toolbar .toolbar-group select")
        .evaluateAll((els) =>
          els.map((el) => ({
            name: el.getAttribute("aria-label"),
            image: getComputedStyle(el).backgroundImage,
          })),
        );
      await attachArtifacts(page, testInfo, `selects-${scheme}`, { selects });
      expect(selects.length).toBeGreaterThanOrEqual(2);
      for (const select of selects) {
        expect(select.image, select.name ?? "select").toContain("url(");
      }
    });
  }

  // FM6: 200% text keeps the footer to at most 2 rows, no horizontal scroll.
  for (const width of [1280, 760]) {
    test(`FM6 footer is at most 2 rows at 200% (${width}px)`, async ({
      page,
    }, testInfo) => {
      await openComposer(page, "density=normal&theme=light&scale=2", width);
      const metrics = await page.evaluate(() => {
        const win = document.querySelector<HTMLElement>(".composer-window");
        const footer = document.querySelector<HTMLElement>(
          ".composer-window footer",
        );
        const rows = new Set(
          Array.from(footer?.children ?? [])
            .filter((el) => (el as HTMLElement).offsetParent !== null)
            .map((el) => Math.round(el.getBoundingClientRect().top)),
        );
        return {
          rows: rows.size,
          pageOverflow:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
          windowOverflow: win ? win.scrollWidth - win.clientWidth : 0,
        };
      });
      await attachArtifacts(page, testInfo, `footer-200-${width}`, metrics);
      expect(metrics.rows).toBeLessThanOrEqual(2);
      expect(metrics.pageOverflow).toBeLessThanOrEqual(0);
      expect(metrics.windowOverflow).toBeLessThanOrEqual(0);
    });
  }

  // FM7: forced colors keep boundaries and the focus outline.
  test("FM7 forced colors keep window border, separators and focus", async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ forcedColors: "active" });
    await openComposer(page, "density=normal&theme=light");
    const boundaries = await page.evaluate(() => {
      const win = getComputedStyle(
        document.querySelector(".composer-window") as Element,
      );
      const sep = getComputedStyle(
        document.querySelector(".composer-window .to-field-row") as Element,
      );
      return {
        winBorder: [win.borderTopStyle, parseFloat(win.borderTopWidth)],
        sepBorder: [sep.borderBottomStyle, parseFloat(sep.borderBottomWidth)],
      };
    });
    await page.locator("#composer-to").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const focus = await page.locator("#composer-to").evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
    });
    await attachArtifacts(page, testInfo, "forced-colors", {
      boundaries,
      focus,
    });
    expect(boundaries.winBorder[0]).toBe("solid");
    expect(boundaries.winBorder[1]).toBeGreaterThanOrEqual(1);
    expect(boundaries.sepBorder[0]).toBe("solid");
    expect(boundaries.sepBorder[1]).toBeGreaterThanOrEqual(1);
    expect(focus.style).toBe("solid");
    expect(focus.width).toBeGreaterThanOrEqual(2);
  });

  // FM8: axe, plus screenshots in light and dark across densities.
  for (const density of DENSITIES) {
    for (const scheme of ["light", "dark"] as const) {
      test(`FM8 axe and screenshot ${density} ${scheme}`, async ({
        page,
      }, testInfo) => {
        await openComposer(page, `density=${density}&theme=${scheme}`);
        const violations = await axeInPage(page, ".composer-window");
        const serious = violations.filter((v) =>
          ["serious", "critical"].includes(v.impact ?? ""),
        );
        await attachArtifacts(page, testInfo, `composer-${density}-${scheme}`, {
          serious,
        });
        expect(serious).toEqual([]);
      });
    }
  }
});
