import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifacts } from "./ipc";
import { BREAKPOINTS, MEDIA_QUERIES } from "../src/breakpoints";

// WP4.11 breakpoint consolidation: 560, 760, 900 as paired queries.
// Failure modes covered here:
// FM1. At 899px the sidebar is a drawer; at 900px it is a column (unchanged).
// FM2. At 760px the reader is an overlay; at 761px it is a split pane. The setup
//      card is narrow at 560px and wide at 561px.
// FM3. Any mailbox or setup view scrolls horizontally at a boundary width, in
//      every density, at 100% and 200% text.
// FM4. A width media query in src/styles uses a px value outside the set
//      560, 560.02, 760, 760.02, 899.98, 900 (print and prefers-* are exempt).
// FM5. A JS width threshold differs from the CSS one, or a component hard-codes
//      a max-width media string instead of importing MEDIA_QUERIES.

const DENSITIES = ["normal", "comfortable", "compact"] as const;
const BOUNDARY_WIDTHS = [559, 560, 561, 759, 760, 761, 899, 900] as const;
// Narrow sides are inclusive; wide sides start 0.02px above them (900 keeps 899.98).
const ALLOWED_MAX_PX = new Set(["560", "760", "899.98"]);
const ALLOWED_MIN_PX = new Set(["560.02", "760.02", "900"]);
const STYLES_DIR = resolve(import.meta.dirname, "../src/styles");
const SRC_DIR = resolve(import.meta.dirname, "../src");

test.beforeEach(async ({ page }) => installMockIpc(page));

async function openMailbox(
  page: import("@playwright/test").Page,
  query: string,
  width: number,
) {
  await page.setViewportSize({ width, height: 840 });
  await page.goto(`/?${query}`);
  await expect(page.locator(".message-row").first()).toBeVisible();
}

async function columnLayout(
  page: import("@playwright/test").Page,
  width: number,
) {
  await openMailbox(page, "density=normal&scale=1&hugeList=60&rowMix=1", width);
  const folder = await page.locator(".folder-pane").first().boundingBox();
  const list = await page.locator(".message-pane").first().boundingBox();
  return {
    column: Boolean(
      folder &&
      list &&
      folder.width > 0 &&
      folder.x >= -1 &&
      folder.x + folder.width <= list.x + 1,
    ),
  };
}

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return name === "tests" ? [] : tsFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

test("FM1 sidebar is a drawer at 899px and a column at 900px", async ({
  page,
}) => {
  const at899 = await columnLayout(page, 899);
  expect(at899.column, "899px is a drawer").toBe(false);

  const at900 = await columnLayout(page, 900);
  expect(at900.column, "900px is a column").toBe(true);
});

test("FM2 reader overlay switches after 760px and setup card after 560px", async ({
  page,
  browserName,
}, testInfo) => {
  const readerModal = async (width: number) => {
    await openMailbox(page, "density=normal&scale=1&pane=right", width);
    await page.getByRole("option", { name: /Weekend plans/i }).click();
    await expect(page.locator("#reader-pane")).toBeVisible();
    return page.locator("#reader-pane").getAttribute("aria-modal");
  };
  expect(await readerModal(760), "760px reader overlay").toBe("true");
  expect(await readerModal(761), "761px reader split").toBeNull();

  const setupPadding = async (width: number) => {
    await page.setViewportSize({ width, height: 840 });
    await page.goto("/?firstRun=1&density=normal&scale=1");
    const card = page.locator(".setup-card.setup-flow").first();
    await expect(card).toBeVisible();
    return card.evaluate((el) => getComputedStyle(el).paddingLeft);
  };
  const narrow = await setupPadding(560);
  const wide = await setupPadding(561);
  expect(narrow, "560px setup card is narrow").toBe("18px");
  expect(wide, "561px setup card is wide").not.toBe("18px");
  await attachArtifacts(page, testInfo, `fm2-${browserName}`, { narrow, wide });
});

test("FM3 no horizontal scroll at boundary widths", async ({
  page,
}, testInfo) => {
  const results: Record<string, boolean> = {};
  for (const width of BOUNDARY_WIDTHS) {
    for (const density of DENSITIES) {
      for (const scale of [1, 2]) {
        await openMailbox(page, `density=${density}&scale=${scale}`, width);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 1,
        );
        results[`mail-${width}-${density}-${scale}x`] = overflow;
      }
    }
  }
  for (const width of [559, 560, 561]) {
    for (const scale of [1, 2]) {
      await page.setViewportSize({ width, height: 840 });
      await page.goto(`/?firstRun=1&density=normal&scale=${scale}`);
      await expect(
        page.locator(".setup-card.setup-flow").first(),
      ).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      results[`setup-${width}-${scale}x`] = overflow;
    }
  }
  await attachArtifacts(page, testInfo, "fm3-overflow", { results });
  const offenders = Object.entries(results)
    .filter(([, overflow]) => overflow)
    .map(([key]) => key);
  expect(offenders, "widths that scroll horizontally").toEqual([]);
});

test("FM4 CSS width media queries use only the consolidated breakpoints", async () => {
  const offenders: string[] = [];
  for (const file of cssFiles(STYLES_DIR)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!line.includes("@media")) return;
      if (/@media\s+print/.test(line) || /prefers-/.test(line)) return;
      // Height queries are a separate axis and are not part of this set.
      for (const [, side, value] of line.matchAll(
        /\b(max|min)-width:\s*([\d.]+)px/g,
      )) {
        const allowed = side === "max" ? ALLOWED_MAX_PX : ALLOWED_MIN_PX;
        if (!allowed.has(value)) {
          offenders.push(`${file}:${index + 1} ${side}-width ${value}px`);
        }
      }
    });
  }
  expect(offenders, "non-consolidated width breakpoints").toEqual([]);
});

test("FM5 JS thresholds match CSS and no component hard-codes a width query", async () => {
  expect(BREAKPOINTS).toEqual({ xs: 560, sm: 760, md: 900 });
  expect(MEDIA_QUERIES.narrowViewport).toBe("(max-width: 760px)");
  expect(MEDIA_QUERIES.sidebarDrawer).toBe("(max-width: 899.98px)");

  const cssText = cssFiles(STYLES_DIR)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  expect(cssText).toContain("(max-width: 760px)");
  expect(cssText).toContain("(max-width: 899.98px)");

  const hardCoded = tsFiles(SRC_DIR).flatMap((file) => {
    const text = readFileSync(file, "utf8");
    return [...text.matchAll(/max-width:\s*[\d.]+px/g)].map(
      (m) => `${file}: ${m[0]}`,
    );
  });
  expect(hardCoded, "hard-coded width queries in TS").toEqual([]);
});
