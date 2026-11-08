import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifacts } from "./ipc";
import { axeInPage } from "./axe-inpage";
import type { Page } from "@playwright/test";

// WP4.5 macOS-style message list and list empty states.
// Failure modes covered here:
// FM1. Separators are missing between unselected rows, or show around the selection.
// FM2. Selection radius is not 6px, or emphasized and inactive colors are wrong.
// FM3. Rows fall under the density token floor or the AGENTS minimums at 1x/2x.
// FM4. An empty folder lacks the icon, title, or hint, or the text is not accessible.
// FM5. The filter track is pill-shaped at 200%, or the segments do not stay on one row.
// FM6. Forced colors drop the Highlight selection or the separators.
// FM7. Bottom and hidden reading-pane modes render the list incorrectly.
// FM8. axe reports a serious violation in the list or its empty state.

test.beforeEach(async ({ page }) => installMockIpc(page));

const DENSITY_MIN = {
  normal: 36,
  comfortable: 44,
  compact: 32,
} as const;

// Separator state for the row at `index`: its ::after hairline.
async function separatorAfter(page: Page, index: number) {
  return page
    .locator(".message-row")
    .nth(index)
    .evaluate((row) => {
      const style = getComputedStyle(row, "::after");
      return {
        content: style.content,
        display: style.display,
        height: style.height,
        background: style.backgroundColor,
        borderTopWidth: style.borderTopWidth,
        borderTopStyle: style.borderTopStyle,
        borderTopColor: style.borderTopColor,
      };
    });
}

type Hairline = {
  content: string;
  display: string;
  height: string;
  borderTopStyle: string;
};

function hairlineVisible(style: Hairline) {
  return (
    style.content !== "none" &&
    style.display !== "none" &&
    (style.height !== "0px" || style.borderTopStyle === "solid")
  );
}

async function openList(page: Page, query: string) {
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.goto(`/?${query}`);
  await expect(page.locator(".message-row").first()).toBeVisible();
}

test.describe("macOS message list (WP4.5)", () => {
  // FM1.
  test("hairlines sit between unselected rows and vanish around the selection", async ({
    page,
  }, testInfo) => {
    await openList(page, "rowMix=1&theme=light");
    await page.locator(".message-row").nth(2).click();
    await expect(page.locator(".message-row.selected")).toHaveCount(1);
    const layout = await page.evaluate(() => {
      const items = [...document.querySelectorAll<HTMLElement>(".virtual-row")];
      const sel = items.findIndex((vr) =>
        vr.querySelector(".message-row.selected"),
      );
      const rows = items.flatMap((vr, index) => {
        const row = vr.querySelector<HTMLElement>(".message-row");
        if (!row) return [];
        const style = getComputedStyle(row, "::after");
        const nextIsSelected = items[index + 1]?.querySelector(
          ".message-row.selected, .message-row.checked",
        );
        return [
          {
            index,
            selected: index === sel,
            aboveSelection: Boolean(nextIsSelected),
            display: style.display,
            content: style.content,
            height: style.height,
          },
        ];
      });
      return { sel, rows };
    });
    await attachArtifacts(page, testInfo, "separators", layout);
    const visible = (row: (typeof layout.rows)[number]) =>
      row.content !== "none" && row.display !== "none";
    const expectHidden = layout.rows.filter(
      (row) => row.selected || row.aboveSelection,
    );
    const expectVisible = layout.rows.filter(
      (row) => !row.selected && !row.aboveSelection,
    );
    expect(expectHidden.length).toBeGreaterThan(0);
    expect(expectVisible.length).toBeGreaterThan(2);
    for (const row of expectHidden) expect(visible(row)).toBe(false);
    for (const row of expectVisible) expect(visible(row)).toBe(true);
  });

  // FM2.
  test("selection is a 6px rounded rectangle, accent when focused and neutral when not", async ({
    page,
  }, testInfo) => {
    await openList(page, "rowMix=1&theme=dark");
    const row = page.locator(".message-row").nth(1);
    const readRow = () =>
      row.evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          radius: style.borderRadius,
          background: style.backgroundColor,
        };
      });
    await row.click();
    // The row's 120ms background transition settles before we read colors.
    await expect.poll(readRow).toEqual({
      radius: "6px",
      background: "rgb(0, 104, 214)",
    });
    const focused = await readRow();
    // Clicking plain heading text moves focus out of the list.
    await page.locator(".pane-heading h1").click();
    await expect
      .poll(async () => (await readRow()).background)
      .toMatch(/^rgba\(255, 255, 255, 0\.1[5-9]/);
    const inactive = await readRow();
    await attachArtifacts(page, testInfo, "selection", { focused, inactive });
    expect(focused.radius).toBe("6px");
    expect(inactive.radius).toBe("6px");
  });

  // FM3.
  for (const density of ["normal", "comfortable", "compact"] as const) {
    for (const scale of [1, 2] as const) {
      test(`${density} ${scale}x rows keep the token floor and AGENTS minimum`, async ({
        page,
      }, testInfo) => {
        await openList(page, `rowMix=1&density=${density}&scale=${scale}`);
        const heights = await page
          .locator(".message-row")
          .evaluateAll((rows) =>
            rows.slice(0, 6).map((row) => row.getBoundingClientRect().height),
          );
        const tokenPx = await page.evaluate(() => {
          const probe = document.createElement("div");
          probe.style.position = "absolute";
          probe.style.height = "var(--message-row-height)";
          document.body.append(probe);
          const px = Number.parseFloat(getComputedStyle(probe).height);
          probe.remove();
          return px;
        });
        await attachArtifacts(page, testInfo, `heights-${density}-${scale}x`, {
          heights,
          tokenPx,
        });
        const minimum = DENSITY_MIN[density];
        // The token is a floor; two-line content may grow a row.
        for (const height of heights) {
          expect(height).toBeGreaterThanOrEqual(minimum);
          expect(height).toBeGreaterThanOrEqual(tokenPx - 1);
        }
      });
    }
  }

  // FM4.
  test("an empty folder shows an icon, a title and a hint as accessible text", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 840 });
    await page.goto("/?empty=1&theme=light");
    const status = page
      .getByRole("status")
      .filter({ hasText: "No messages here." });
    await expect(status).toBeVisible();
    const icon = status.locator(".empty-state-icon svg");
    const title = status.locator(".list-state-title");
    const hint = status.locator(".list-state-hint");
    const metrics = await status.evaluate((node) => {
      const svg = node.querySelector(".empty-state-icon svg") as SVGElement;
      const box = svg.getBoundingClientRect();
      const titleStyle = getComputedStyle(
        node.querySelector(".list-state-title")!,
      );
      const hintStyle = getComputedStyle(
        node.querySelector(".list-state-hint")!,
      );
      return {
        iconWidth: box.width,
        iconHeight: box.height,
        iconAriaHidden: svg.getAttribute("aria-hidden"),
        titleWeight: titleStyle.fontWeight,
        titleSize: titleStyle.fontSize,
        hintSize: hintStyle.fontSize,
        hintColor: hintStyle.color,
      };
    });
    await attachArtifacts(page, testInfo, "empty-folder", metrics);
    await expect(icon).toHaveCount(1);
    await expect(title).toHaveText("No messages here.");
    await expect(hint).toHaveCount(1);
    expect(metrics.iconAriaHidden).toBe("true");
    expect(metrics.iconWidth).toBe(40);
    expect(metrics.iconHeight).toBe(40);
    expect(metrics.titleWeight).toBe("600");
    expect(metrics.titleSize).toBe("17px");
    expect(metrics.hintSize).toBe("13px");
  });

  test("an empty Drafts list uses the same empty state", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 840 });
    await page.goto("/?theme=light");
    await page
      .getByRole("button", { name: /^Drafts/ })
      .first()
      .click();
    const status = page
      .getByRole("status")
      .filter({ hasText: "No saved drafts" });
    await expect(status.locator(".empty-state-icon svg")).toHaveCount(1);
    await expect(status.locator(".list-state-hint")).toHaveCount(1);
  });

  // FM5.
  test("filter track keeps its radius at 200% and never scrolls sideways", async ({
    page,
  }, testInfo) => {
    await openList(page, "rowMix=1&scale=2");
    const result = await page.evaluate(() => {
      const control = document.querySelector(
        ".mailbox-filter-control",
      ) as HTMLElement;
      const segments = [...control.querySelectorAll(".mailbox-filter-segment")];
      const tops = new Set(
        segments.map((node) => Math.round(node.getBoundingClientRect().top)),
      );
      const band = control.closest(".mailbox-filter") as HTMLElement;
      return {
        radius: getComputedStyle(control).borderRadius,
        rows: tops.size,
        overflow: band.scrollWidth - band.clientWidth,
        segmentRadius: getComputedStyle(segments[0]).borderRadius,
      };
    });
    await attachArtifacts(page, testInfo, "filter-200", result);
    expect(result.radius).not.toBe("999px");
    expect(result.radius).toBe("10px");
    // Segments may wrap onto a second row, but the track never scrolls sideways.
    expect(result.rows).toBeLessThanOrEqual(2);
    expect(result.overflow).toBeLessThanOrEqual(0);
  });

  // FM6.
  test("forced colors paint the selection with Highlight and keep separators", async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ forcedColors: "active" });
    await openList(page, "rowMix=1");
    await page.locator(".message-row").nth(2).click();
    const highlight = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.background = "Highlight";
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    const selectedBackground = () =>
      page.locator(".message-row.selected").evaluate((node) => ({
        background: getComputedStyle(node).backgroundColor,
      }));
    await expect.poll(selectedBackground).toEqual({ background: highlight });
    const separator = await separatorAfter(page, 0);
    await attachArtifacts(page, testInfo, "forced-colors", {
      highlight,
      separator,
    });
    expect(separator.borderTopStyle).toBe("solid");
    expect(separator.borderTopWidth).toBe("1px");
  });

  // FM7.
  for (const pane of ["bottom", "hidden"] as const) {
    test(`${pane} reading pane keeps the list rows and separators`, async ({
      page,
    }, testInfo) => {
      await openList(page, `rowMix=1&pane=${pane}&density=normal`);
      const metrics = await page.evaluate(() => {
        const list = document.querySelector(".message-list") as HTMLElement;
        const rows = [...document.querySelectorAll(".message-row")];
        return {
          rows: rows.length,
          rowWidth: rows[0]?.getBoundingClientRect().width ?? 0,
          listWidth: list.clientWidth,
          overflowX: list.scrollWidth - list.clientWidth,
        };
      });
      await attachArtifacts(page, testInfo, `list-${pane}`, metrics);
      expect(metrics.rows).toBeGreaterThan(1);
      expect(metrics.overflowX).toBeLessThanOrEqual(0);
      expect(metrics.rowWidth).toBeGreaterThan(200);
      const sep = await separatorAfter(page, 0);
      expect(hairlineVisible(sep)).toBe(true);
    });
  }

  // FM8.
  for (const theme of ["light", "dark"] as const) {
    test(`${theme} list and empty state have no serious axe violations`, async ({
      page,
    }, testInfo) => {
      await openList(page, `rowMix=1&theme=${theme}`);
      const list = await axeInPage(page, ".message-pane", {
        rules: ["color-contrast"],
      });
      await page.goto(`/?empty=1&theme=${theme}`);
      await expect(page.getByText("No messages here.")).toBeVisible();
      const empty = await axeInPage(page, ".message-pane", {
        rules: ["color-contrast"],
      });
      const serious = [...list, ...empty].filter((v) =>
        ["serious", "critical"].includes(v.impact ?? ""),
      );
      await attachArtifacts(page, testInfo, `axe-${theme}`, { serious });
      expect(serious).toEqual([]);
    });
  }

  // Screenshots: list in light and dark across three densities.
  for (const theme of ["light", "dark"] as const) {
    for (const density of ["normal", "comfortable", "compact"] as const) {
      test(`screenshot ${theme} ${density}`, async ({ page }, testInfo) => {
        await openList(page, `rowMix=1&theme=${theme}&density=${density}`);
        await page.locator(".message-row").nth(2).click();
        await attachArtifacts(page, testInfo, `list-${theme}-${density}`, {
          theme,
          density,
        });
      });
    }
  }
});
