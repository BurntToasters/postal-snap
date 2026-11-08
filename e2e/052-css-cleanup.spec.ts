import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifactsAfterEach } from "./ipc";

test.afterEach(attachArtifactsAfterEach);

// Failure modes covered here (WP2.4 dead CSS and conflicts):
// FM1. Removed selectors and custom properties are gone from document.styleSheets.
// FM2. .folder-pane computes overflow hidden (the sidebar rule wins, no duplicate).
// FM3. !important outside a11y.css, window-fx.css, and responsive.css print
//      blocks stays at or below 8.
// FM4. The setup provider badge keeps its accent ink and xs size without !important.

const STYLES_DIR = join(process.cwd(), "src", "styles");
// a11y.css and window-fx.css are accessibility and FX overrides, so they are
// skipped whole. responsive.css only loses its @media print block.
const WHOLE_EXEMPT = new Set(["a11y.css", "window-fx.css"]);
const REMOVED = [
  ".account-select-label",
  ".account-select-wrap",
  "--account-select-arrow-space",
  ".app-loading",
  ".brand-watermark",
  ".composer-from-value",
  ".search-recent-row",
  ".search-recent-forget",
];

test.beforeEach(async ({ page }) => installMockIpc(page));

// Drops comments and, when asked, @media print blocks (brace-matched).
function scrub(css: string, dropPrint: boolean): string {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  if (!dropPrint) return bare;
  let out = "";
  let i = 0;
  while (i < bare.length) {
    const at = bare.indexOf("@media", i);
    if (at < 0) {
      out += bare.slice(i);
      break;
    }
    const open = bare.indexOf("{", at);
    if (!/print/.test(bare.slice(at, open))) {
      out += bare.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    out += bare.slice(i, at);
    let depth = 0;
    let end = open;
    for (; end < bare.length; end += 1) {
      if (bare[end] === "{") depth += 1;
      if (bare[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    i = end + 1;
  }
  return out;
}

test("FM1 removed dead selectors and custom properties are absent from document.styleSheets", async ({
  page,
}) => {
  await page.goto("/?density=normal&scale=1");
  await expect(page.locator(".folder-pane")).toBeVisible();
  const found = await page.evaluate((names) => {
    const hits: string[] = [];
    const visit = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        // Custom properties match in declarations; classes match in selectors.
        const selector =
          "selectorText" in rule ? String(rule.selectorText) : "";
        for (const name of names) {
          // Whole-token match so ".app-loading" does not hit a longer name.
          const token = new RegExp(
            `${name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}(?![\\w-])`,
          );
          const hit = name.startsWith("--")
            ? token.test(rule.cssText)
            : token.test(selector);
          if (hit) hits.push(name);
        }
        const nested = (rule as CSSGroupingRule).cssRules;
        if (nested) visit(nested);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        visit(sheet.cssRules);
      } catch {
        // Cross-origin sheets are not ours; skip them.
      }
    }
    return [...new Set(hits)];
  }, REMOVED);
  expect(found, "removed selectors still styled").toEqual([]);
});

test("FM2 .folder-pane computes overflow hidden with no duplicate overflow rule", async ({
  page,
}) => {
  await page.goto("/?density=normal&scale=1");
  const pane = page.locator(".folder-pane");
  await expect(pane).toBeVisible();
  const overflow = await pane.evaluate((el) => {
    const style = getComputedStyle(el);
    return { x: style.overflowX, y: style.overflowY };
  });
  expect(overflow).toEqual({ x: "hidden", y: "hidden" });
});

test("FM4 setup provider badge keeps accent ink and xs size without !important", async ({
  page,
}) => {
  await page.goto("/?firstRun=1&density=normal&scale=1");
  // Walk the setup steps until the provider picker shows.
  const next = page.getByRole("button", { name: "Continue", exact: true });
  for (let i = 0; i < 4; i += 1) {
    if (await page.locator(".setup-flow .provider-button").first().isVisible())
      break;
    await next.click();
  }
  const badge = page.locator(".setup-flow .provider-badge").first();
  await expect(badge).toBeVisible();
  const style = await badge.evaluate((el) => {
    const computed = getComputedStyle(el);
    return { color: computed.color, fontSize: computed.fontSize };
  });
  // --accent-ink in light mode, and 0.75rem at 16px root.
  expect(style).toEqual({ color: "rgb(0, 87, 158)", fontSize: "12px" });
});

test("FM3 !important outside a11y, window-fx and print blocks is at most 8", async () => {
  const names = (await readdir(STYLES_DIR)).filter((n) => n.endsWith(".css"));
  const counts: Record<string, number> = {};
  let total = 0;
  for (const name of names) {
    if (WHOLE_EXEMPT.has(name)) continue;
    const css = await readFile(join(STYLES_DIR, name), "utf8");
    const body = scrub(css, name === "responsive.css");
    const n = body.match(/!important/g)?.length ?? 0;
    if (n > 0) counts[name] = n;
    total += n;
  }
  expect(total, JSON.stringify(counts)).toBeLessThanOrEqual(8);
});
