import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifacts } from "./ipc";
import { axeInPage } from "./axe-inpage";
import type { Page } from "@playwright/test";

// WP2.2 token values (macOS-native type, focus, radii, selection, base styles).
// Failure modes covered here:
// FM1. The font stack lacks the system-font chain, or --font-mono does not resolve.
// FM2. Focus ring is not 3px solid accent at 2px offset, or its contrast is under 3:1.
// FM3. Forced colors draw focus with a color other than Highlight.
// FM4. Lucide icons render with a stroke other than 1.75.
// FM5. The body keeps a radial accent glow (background-image not none).
// FM6. macOS keeps a ::-webkit-scrollbar rule, which blocks native overlay scrollbars.
// FM7. --ui-font-size is not compact < normal < comfortable, or misses the table values.
// FM8. Light theme has a serious color-contrast violation.
// FM9. Dark theme has a serious color-contrast violation.

test.beforeEach(async ({ page }) => installMockIpc(page));

async function openMailbox(page: Page, query: string) {
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.goto(`/?${query}`);
  await expect(page.locator(".message-row").first()).toBeVisible();
}

// Focus targets: Compose button, first folder row, first message row.
function focusTargets(page: Page) {
  return {
    compose: page.getByRole("button", { name: /^Compose/ }).first(),
    folder: page.locator(".folder:not(.active)").first(),
    row: page.locator(".message-row:not(.selected)").first(),
  };
}

async function focusStyle(page: Page, locator: ReturnType<Page["locator"]>) {
  await locator.focus();
  return locator.evaluate((element) => {
    const parse = (text: string): number[] =>
      text.match(/[\d.]+/g)!.map(Number);
    const style = getComputedStyle(element);
    const outline = parse(style.outlineColor);
    // Walk ancestors to the first opaque backdrop the outline sits on.
    const layers: number[][] = [];
    let node: Element | null = element.parentElement;
    while (node) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      const alpha = bg.length > 3 ? bg[3] : 1;
      if (alpha > 0) layers.push(bg);
      if (alpha >= 1) break;
      node = node.parentElement;
    }
    let backdrop = [255, 255, 255];
    for (const [r, g, b, a = 1] of layers.reverse()) {
      backdrop = [
        a * r + (1 - a) * backdrop[0],
        a * g + (1 - a) * backdrop[1],
        a * b + (1 - a) * backdrop[2],
      ];
    }
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineOffset: style.outlineOffset,
      outlineColor: style.outlineColor,
      outline: outline.slice(0, 3),
      backdrop,
    };
  });
}

function luminance([r, g, b]: number[]) {
  const [R, G, B] = [r, g, b].map((channel) => {
    const v = channel / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function contrast(a: number[], b: number[]) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

async function resolvePx(page: Page, value: string) {
  return page.evaluate((expr) => {
    const probe = document.createElement("div");
    probe.style.position = "absolute";
    probe.style.fontSize = expr;
    document.body.append(probe);
    const px = Number.parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    return px;
  }, value);
}

test.describe("macOS-native tokens (WP2.2)", () => {
  // FM1.
  test("font stack starts with the system font and --font-mono resolves", async ({
    page,
  }, testInfo) => {
    await openMailbox(page, "theme=light");
    const result = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const mono = root.getPropertyValue("--font-mono").trim();
      const probe = document.createElement("span");
      probe.style.fontFamily = mono;
      document.body.append(probe);
      const resolvedMono = getComputedStyle(probe).fontFamily;
      probe.remove();
      return {
        body: getComputedStyle(document.body).fontFamily,
        mono,
        resolvedMono,
      };
    });
    await attachArtifacts(page, testInfo, "font-stack", result);
    expect(result.body.startsWith("-apple-system")).toBe(true);
    expect(result.body).toContain("Segoe UI Variable");
    expect(result.mono).toContain("SF Mono");
    expect(result.resolvedMono).toContain("ui-monospace");
    // Hard-coded mono stacks in component CSS must go through the token.
    const literalMono = await page.evaluate(() => {
      const hits: string[] = [];
      const visit = (rules: CSSRuleList) => {
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSStyleRule) {
            const family = rule.style.getPropertyValue("font-family");
            if (family.includes("monospace")) hits.push(rule.selectorText);
          } else if ("cssRules" in rule) {
            visit((rule as CSSGroupingRule).cssRules);
          }
        }
      };
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          visit(sheet.cssRules);
        } catch {
          continue;
        }
      }
      return hits;
    });
    expect(literalMono).toEqual([]);
  });

  // FM2 and FM3 use the same focus targets.
  test("focus ring is 3px accent with 3:1 contrast on light", async ({
    page,
  }, testInfo) => {
    await openMailbox(page, "theme=light");
    const accent = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--accent"),
    );
    const targets = focusTargets(page);
    const shots: Record<string, unknown> = {};
    for (const [name, locator] of Object.entries(targets)) {
      const style = await focusStyle(page, locator);
      shots[name] = style;
      expect(style.outlineStyle, name).toBe("solid");
      expect(style.outlineWidth, name).toBe("3px");
      // Rows clip outside their list, so their ring is inset.
      expect(style.outlineOffset, name).toBe(name === "row" ? "-3px" : "2px");
      const probe = await page.evaluate((value) => {
        const el = document.createElement("span");
        el.style.color = value;
        document.body.append(el);
        const text = getComputedStyle(el).color;
        el.remove();
        return text.match(/[\d.]+/g)!.map(Number);
      }, accent.trim());
      expect(style.outline.slice(0, 3), name).toEqual(probe.slice(0, 3));
      const ratio = contrast(style.outline, style.backdrop);
      shots[`${name}Ratio`] = ratio;
      expect(ratio, name).toBeGreaterThanOrEqual(3);
    }
    await attachArtifacts(page, testInfo, "focus-light", shots);
  });

  // FM3.
  test("forced colors draw focus with Highlight", async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ forcedColors: "active" });
    await openMailbox(page, "theme=light");
    const targets = focusTargets(page);
    const results: Record<string, unknown> = {};
    for (const [name, locator] of Object.entries(targets)) {
      await locator.focus();
      const style = await locator.evaluate((element) => {
        const probe = document.createElement("span");
        probe.style.color = "Highlight";
        document.body.append(probe);
        const highlight = getComputedStyle(probe).color;
        probe.remove();
        const s = getComputedStyle(element);
        return {
          outlineWidth: s.outlineWidth,
          outlineColor: s.outlineColor,
          highlight,
        };
      });
      results[name] = style;
      expect(style.outlineWidth, name).toBe("3px");
      expect(style.outlineColor, name).toBe(style.highlight);
    }
    await attachArtifacts(page, testInfo, "focus-forced", results);
  });

  // FM4.
  test("lucide icons use a 1.75 stroke", async ({ page }, testInfo) => {
    await openMailbox(page, "theme=light");
    const strokes = await page.evaluate(() =>
      Array.from(document.querySelectorAll("svg.lucide")).map(
        (svg) => getComputedStyle(svg).strokeWidth,
      ),
    );
    await attachArtifacts(page, testInfo, "lucide-stroke", { strokes });
    expect(strokes.length).toBeGreaterThan(0);
    for (const stroke of strokes) expect(stroke).toBe("1.75px");
  });

  // FM5.
  test("body background has no radial accent glow", async ({
    page,
  }, testInfo) => {
    await openMailbox(page, "theme=light");
    const light = await page.evaluate(
      () => getComputedStyle(document.body).backgroundImage,
    );
    await page.goto("/?theme=dark");
    await expect(page.locator(".message-row").first()).toBeVisible();
    const dark = await page.evaluate(
      () => getComputedStyle(document.body).backgroundImage,
    );
    await attachArtifacts(page, testInfo, "body-background", { light, dark });
    expect(light).toBe("none");
    expect(dark).toBe("none");
  });

  // FM6.
  test("macOS applies no ::-webkit-scrollbar rule", async ({
    page,
  }, testInfo) => {
    await openMailbox(page, "theme=light");
    const scan = (platform: string) =>
      page.evaluate((value) => {
        document.documentElement.dataset.platform = value;
        const applies: string[] = [];
        const visit = (rules: CSSRuleList) => {
          for (const rule of Array.from(rules)) {
            if (rule instanceof CSSStyleRule) {
              if (!rule.selectorText.includes("::-webkit-scrollbar")) continue;
              for (const selector of rule.selectorText.split(",")) {
                if (!selector.includes("::-webkit-scrollbar")) continue;
                const base = selector.split("::-webkit-scrollbar")[0].trim();
                try {
                  if (document.querySelector(base || "*")) {
                    applies.push(selector.trim());
                  }
                } catch {
                  continue;
                }
              }
            } else if ("cssRules" in rule) {
              visit((rule as CSSGroupingRule).cssRules);
            }
          }
        };
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            visit(sheet.cssRules);
          } catch {
            continue;
          }
        }
        return applies;
      }, platform);
    const macos = await scan("macos");
    // Negative control: the same scan finds the thin Windows bar.
    const windows = await scan("windows");
    await attachArtifacts(page, testInfo, "scrollbar-scan", {
      macos,
      windows,
    });
    expect(windows.length).toBeGreaterThan(0);
    expect(macos).toEqual([]);
  });

  // FM7.
  test("--ui-font-size follows the density order and table values", async ({
    page,
  }, testInfo) => {
    const sizes: Record<string, number> = {};
    for (const density of ["compact", "normal", "comfortable"] as const) {
      await openMailbox(page, `theme=light&density=${density}`);
      const token = await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--ui-font-size")
          .trim(),
      );
      sizes[density] = await resolvePx(page, token);
    }
    await attachArtifacts(page, testInfo, "ui-font-size", sizes);
    expect(sizes.compact).toBe(13);
    expect(sizes.normal).toBe(14);
    expect(sizes.comfortable).toBe(16);
  });

  // FM8.
  test("light theme has no serious color-contrast violation", async ({
    page,
  }, testInfo) => {
    await openMailbox(page, "theme=light");
    const violations = await axeInPage(page, "body", {
      rules: ["color-contrast"],
    });
    const serious = violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? ""),
    );
    await attachArtifacts(page, testInfo, "axe-light", { serious });
    expect(serious).toEqual([]);
  });

  // FM9.
  test("dark theme has no serious color-contrast violation", async ({
    page,
  }, testInfo) => {
    await openMailbox(page, "theme=dark");
    const violations = await axeInPage(page, "body", {
      rules: ["color-contrast"],
    });
    const serious = violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? ""),
    );
    await attachArtifacts(page, testInfo, "axe-dark", { serious });
    expect(serious).toEqual([]);
  });
});
