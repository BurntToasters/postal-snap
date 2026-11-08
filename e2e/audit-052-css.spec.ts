import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Audit piece C1 (tokens, list/sidebar/toolbar CSS), 0.5.2. Failure modes:
// 1. Dark --surface-hover too close to --surface-raised (palette, suggestions, menus).
// 2. Palette aria-selected option lacks a visible inset outline.
// 3. Normal targets stay 36px at 200%, so row-action icons touch and clip.
// 4. Message-select icon and row actions overflow their hit areas at 200%.
// 5. Forced colors: row hover date draws over the action pill; search box and folder icons unbounded or accent.
// 6. Dark folder hover too close to the selected folder.
// 7. Undo toast cannot wrap its actions in narrow windows at 200%.
// 8. Filter focus ring is 2px, not the shared 3px; wrapped track is a broken pill.
// 9. Avatar tokens stay px while text scales.
// 10. Compact at 200% keeps the Compose label.

const VIEWPORT = { width: 1280, height: 840 };
const ARTIFACT_DIR = join(
  process.cwd(),
  "artifacts",
  "0.5.2",
  "audit-fixes",
  "audit-css",
);
const DENSITIES = ["normal", "comfortable", "compact"] as const;
type Rgba = [number, number, number, number];

test.beforeEach(async ({ page }) => installMockIpc(page));

async function saveJson(name: string, value: unknown) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(
    join(ARTIFACT_DIR, `${name}.json`),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await page.screenshot({ path: join(ARTIFACT_DIR, `${name}.png`) });
  await testInfo.attach(name, {
    path: join(ARTIFACT_DIR, `${name}.png`),
    contentType: "image/png",
  });
}

// Resolves a CSS value (var() or calc) to CSS pixels, as the browser computes it.
async function resolvePx(page: Page, value: string) {
  return page.evaluate((expr) => {
    const probe = document.createElement("div");
    probe.style.position = "absolute";
    probe.style.width = expr;
    document.body.append(probe);
    const px = probe.getBoundingClientRect().width;
    probe.remove();
    return px;
  }, value);
}

// Resolves a color value to [r, g, b, alpha] using the browser's own parser.
async function resolveColor(page: Page, value: string): Promise<Rgba> {
  return page.evaluate((expr) => {
    const probe = document.createElement("div");
    probe.style.background = expr;
    document.body.append(probe);
    const text = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const parts = text.match(/[\d.]+/g)!.map(Number);
    return [parts[0], parts[1], parts[2], parts[3] ?? 1] as Rgba;
  }, value);
}

function luminance([r, g, b]: Rgba) {
  const [R, G, B] = [r, g, b].map((channel) => {
    const v = channel / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function contrast(a: Rgba, b: Rgba) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

// Composites a translucent color over an opaque backdrop.
function over([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba {
  return [a * r + (1 - a) * br, a * g + (1 - a) * bg, a * b + (1 - a) * bb, 1];
}

async function openMailbox(page: Page, query: string, width = 1280) {
  await page.setViewportSize({ width, height: VIEWPORT.height });
  await page.goto(`/?${query}`);
  await expect(page.locator(".message-row").first()).toBeVisible();
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

function within(
  inner: { x: number; y: number; width: number; height: number },
  outer: { x: number; y: number; width: number; height: number },
) {
  const eps = 0.5;
  return (
    inner.x >= outer.x - eps &&
    inner.y >= outer.y - eps &&
    inner.x + inner.width <= outer.x + outer.width + eps &&
    inner.y + inner.height <= outer.y + outer.height + eps
  );
}

test.describe("dark surfaces", () => {
  // Failure mode 1.
  for (const mode of ["explicit", "system"] as const) {
    test(`hover separates from raised surface, ${mode} dark`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto(mode === "explicit" ? "/?theme=dark" : "/?theme=system");
      await expect(page.locator(".message-row").first()).toBeVisible();
      const hover = await resolveColor(page, "var(--surface-hover)");
      const raised = await resolveColor(page, "var(--surface-raised)");
      const ratio = contrast(hover, raised);
      await saveJson(`dark-hover-${mode}`, { hover, raised, ratio });
      expect(ratio).toBeGreaterThanOrEqual(1.3);
    });
  }

  // Failure mode 2.
  test("palette active option has a visible 2px inset outline", async ({
    page,
  }, testInfo) => {
    await page.goto("/?theme=dark");
    await expect(page.locator(".message-row").first()).toBeVisible();
    await page.keyboard.press("ControlOrMeta+K");
    const option = page
      .locator('.palette-option[aria-selected="true"]')
      .first();
    await expect(option).toBeVisible();
    const style = await option.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        outlineStyle: s.outlineStyle,
        outlineWidth: s.outlineWidth,
        outlineOffset: s.outlineOffset,
      };
    });
    await saveJson("palette-active", style);
    await shot(page, testInfo, "palette-active-dark");
    expect(style.outlineStyle).toBe("solid");
    expect(style.outlineWidth).toBe("2px");
    expect(style.outlineOffset).toBe("-2px");
  });

  // Failure mode 9.
  test("dark folder hover reads lighter than, and distinct from, selection", async ({
    page,
  }, testInfo) => {
    await page.goto("/?theme=dark");
    await expect(page.locator(".folder.active").first()).toBeVisible();
    const pane = page.locator(".folder-pane");
    const sidebar = await pane.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    const backdrop = await resolveColor(page, sidebar);
    const active = page.locator(".folder.active").first();
    const other = page.locator(".folder:not(.active)").first();
    const activeBg = over(
      await active.evaluate((el) => {
        const text = getComputedStyle(el).backgroundColor;
        return text
          .match(/[\d.]+/g)!
          .map(Number)
          .concat([1])
          .slice(0, 4) as Rgba;
      }),
      backdrop,
    );
    await other.hover();
    const hoverRgba = async () =>
      other.evaluate((el) => {
        const text = getComputedStyle(el).backgroundColor;
        return text
          .match(/[\d.]+/g)!
          .map(Number)
          .concat([1])
          .slice(0, 4) as Rgba;
      });
    // Wait out the 120ms background transition before reading the hover fill.
    await expect.poll(async () => (await hoverRgba())[3]).toBeGreaterThan(0);
    const hoverBg = over(await hoverRgba(), backdrop);
    await shot(page, testInfo, "folder-hover-dark");
    const ratio = contrast(activeBg, hoverBg);
    await saveJson("folder-hover-dark", { activeBg, hoverBg, ratio });
    expect(luminance(activeBg)).toBeGreaterThan(luminance(hoverBg));
    expect(ratio).toBeGreaterThanOrEqual(1.2);
  });
});

test.describe("targets and row actions at 200% text", () => {
  // Failure modes 3 and 4.
  for (const density of DENSITIES) {
    test(`row actions and select icon fit their targets, ${density} 200%`, async ({
      page,
    }, testInfo) => {
      await openMailbox(page, `density=${density}&scale=2&theme=light`);
      const row = page.locator(".message-row-wrap").first();
      await row.hover();
      const buttons = row.locator("button.row-action");
      const count = await buttons.count();
      const boxes = [];
      for (let i = 0; i < count; i += 1) {
        const button = buttons.nth(i);
        // The read action is hidden in narrow lists at large text.
        if (!(await button.isVisible())) continue;
        const box = await boxOf(button);
        const icon = await boxOf(button.locator("svg"));
        expect(within(icon, box), `icon inside button ${i}`).toBe(true);
        boxes.push(box);
      }
      const sorted = [...boxes].sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i += 1) {
        expect(sorted[i].x).toBeGreaterThanOrEqual(
          sorted[i - 1].x + sorted[i - 1].width - 0.5,
        );
      }
      const minTarget = density === "compact" ? 32 : 36;
      for (const box of boxes)
        expect(box.height).toBeGreaterThanOrEqual(minTarget);

      await shot(page, testInfo, `row-actions-${density}-200`);
      await saveJson(`row-actions-${density}-200`, { buttons: boxes });

      // Selection mode swaps row actions for the checkbox hit area.
      await page
        .locator(".pane-heading-actions")
        .getByRole("button", { name: "Select", exact: true })
        .click();
      const hit = await boxOf(page.locator(".message-select-hit").first());
      const select = await boxOf(page.locator(".message-select").first());
      expect(within(select, hit)).toBe(true);
      expect(hit.width).toBeGreaterThanOrEqual(minTarget);
      await shot(page, testInfo, `select-200-${density}`);
      await saveJson(`select-200-${density}`, { select, hit });
    });
  }

  test("normal targets grow with text size", async ({ page }) => {
    await page.goto("/?density=normal&scale=1&theme=light");
    await expect(page.locator(".message-row").first()).toBeVisible();
    const at1 = await resolvePx(page, "var(--target-size)");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    const at2 = await resolvePx(page, "var(--target-size)");
    expect(at1).toBeGreaterThanOrEqual(36);
    expect(at2).toBeGreaterThan(at1);
  });
});

test.describe("forced colors", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
  });

  // Failure mode 6.
  test("row hover hides the date and keeps the action pill opaque", async ({
    page,
  }, testInfo) => {
    await openMailbox(page, "density=normal&scale=1&theme=light");
    const row = page.locator(".message-row-wrap").first();
    await row.hover();
    await expect
      .poll(() =>
        page
          .locator(".message-row-wrap .row-actions")
          .first()
          .evaluate((el) => getComputedStyle(el).opacity),
      )
      .toBe("1");
    const state = await page.evaluate(() => {
      const wrap = document.querySelector(".message-row-wrap")!;
      const when = wrap.querySelector<HTMLElement>(".message-when")!;
      const pill = wrap.querySelector<HTMLElement>(".row-actions")!;
      return {
        whenVisibility: getComputedStyle(when).visibility,
        pillBackground: getComputedStyle(pill).backgroundColor,
        pillOpacity: getComputedStyle(pill).opacity,
      };
    });
    await shot(page, testInfo, "forced-row-hover");
    await saveJson("forced-row-hover", state);
    expect(state.whenVisibility).toBe("hidden");
    expect(state.pillOpacity).toBe("1");
    const alpha = state.pillBackground.match(/[\d.]+/g)!.map(Number)[3] ?? 1;
    expect(alpha).toBe(1);
  });

  // Failure mode 7.
  test("toolbar search box has a visible boundary", async ({ page }) => {
    await openMailbox(page, "density=normal&scale=1&theme=light");
    const style = await page
      .locator(".search-box")
      .first()
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return { style: s.borderTopStyle, width: s.borderTopWidth };
      });
    expect(style.style).toBe("solid");
    expect(style.width).toBe("1px");
  });

  // Failure mode 8.
  test("sidebar folder icons do not keep the accent color", async ({
    page,
  }) => {
    await openMailbox(page, "density=normal&scale=1&theme=light");
    const color = await page
      .locator(".folder svg")
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    await saveJson("forced-folder-icon", { color });
    expect(color).not.toBe("rgb(0, 111, 201)");
  });
});

test.describe("toast, filters, avatars, toolbar", () => {
  // Failure mode 10.
  test("undo toast wraps its actions at 200% in a narrow window", async ({
    page,
  }, testInfo) => {
    await openMailbox(page, "density=normal&scale=2&theme=light", 420);
    const row = page.getByRole("option", { name: /Weekend plans/i });
    await row.focus();
    await page.keyboard.press("e");
    const toast = page.locator(".notice-region .toast").first();
    await expect(toast).toBeVisible();
    const undo = toast.getByRole("button", { name: "Undo" });
    const metrics = await toast.evaluate((el) => ({
      overflow: el.scrollWidth - el.clientWidth,
    }));
    const toastBox = await boxOf(toast);
    const undoBox = await boxOf(undo);
    const messageBox = await boxOf(toast.locator(":scope > span").first());
    await shot(page, testInfo, "toast-narrow-200");
    await saveJson("toast-narrow-200", {
      ...metrics,
      toastBox,
      undoBox,
      messageBox,
    });
    expect(metrics.overflow).toBeLessThanOrEqual(1);
    expect(within(undoBox, toastBox)).toBe(true);
    // Actions drop below the message, so the message keeps a readable width.
    expect(messageBox.width).toBeGreaterThanOrEqual(240);
  });

  // Failure mode 11.
  test("filter segment focus ring matches the shared 3px ring", async ({
    page,
  }) => {
    await openMailbox(page, "density=normal&scale=1&theme=light");
    const input = page.locator(".mailbox-filter-segment input").first();
    await input.focus();
    const outline = await input.evaluate((el) => {
      const segment = el.closest(".mailbox-filter-segment")!;
      const focused = el.matches(":focus-visible");
      return {
        focused,
        width: getComputedStyle(segment).outlineWidth,
      };
    });
    expect(outline.focused).toBe(true);
    expect(outline.width).toBe("3px");
  });

  // Failure mode 12 (a wrapped track is a rounded panel).
  test("filter segments stay on one row at 200% text", async ({
    page,
  }, testInfo) => {
    await openMailbox(page, "density=normal&scale=2&theme=light", 640);
    const layout = await page.evaluate(() => {
      const segments = [
        ...document.querySelectorAll<HTMLElement>(".mailbox-filter-segment"),
      ];
      const control = document.querySelector<HTMLElement>(
        ".mailbox-filter-control",
      )!;
      const box = control.getBoundingClientRect();
      const inside = segments.every((el) => {
        const r = el.getBoundingClientRect();
        return r.left >= box.left - 1 && r.right <= box.right + 1;
      });
      return {
        radius: getComputedStyle(control).borderRadius,
        inside,
        rows: new Set(segments.map((el) => Math.round(el.offsetTop))).size,
        controlHeight: box.height,
      };
    });
    await shot(page, testInfo, "filter-200-narrow");
    await saveJson("filter-200-narrow", layout);
    // A wrapped track keeps its segments inside a panel, not a pill.
    expect(layout.inside).toBe(true);
    expect(layout.radius).not.toBe("999px");
  });

  // Failure mode 13.
  for (const density of DENSITIES) {
    test(`avatar tokens scale with text, ${density}`, async ({ page }) => {
      await page.goto(`/?density=${density}&scale=1&theme=light`);
      await expect(page.locator(".message-row").first()).toBeVisible();
      const names = ["account-avatar-size", "sender-avatar-size"];
      const at1 = [];
      for (const name of names)
        at1.push(await resolvePx(page, `var(--${name})`));
      // A stylesheet, not inline style: settings re-applies inline font size.
      await page.addStyleTag({
        content: "html { font-size: 200% !important; }",
      });
      const at2s = [];
      for (const name of names)
        at2s.push(await resolvePx(page, `var(--${name})`));
      await saveJson(`avatar-${density}`, { at1, at2s });
      for (const [index] of names.entries()) {
        expect(at2s[index] / at1[index]).toBeGreaterThan(1.9);
      }
    });
  }

  // Failure mode 14.
  for (const density of DENSITIES) {
    test(`compose drops its label and search stays usable at 200%, ${density}`, async ({
      page,
    }, testInfo) => {
      await openMailbox(page, `density=${density}&scale=2&theme=light`);
      const label = await page
        .locator(".compose-button > span")
        .first()
        .evaluate((el) => getComputedStyle(el).display);
      const searchWidth = await page
        .locator(".search-box > input")
        .first()
        .evaluate((el) => el.clientWidth);
      await shot(page, testInfo, `toolbar-200-${density}`);
      await saveJson(`toolbar-200-${density}`, { label, searchWidth });
      expect(label).toBe("none");
      expect(searchWidth).toBeGreaterThanOrEqual(120);
    });
  }

  // Failure mode 15.
  test("comfortable 200% subject text ends with an ellipsis", async ({
    page,
  }, testInfo) => {
    await openMailbox(page, "density=comfortable&scale=2&theme=light", 700);
    const subject = await page.evaluate(() => {
      const spans = [
        ...document.querySelectorAll<HTMLElement>(".message-subject > span"),
      ];
      return spans.map((el) => ({
        overflow: getComputedStyle(el).textOverflow,
        clipped: el.scrollWidth > el.clientWidth,
      }));
    });
    await shot(page, testInfo, "subject-comfortable-200");
    await saveJson("subject-comfortable-200", subject);
    for (const item of subject) expect(item.overflow).toBe("ellipsis");
  });
});

// Writes the hovered-row matrix for review: density x text scale x theme.
test("hovered row matrix artifacts", async ({ page }, testInfo) => {
  const summary: Record<string, unknown> = {};
  for (const density of DENSITIES) {
    for (const scale of [1, 2]) {
      for (const theme of ["light", "dark"]) {
        const name = `matrix-${density}-${scale * 100}-${theme}`;
        await openMailbox(
          page,
          `density=${density}&scale=${scale}&theme=${theme}`,
        );
        await page.locator(".message-row-wrap").first().hover();
        await shot(page, testInfo, name);
        summary[name] = true;
      }
    }
  }
  await page.emulateMedia({ forcedColors: "active" });
  await openMailbox(page, "density=normal&scale=1&theme=light");
  await page.locator(".message-row-wrap").first().hover();
  await shot(page, testInfo, "matrix-forced-normal");
  await saveJson("matrix-index", summary);
});
