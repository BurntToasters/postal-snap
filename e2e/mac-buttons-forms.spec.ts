import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifacts } from "./ipc";
import { axeInPage } from "./axe-inpage";

// WP4.1 macOS-style buttons and form controls.
// Failure modes covered here:
// FM1. Primary or secondary buttons are not pill-radius or not weight 500.
// FM2. Controls or footer actions fall under AGENTS targets (Normal 36px,
//      Comfortable 44px, Compact 32px inline) at 1x or 2x text.
// FM3. Selects lack the popup look: appearance is not none, no chevron
//      background in light or dark, or forced colors keep a custom look.
// FM4. Focus is not a 3px solid accent ring on button, select or input.
// FM5. Settings scrolls horizontally at 200% text.
// FM6. axe reports a serious or critical violation in Settings or Composer.
// FM7. Buttons still animate under reduced motion.

test.beforeEach(async ({ page }) => installMockIpc(page));

const DENSITIES = ["normal", "comfortable", "compact"] as const;
type Density = (typeof DENSITIES)[number];

const MIN_TARGET: Record<Density, number> = {
  normal: 36,
  comfortable: 44,
  compact: 32,
};

async function openSettings(
  page: Page,
  query: string,
  tab: string,
): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.goto(`/?${query}`);
  await expect(page.locator(".message-row").first()).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator(".settings-window")).toBeVisible();
  await page.getByRole("tab", { name: tab, exact: true }).click();
}

async function openComposer(page: Page, query: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.goto(`/?${query}`);
  await expect(page.locator(".message-row").first()).toBeVisible();
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await expect(page.locator(".composer-window")).toBeVisible();
}

// Keyboard focus shows :focus-visible; a mouse-driven focus would not.
async function focusByKeyboard(page: Page, locator: Locator): Promise<void> {
  await locator.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
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

// Heights of visible controls in a scope; radios keep native size by design.
function controlHeights(page: Page, scope: string) {
  return page.evaluate((selector) => {
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        `${selector} :is(button, select, input, textarea)`,
      ),
    )
      .filter((el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0 &&
          !(el instanceof HTMLInputElement && el.type === "radio") &&
          !(el instanceof HTMLInputElement && el.type === "hidden")
        );
      })
      .map((el) => ({
        name:
          el.getAttribute("aria-label") ??
          el.textContent?.trim().slice(0, 40) ??
          el.tagName,
        tag: el.tagName.toLowerCase(),
        height: el.getBoundingClientRect().height,
      }));
  }, scope);
}

test.describe("macOS buttons and form controls (WP4.1)", () => {
  // FM1 and FM2 in Settings General, which holds secondary buttons.
  for (const density of DENSITIES) {
    test(`buttons are pill, weight 500 and meet targets in ${density}`, async ({
      page,
    }, testInfo) => {
      await openSettings(page, `density=${density}&theme=light`, "General");
      const buttons = await page
        .locator(".settings-window .secondary-button:visible")
        .evaluateAll((els) =>
          els.map((el) => {
            const style = getComputedStyle(el);
            return {
              name: el.textContent?.trim() ?? "",
              radius: style.borderRadius,
              weight: style.fontWeight,
              border: style.borderTopWidth,
            };
          }),
        );
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) {
        expect(button.radius, button.name).toBe("999px");
        expect(button.weight, button.name).toBe("500");
        expect(button.border, button.name).toBe("0px");
      }
      const heights = await controlHeights(page, ".settings-window");
      await attachArtifacts(page, testInfo, `general-${density}`, {
        buttons,
        heights,
      });
      for (const control of heights) {
        expect(control.height, control.name).toBeGreaterThanOrEqual(
          MIN_TARGET[density],
        );
      }
    });
  }

  // FM1 for the primary button, from the composer's Insert link dialog.
  test("primary button is pill and weight 500", async ({ page }, testInfo) => {
    await openComposer(page, "theme=light");
    await page.getByRole("button", { name: "Show formatting" }).click();
    await page.getByRole("button", { name: "More formatting" }).click();
    await page.getByRole("button", { name: "Insert link" }).click();
    const dialog = page.getByRole("dialog", { name: "Insert link" });
    const primary = dialog.locator(".primary-button");
    const style = await primary.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        radius: s.borderRadius,
        weight: s.fontWeight,
        shadow: s.boxShadow,
        background: s.backgroundColor,
      };
    });
    await attachArtifacts(page, testInfo, "primary-button", style);
    expect(style.radius).toBe("999px");
    expect(style.weight).toBe("500");
    expect(style.shadow).not.toMatch(/rgb\((?!0, 0, 0)/);
  });

  // FM2 in the composer footer at 1x and 2x text.
  for (const density of DENSITIES) {
    for (const scale of [1, 2] as const) {
      test(`composer footer meets targets in ${density} at ${scale}x`, async ({
        page,
      }, testInfo) => {
        await openComposer(
          page,
          `density=${density}&scale=${scale}&theme=light`,
        );
        const heights = await controlHeights(page, ".composer-window footer");
        await attachArtifacts(
          page,
          testInfo,
          `composer-footer-${density}-${scale}x`,
          {
            heights,
          },
        );
        expect(heights.length).toBeGreaterThan(0);
        for (const control of heights) {
          expect(control.height, control.name).toBeGreaterThanOrEqual(
            MIN_TARGET[density],
          );
        }
      });

      test(`settings controls meet targets in ${density} at ${scale}x`, async ({
        page,
      }, testInfo) => {
        await openSettings(
          page,
          `density=${density}&scale=${scale}&theme=light`,
          "Appearance",
        );
        const heights = await controlHeights(page, ".settings-window");
        await attachArtifacts(
          page,
          testInfo,
          `appearance-${density}-${scale}x`,
          {
            heights,
          },
        );
        expect(heights.length).toBeGreaterThan(0);
        for (const control of heights) {
          expect(control.height, control.name).toBeGreaterThanOrEqual(
            MIN_TARGET[density],
          );
        }
      });
    }
  }

  // FM3.
  test("selects use the popup look in light and dark", async ({
    page,
  }, testInfo) => {
    const looks: Record<string, unknown> = {};
    for (const theme of ["light", "dark"] as const) {
      await openSettings(page, `theme=${theme}`, "Appearance");
      looks[theme] = await page
        .locator(".settings-window select:visible")
        .evaluateAll((els) =>
          els.map((el) => {
            const s = getComputedStyle(el);
            return {
              appearance: s.appearance,
              image: s.backgroundImage,
              paddingEnd: s.paddingInlineEnd,
              radius: s.borderRadius,
            };
          }),
        );
    }
    await attachArtifacts(page, testInfo, "select-looks", looks);
    const light = looks.light as { appearance: string; image: string }[];
    const dark = looks.dark as { appearance: string; image: string }[];
    expect(light.length).toBeGreaterThan(0);
    for (const select of [...light, ...dark]) {
      expect(select.appearance).toBe("none");
      expect(select.image).toContain("data:image/svg+xml");
    }
    expect(light[0].image).not.toBe(dark[0].image);
  });

  test("forced colors restore native select appearance", async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ forcedColors: "active" });
    await openSettings(page, "theme=light", "Appearance");
    const selects = await page
      .locator(".settings-window select:visible")
      .evaluateAll((els) =>
        els.map((el) => {
          const s = getComputedStyle(el);
          return { appearance: s.appearance, image: s.backgroundImage };
        }),
      );
    await attachArtifacts(page, testInfo, "select-forced", { selects });
    expect(selects.length).toBeGreaterThan(0);
    for (const select of selects) {
      expect(select.appearance).toBe("auto");
      expect(select.image).toBe("none");
    }
  });

  // FM4.
  test("focus is a 3px accent ring on button, select and input", async ({
    page,
  }, testInfo) => {
    const targets: [string, string, string][] = [
      ["button", "General", ".settings-window .secondary-button:visible"],
      ["select", "Appearance", ".settings-window select:visible"],
    ];
    const results: Record<string, unknown> = {};
    for (const [name, tab, selector] of targets) {
      await openSettings(page, "theme=light", tab);
      const accent = await accentValue(page);
      const locator = page.locator(selector).first();
      await focusByKeyboard(page, locator);
      const style = await locator.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          style: s.outlineStyle,
          width: s.outlineWidth,
          color: s.outlineColor,
        };
      });
      results[name] = { ...style, accent };
      expect(style.style, name).toBe("solid");
      expect(style.width, name).toBe("3px");
      expect(style.color, name).toBe(accent);
    }
    // Settings search is a text input. The composer header fields keep
    // their own 2px ring (composer.css), which this spec does not cover.
    await openSettings(page, "theme=light", "General");
    const accent = await accentValue(page);
    const input = page.locator(".settings-window input[type='search']").first();
    await focusByKeyboard(page, input);
    const inputStyle = await input.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        style: s.outlineStyle,
        width: s.outlineWidth,
        color: s.outlineColor,
      };
    });
    results.input = { ...inputStyle, accent };
    expect(inputStyle.style, "input").toBe("solid");
    expect(inputStyle.width, "input").toBe("3px");
    expect(inputStyle.color, "input").toBe(accent);
    await attachArtifacts(page, testInfo, "focus-controls", results);
  });

  // FM5.
  test("settings does not scroll horizontally at 200% text", async ({
    page,
  }, testInfo) => {
    const metrics: Record<string, unknown> = {};
    for (const tab of ["General", "Appearance"]) {
      await openSettings(page, "density=normal&scale=2&theme=light", tab);
      metrics[tab] = await page.evaluate(() => {
        const win = document.querySelector<HTMLElement>(".settings-window");
        return {
          documentOverflow:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
          windowOverflow: win ? win.scrollWidth - win.clientWidth : null,
        };
      });
    }
    await attachArtifacts(page, testInfo, "settings-200", metrics);
    for (const tab of ["General", "Appearance"]) {
      const value = metrics[tab] as {
        documentOverflow: number;
        windowOverflow: number | null;
      };
      expect(value.documentOverflow, tab).toBeLessThanOrEqual(0);
      expect(value.windowOverflow ?? 0, tab).toBeLessThanOrEqual(0);
    }
  });

  // FM6.
  test("settings and composer have no serious axe violation", async ({
    page,
  }, testInfo) => {
    await openSettings(page, "theme=light", "General");
    const settings = await axeInPage(page, ".settings-window");
    await openComposer(page, "theme=dark");
    const composer = await axeInPage(page, ".composer-window");
    const serious = [
      ...settings.map((v) => ({ scope: "settings", ...v })),
      ...composer.map((v) => ({ scope: "composer", ...v })),
    ].filter((v) => ["serious", "critical"].includes(v.impact ?? ""));
    await attachArtifacts(page, testInfo, "axe-controls", { serious });
    expect(serious).toEqual([]);
  });

  // FM7.
  test("buttons do not transition under reduced motion", async ({
    page,
  }, testInfo) => {
    await openSettings(page, "theme=light", "General");
    const duration = () =>
      page
        .locator(".settings-window .secondary-button:visible")
        .first()
        .evaluate((el) => getComputedStyle(el).transitionDuration);
    const normal = await duration();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reduced = await duration();
    await attachArtifacts(page, testInfo, "reduced-motion", {
      normal,
      reduced,
    });
    expect(normal).not.toMatch(/^0s(, 0s)*$/);
    expect(reduced.split(",").every((part) => part.trim() === "0s")).toBe(true);
  });

  // Visual evidence: Settings General and the composer footer.
  test("captures settings and composer footer artifacts", async ({
    page,
  }, testInfo) => {
    // Twelve captures; WebKit screenshots need more than the 30s default.
    test.setTimeout(120_000);
    for (const theme of ["light", "dark"] as const) {
      for (const density of DENSITIES) {
        await openSettings(
          page,
          `density=${density}&theme=${theme}`,
          "General",
        );
        await attachArtifacts(
          page,
          testInfo,
          `settings-general-${theme}-${density}`,
        );
        await page.keyboard.press("Escape");
        await openComposer(page, `density=${density}&theme=${theme}`);
        await attachArtifacts(
          page,
          testInfo,
          `composer-footer-${theme}-${density}`,
        );
      }
    }
  });
});
