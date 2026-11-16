import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifacts, attachArtifactsAfterEach } from "./ipc";
import { axeInPage } from "./axe-inpage";

test.afterEach(attachArtifactsAfterEach);

// WP4.7 macOS System Settings window.
// FM1. The window radius is not 16px, has no --shadow-window box-shadow, or exceeds 56x40rem.
// FM2. The search field is not in the nav column or not keyboard reachable, or it hides results.
// FM3. Nav icons lack tinted tone tiles with white glyphs, or keep tiles under forced colors.
// FM4. Nav selection is not inactive without nav focus, or not emphasized with focus, or keeps a shadow.
// FM5. Groups are not md radius on the group canvas, or rows lack inset separators.
// FM6. 200% text or a narrow window scrolls horizontally.
// FM7. Focus escapes the window, or Escape stops closing it.
// FM8. Axe reports serious or critical violations in light or dark.

test.beforeEach(async ({ page }) => installMockIpc(page));

const VIEWPORT = { width: 1280, height: 840 };
const TONES: Record<string, string> = {
  blue: "rgb(0, 122, 255)",
  gray: "rgb(142, 142, 147)",
  indigo: "rgb(88, 86, 214)",
  green: "rgb(40, 167, 69)",
  orange: "rgb(208, 109, 0)",
  red: "rgb(215, 0, 21)",
};

async function openSettings(page: Page, query: string) {
  await page.setViewportSize(VIEWPORT);
  await page.goto(`/?${query}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator(".settings-window")).toBeVisible();
}

async function openTab(page: Page, name: string) {
  await page.getByRole("tab", { name, exact: true }).click();
}

test("FM1 window uses xl radius, window shadow, and stays within 56x40rem", async ({
  page,
}) => {
  await openSettings(page, "density=normal&scale=1&theme=light");
  const win = page.locator(".settings-window");
  const style = await win.evaluate((node) => {
    const s = getComputedStyle(node);
    return { radius: s.borderTopLeftRadius, shadow: s.boxShadow };
  });
  expect(style.radius).toBe("16px");
  expect(style.shadow).toContain("60px");
  expect(style.shadow).toContain("rgba(0, 0, 0, 0.25)");
  const box = await win.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(56 * 16);
  expect(box!.height).toBeLessThanOrEqual(40 * 16);
  await attachArtifacts(page, test.info(), "fm1-window", { style });
});

test("FM2 search sits in the nav column and is reachable by Tab", async ({
  page,
}) => {
  await openSettings(page, "density=normal&scale=1&theme=light");
  const search = page.getByRole("searchbox", { name: "Search settings" });
  const nav = page.locator(".settings-nav");
  const searchBox = await search.boundingBox();
  const navBox = await nav.boundingBox();
  const contentBox = await page.locator(".settings-content").boundingBox();
  expect(searchBox!.x + searchBox!.width).toBeLessThanOrEqual(
    contentBox!.x + 1,
  );
  expect(searchBox!.y + searchBox!.height).toBeLessThanOrEqual(navBox!.y + 1);

  await page.getByRole("button", { name: "Close settings" }).focus();
  await page.keyboard.press("Tab");
  await expect(search).toBeFocused();

  await search.fill("Appearance");
  await expect(
    page.locator(".settings-search-result strong", { hasText: /Appearance/ }),
  ).not.toHaveCount(0);
  await attachArtifacts(page, test.info(), "fm2-search");
});

test("FM3 nav icons sit on tinted tone tiles with white glyphs", async ({
  page,
}) => {
  await openSettings(page, "density=normal&scale=1&theme=light");
  const tiles = page.locator(".settings-nav .settings-nav-tile[data-tone]");
  await expect(tiles).toHaveCount(10);
  const found = await tiles.evaluateAll((nodes) =>
    nodes.map((node) => ({
      tone: node.getAttribute("data-tone"),
      bg: getComputedStyle(node).backgroundColor,
      glyph: getComputedStyle(node.querySelector("svg")!).color,
      width: node.getBoundingClientRect().width,
    })),
  );
  for (const tile of found) {
    expect(tile.bg, tile.tone!).toBe(TONES[tile.tone!]);
    expect(tile.glyph, tile.tone!).toBe("rgb(255, 255, 255)");
    expect(tile.width, tile.tone!).toBeCloseTo(22, 0);
  }
  await page.emulateMedia({ forcedColors: "active" });
  const plain = await tiles.evaluateAll((nodes) =>
    nodes.map((node) => getComputedStyle(node).backgroundColor),
  );
  for (const bg of plain) expect(Object.values(TONES)).not.toContain(bg);
  await attachArtifacts(page, test.info(), "fm3-tiles", { found, plain });
});

test("FM4 nav selection is inactive, then emphasized while nav has focus", async ({
  page,
}) => {
  await openSettings(page, "density=normal&scale=1&theme=light");
  const active = page.locator(".settings-nav button.active");
  await expect(active).toHaveText(/General/);
  const inactiveBg = await active.evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  expect(inactiveBg).toBe("rgba(0, 0, 0, 0.09)");
  await active.focus();
  const emphasized = await active.evaluate((node) => ({
    bg: getComputedStyle(node).backgroundColor,
    shadow: getComputedStyle(node).boxShadow,
  }));
  expect(emphasized.bg).toBe("rgb(0, 111, 201)");
  expect(emphasized.shadow).toBe("none");
  await attachArtifacts(page, test.info(), "fm4-selection", {
    inactiveBg,
    emphasized,
  });
});

test("FM5 groups use md radius on the group canvas with inset separators", async ({
  page,
}) => {
  await openSettings(page, "density=normal&scale=1&theme=light");
  await openTab(page, "Appearance");
  const group = page
    .locator(".settings-content .settings-group:has(> :nth-child(2))")
    .first();
  await expect(group).toBeVisible();
  const styles = await group.evaluate((node) => {
    const s = getComputedStyle(node);
    const canvas = getComputedStyle(node.closest(".settings-content")!);
    const row = node.children[1] as HTMLElement | undefined;
    return {
      radius: s.borderTopLeftRadius,
      bg: s.backgroundColor,
      canvas: canvas.backgroundColor,
      separator: row ? getComputedStyle(row, "::before").backgroundColor : "",
      separatorLeft: row ? getComputedStyle(row, "::before").left : "",
    };
  });
  expect(styles.radius).toBe("10px");
  expect(styles.bg).toBe("rgb(255, 255, 255)");
  expect(styles.canvas).toBe("rgb(245, 245, 247)");
  expect(styles.separator).toBe("rgba(0, 0, 0, 0.1)");
  await attachArtifacts(page, test.info(), "fm5-groups", styles);
});

test("FM6 200% text and a narrow window do not scroll horizontally", async ({
  page,
}) => {
  await openSettings(page, "density=normal&scale=2&theme=light");
  for (const name of ["General", "Accounts", "Appearance"]) {
    await openTab(page, name);
    const overflow = await page.evaluate(() => {
      const win = document.querySelector(".settings-window")!;
      const content = document.querySelector(".settings-content")!;
      return {
        win: win.scrollWidth - win.clientWidth,
        content: content.scrollWidth - content.clientWidth,
        page: document.documentElement.scrollWidth - innerWidth,
      };
    });
    expect(overflow.win, name).toBeLessThanOrEqual(1);
    expect(overflow.content, name).toBeLessThanOrEqual(1);
    expect(overflow.page, name).toBeLessThanOrEqual(1);
  }
  await attachArtifacts(page, test.info(), "fm6-200-percent");

  await page.setViewportSize({ width: 390, height: 780 });
  await page.waitForTimeout(50);
  const narrow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - innerWidth,
    content: (() => {
      const c = document.querySelector(".settings-content")!;
      return c.scrollWidth - c.clientWidth;
    })(),
  }));
  expect(narrow.page).toBeLessThanOrEqual(1);
  expect(narrow.content).toBeLessThanOrEqual(1);
  await attachArtifacts(page, test.info(), "fm6-narrow");
});

test("FM7 focus stays inside the window and Escape closes it", async ({
  page,
}) => {
  await openSettings(page, "density=normal&scale=1&theme=light");
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(
      () => !!document.activeElement?.closest(".settings-window"),
    );
    expect(inside, `Tab ${i}`).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-window")).toBeHidden();
  await attachArtifacts(page, test.info(), "fm7-escape");
});

for (const theme of ["light", "dark"] as const) {
  test(`FM8 ${theme} settings has no serious axe violations`, async ({
    page,
  }) => {
    await openSettings(page, `density=normal&scale=1&theme=${theme}`);
    const serious = (await axeInPage(page, ".settings-window")).filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(serious.map((v) => v.id)).toEqual([]);
    await attachArtifacts(page, test.info(), `fm8-axe-${theme}`);
  });
}

const DENSITIES = ["normal", "comfortable", "compact"] as const;
const TABS = ["General", "Accounts", "Appearance"] as const;
for (const density of DENSITIES) {
  for (const theme of ["light", "dark"] as const) {
    for (const tab of TABS) {
      test(`screenshot ${tab} ${theme} ${density}`, async ({ page }) => {
        await openSettings(page, `density=${density}&scale=1&theme=${theme}`);
        await openTab(page, tab);
        const minTarget = { normal: 36, comfortable: 44, compact: 32 }[density];
        const heights = await page
          .locator(".settings-nav button")
          .evaluateAll((nodes) =>
            nodes.map((node) => node.getBoundingClientRect().height),
          );
        for (const height of heights)
          expect(height).toBeGreaterThanOrEqual(minTarget);
        await attachArtifacts(
          page,
          test.info(),
          `settings-${tab.toLowerCase()}-${theme}-${density}`,
        );
      });
    }
  }
}
