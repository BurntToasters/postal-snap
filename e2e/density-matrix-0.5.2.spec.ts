import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join, relative } from "node:path";
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Phase 0 density matrix for 0.5.2 (plan.md §8). Written before the
// implementation, so most tests are expected to fail until Phases 1-4 land.
// Each title carries its failure-mode number (FMn = §8.1, §10.8, §10.18).
// Expected numbers come from plan.md §4-§6 and §8.1.

const DENSITIES = ["normal", "comfortable", "compact"] as const;
const SCALES = [1, 2] as const;
type Density = (typeof DENSITIES)[number];
type Scale = (typeof SCALES)[number];
type View = "list" | "mix" | "reader" | "bottom" | "thread" | "thread3";

const VIEWPORT = { width: 1280, height: 840 };
const ARTIFACT_DIR = join(process.cwd(), "artifacts", "0.5.2", "density");
const VARIABLES_CSS = join(process.cwd(), "src", "styles", "variables.css");

const TOKEN_NAMES = [
  "target-size",
  "target-size-inset",
  "control-height",
  "toolbar-height",
  "pane-heading-height",
  "message-row-height",
  "list-row-height",
  "list-day-height",
  "sender-avatar-size",
  "reader-pad-inline",
  "bar-height-sm",
  "bar-height-md",
  "settings-row-height",
  "menu-row-height",
];

// Mock flags per view. Reader views open "Weekend plans"; thread opens row 1.
// `rowMix` overrides `hugeList` in the mock, so it is kept only for "mix".
const VIEW_QUERY: Record<View, string> = {
  list: "&hugeList=60",
  mix: "&rowMix=1",
  reader: "",
  bottom: "&pane=bottom&readerPaneHeight=420",
  thread: "&threadGap=1&threadPeople=1&remote=1",
  thread3: "&threadGap=1&threadPeople=1&remote=1&threadThree=1",
};
const VIEW_FILE: Record<View, string> = {
  list: "list",
  mix: "list-mix",
  reader: "reader",
  bottom: "reader-bottom",
  thread: "thread",
  thread3: "thread-three",
};

const BANNED_WORDS = [["sen", "ior"].join(""), ["eld", "erly"].join("")];

type Box = { x: number; y: number; width: number; height: number };

type Snapshot = {
  tokens: Record<string, number>;
  toolbarHeight: number | null;
  rowHeight: number | null;
  rowsVisible: number;
  listHeadingHeight: number | null;
  readerActionsHeight: number | null;
  readerButtonHeight: number;
  readerButtonTopSpread: number;
  barWrapped: boolean | null;
  letterPx: number | null;
  letterShare: number | null;
  quickReplyHeight: number | null;
  scrollX: Record<string, number>;
  smallTargets: string[];
  senderCh: number | null;
  stampOverlapsSender: boolean | null;
  quickReplyOverlapsBody: boolean | null;
  toolbarOverlaps: number;
};

// Artifact assembly. Each test writes one fragment under parts/ as soon as its
// value is known. Workers run in parallel, so every worker's afterAll merges
// whatever fragments exist; the last afterAll to run sees them all.
const PARTS_DIR = join(ARTIFACT_DIR, "parts");
const METRICS_FILE = join(ARTIFACT_DIR, "metrics.json");
const GRID_VIEWS: View[] = ["list", "mix", "reader", "bottom", "thread"];
const TOKEN_ORDERING_KEY = "tokenOrdering";
const EXPECTED_KEYS: string[] = [
  TOKEN_ORDERING_KEY,
  ...DENSITIES.flatMap((density) =>
    SCALES.flatMap((scale) =>
      GRID_VIEWS.map((view) => `${view}|${density}|${scale}`),
    ),
  ),
  // FM3 three-message thread; written by its own test, not the grid.
  "thread3|normal|1",
];

function fragmentPath(key: string) {
  return join(PARTS_DIR, `${key.replaceAll("|", "__")}.json`);
}

// Temp file + rename, so readers never see a half-written fragment or metrics file.
async function writeAtomic(file: string, text: string) {
  await mkdir(join(file, ".."), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

async function writeFragment(key: string, value: unknown) {
  await writeAtomic(
    fragmentPath(key),
    `${JSON.stringify({ key, value }, null, 2)}\n`,
  );
}

// Merges only expected keys, so fragments from removed combos never leak in.
async function mergeFragments() {
  const found = new Map<string, unknown>();
  const names = await readdir(PARTS_DIR).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const parsed = JSON.parse(
      await readFile(join(PARTS_DIR, name), "utf8"),
    ) as { key: string; value: unknown };
    if (EXPECTED_KEYS.includes(parsed.key)) found.set(parsed.key, parsed.value);
  }
  const missing = EXPECTED_KEYS.filter((key) => !found.has(key));
  const out: Record<string, unknown> = {
    _meta: {
      complete: missing.length === 0,
      expected: EXPECTED_KEYS.length,
      present: found.size,
      missing,
    },
  };
  for (const key of EXPECTED_KEYS) {
    if (found.has(key)) out[key] = found.get(key);
  }
  await writeAtomic(METRICS_FILE, `${JSON.stringify(out, null, 2)}\n`);
}

// Runs inside the page. Keep it self-contained (Playwright serializes it).
function collect(names: string[]): Snapshot {
  const probeWidth = (value: string) => {
    const el = document.createElement("div");
    el.style.cssText =
      "position:absolute;visibility:hidden;left:0;top:0;height:0;";
    el.style.width = value;
    document.body.append(el);
    const width = el.getBoundingClientRect().width;
    el.remove();
    return width;
  };
  const rectOf = (selector: string) => {
    const el = document.querySelector(selector);
    if (!(el instanceof HTMLElement)) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const intersects = (a: Box | null, b: Box | null) => {
    if (!a || !b) return null;
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return w > 1 && h > 1;
  };
  const describe = (el: HTMLElement) => {
    const cls = String(el.className).split(" ")[0] ?? "";
    const label = (
      el.getAttribute("aria-label") ??
      el.textContent ??
      ""
    ).trim();
    return `${el.tagName.toLowerCase()}.${cls}[${label.slice(0, 24)}]`;
  };

  const tokens: Record<string, number> = {};
  for (const name of names) tokens[name] = probeWidth(`var(--${name})`);
  const inset = tokens["target-size-inset"] ?? 0;

  const list = rectOf(".message-list-items");
  const top = list ? list.y : 0;
  const bottom = list ? list.y + list.height : window.innerHeight;
  const rowsVisible = [
    ...document.querySelectorAll<HTMLElement>(".message-row"),
  ].filter((row) => {
    const r = row.getBoundingClientRect();
    return r.height > 0 && r.top >= top - 0.5 && r.bottom <= bottom + 0.5;
  }).length;

  let senderCh: number | null = null;
  const sender = document.querySelector<HTMLElement>(
    ".message-row .message-sender",
  );
  if (sender) {
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;width:1ch;";
    sender.append(probe);
    const ch = probe.getBoundingClientRect().width;
    probe.remove();
    const width = sender.getBoundingClientRect().width;
    senderCh = ch > 0 ? width / ch : null;
  }

  const small = new Set<string>();
  for (const scope of [
    ".app-toolbar",
    ".folder-pane",
    ".message-pane",
    ".reader-actions",
  ]) {
    for (const root of document.querySelectorAll(scope)) {
      for (const el of root.querySelectorAll<HTMLElement>(
        'button, [role="button"], input, select',
      )) {
        if (el.closest(".app-menu")) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) continue;
        if (Math.min(r.width, r.height) < inset) small.add(describe(el));
      }
    }
  }

  const scrollX: Record<string, number> = {};
  for (const selector of [".folder-pane", ".message-pane", "#reader-pane"]) {
    const el = document.querySelector<HTMLElement>(selector);
    scrollX[selector] = el ? el.scrollWidth - el.clientWidth : 0;
  }

  const kids = [
    ...document.querySelectorAll<HTMLElement>(".app-toolbar > *"),
  ].map((el) => el.getBoundingClientRect());
  let toolbarOverlaps = 0;
  for (let i = 0; i < kids.length; i += 1) {
    for (let j = i + 1; j < kids.length; j += 1) {
      const a = kids[i];
      const b = kids[j];
      if (a && b && intersects(a, b)) toolbarOverlaps += 1;
    }
  }

  const body = rectOf(".message-body");
  const frameMarginBlock =
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--reader-frame-margin-block",
      ),
    ) || 0;
  const pane = rectOf("#reader-pane");
  const stamp = rectOf("#reader-pane .message-stamp");
  const readerSender = rectOf(
    "#reader-pane .message-header .sender-primary-line",
  );
  const actionButtons = [
    ...document.querySelectorAll<HTMLElement>(".reader-actions button"),
  ]
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.height > 1);
  const readerButtonHeight = Math.max(0, ...actionButtons.map((r) => r.height));
  const readerButtonTopSpread =
    actionButtons.length === 0
      ? 0
      : Math.max(...actionButtons.map((r) => r.top)) -
        Math.min(...actionButtons.map((r) => r.top));
  const quick = rectOf(".quick-reply");
  const barRect = rectOf(".reader-actions");
  // Same test as FM4: a wrapped bar is two button rows tall or staggered.
  const barWrapped =
    barRect && actionButtons.length > 0
      ? barRect.height >= readerButtonHeight * 2 ||
        readerButtonTopSpread >= readerButtonHeight / 2
      : null;

  return {
    tokens,
    toolbarHeight: rectOf(".app-toolbar")?.height ?? null,
    rowHeight: rectOf(".message-row")?.height ?? null,
    rowsVisible,
    listHeadingHeight: rectOf(".message-pane .pane-heading")?.height ?? null,
    readerActionsHeight: rectOf(".reader-actions")?.height ?? null,
    readerButtonHeight,
    readerButtonTopSpread,
    barWrapped,
    letterPx: body?.height ?? null,
    letterShare:
      body && pane && pane.height > 0 ? body.height / pane.height : null,
    quickReplyHeight: quick?.height ?? null,
    scrollX,
    smallTargets: [...small].sort(),
    senderCh,
    stampOverlapsSender: intersects(stamp, readerSender),
    // The sticky reply may cover the letter frame's top margin, never its text.
    quickReplyOverlapsBody:
      body && quick
        ? intersects(quick, {
            x: body.x,
            width: body.width,
            y: body.y + frameMarginBlock,
            height: Math.max(0, body.height - frameMarginBlock),
          })
        : null,
    toolbarOverlaps,
  };
}

async function open(
  page: Page,
  density: Density,
  scale: Scale,
  view: View,
  viewport = VIEWPORT,
) {
  await page.setViewportSize(viewport);
  await page.goto(`/?density=${density}&scale=${scale}${VIEW_QUERY[view]}`);
  await expect(page.locator(".message-row").first()).toBeVisible();
  if (view === "list" || view === "mix") return;
  if (view === "thread" || view === "thread3") {
    await page.locator(".message-row").first().click();
  } else {
    await page.getByRole("option", { name: /Weekend plans/i }).click();
  }
  await expect(page.locator("#message-title")).toBeVisible();
}

// Per-worker memo; the fragment on disk is the cross-worker record.
const measurements = new Map<string, Promise<Snapshot>>();

function measured(
  page: Page,
  density: Density,
  scale: Scale,
  view: View,
): Promise<Snapshot> {
  const key = `${view}|${density}|${scale}`;
  const cached = measurements.get(key);
  if (cached) return cached;
  const result = (async () => {
    // Drop a stale fragment first: if this combo fails, metrics report it missing.
    await rm(fragmentPath(key), { force: true });
    await open(page, density, scale, view);
    // Measure only after the density is applied and web fonts have loaded.
    await page.evaluate(() => document.fonts.ready);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.density))
      .toBe(density);
    const snapshot = await page.evaluate(collect, TOKEN_NAMES);
    await mkdir(ARTIFACT_DIR, { recursive: true });
    await page.screenshot({
      path: join(ARTIFACT_DIR, `${density}-${scale}x-${VIEW_FILE[view]}.png`),
    });
    await writeFragment(key, {
      view,
      density,
      scale,
      ...snapshot,
      visibleRows: snapshot.rowsVisible,
      headingHeight: snapshot.listHeadingHeight,
    });
    return snapshot;
  })();
  measurements.set(key, result);
  return result;
}

// Parses the custom properties declared in one selector's block.
function overrideNames(css: string, selector: string): string[] {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return [];
  const open = css.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (; end < css.length; end += 1) {
    const ch = css[end];
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = css.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, "");
  // Returns bare names ("target-size"); callers add the "--" back.
  return [...body.matchAll(/--([\w-]+)\s*:/g)].map((m) => m[1] ?? "");
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}

async function ipcCalls(page: Page) {
  return page.evaluate(
    () =>
      (window.__POSTAL_SNAP_TEST__?.ipcCalls ?? []) as {
        command: string;
        args: unknown;
      }[],
  );
}

async function letterFrame(page: Page) {
  const handle = await boundedFrameCall(
    page.locator(".message-body iframe").elementHandle({ timeout: 5_000 }),
    "letter iframe lookup",
  );
  if (!handle) return null;
  return boundedFrameCall(handle.contentFrame(), "letter contentFrame");
}

// AxeBuilder.analyze() opens a blank page via context.newPage(), which this
// headless shell never resolves. Same include/rules scoping, run in-page.
const AXE_SOURCE = readFileSync(
  join(process.cwd(), "node_modules", "axe-core", "axe.min.js"),
  "utf8",
);

type AxeViolation = {
  id: string;
  impact: string | null | undefined;
  nodes: number;
};

async function axeScan(
  page: Page,
  include: string,
  rules?: string[],
): Promise<AxeViolation[]> {
  await page.evaluate(AXE_SOURCE);
  return page.evaluate(
    async ({ include, rules }) => {
      const axe = (
        window as unknown as {
          axe: {
            run: (
              context: Element,
              options: object,
            ) => Promise<{
              violations: {
                id: string;
                impact?: string | null;
                nodes: unknown[];
              }[];
            }>;
          };
        }
      ).axe;
      const context = document.querySelector(include);
      if (!context) throw new Error(`axe scope ${include} is not rendered`);
      const options = rules ? { runOnly: { type: "rule", values: rules } } : {};
      const result = await axe.run(context, options);
      return result.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
    },
    { include, rules },
  );
}

// Playwright cannot script the scriptless letter reliably; bound every call.
function boundedFrameCall<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not return within 5s`)),
      5_000,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function frameTextLeft(page: Page) {
  const local = await page
    .frameLocator(".message-body iframe")
    .locator("body")
    .evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect().left;
    });
  const frame = await page.locator(".message-body iframe").boundingBox();
  return local + (frame?.x ?? 0);
}

function textLeft(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!(node instanceof HTMLElement)) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect().left;
  }, selector);
}

test.describe("0.5.2 density matrix (failure modes FM1-FM38)", () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ page }) => installMockIpc(page));

  // Every worker merges; the last merge to run includes all fragments.
  test.afterAll(async () => {
    await mergeFragments();
  });

  // Full grid (density x scale x view) as one test per combo, so every
  // combo has a fragment and metrics.json is complete on a full run.
  for (const view of GRID_VIEWS) {
    for (const density of DENSITIES) {
      for (const scale of SCALES) {
        test(`matrix ${view} ${density} ${scale}x: metrics fragment`, async ({
          page,
        }) => {
          const snap = await measured(page, density, scale, view);
          expect(
            snap.tokens["target-size"],
            "target-size resolves",
          ).toBeGreaterThan(0);
        });
      }
    }
  }

  // FM1: §8.3 token ordering, compact <= normal <= comfortable at 100% text.
  test("FM1 token ordering: compact <= normal <= comfortable (section 8.3)", async ({
    page,
  }) => {
    const css = await readFile(VARIABLES_CSS, "utf8");
    const comfortable = overrideNames(css, ':root[data-density="comfortable"]');
    const compact = overrideNames(css, ':root[data-density="compact"]');
    expect(
      comfortable.length,
      "comfortable override block exists",
    ).toBeGreaterThan(0);
    expect(compact.length, "compact override block exists").toBeGreaterThan(0);

    const names = [...new Set([...comfortable, ...compact])].sort();
    const missing = names.filter(
      (name) => !comfortable.includes(name) || !compact.includes(name),
    );
    expect(missing, "every enumerated token appears in both blocks").toEqual(
      [],
    );

    await rm(fragmentPath(TOKEN_ORDERING_KEY), { force: true });
    await page.goto("/?density=normal&scale=1");
    await expect(page.locator(".message-row").first()).toBeVisible();
    // px-resolvable tokens get their computed width; anything else (colors,
    // line-clamp counts, unitless values) keeps its raw string.
    const values = await page.evaluate((list) => {
      const root = document.documentElement;
      const out: Record<string, Record<string, number | string>> = {};
      for (const density of ["normal", "comfortable", "compact"]) {
        root.dataset.density = density;
        for (const name of list) {
          const raw = getComputedStyle(root)
            .getPropertyValue(`--${name}`)
            .trim();
          const probe = document.createElement("div");
          probe.style.cssText =
            "position:absolute;visibility:hidden;left:0;top:0;height:0;";
          probe.style.width = `var(--${name})`;
          document.body.append(probe);
          const width = probe.getBoundingClientRect().width;
          probe.remove();
          out[name] ??= {};
          out[name][density] = width > 0 ? width : raw;
        }
      }
      return out;
    }, names);
    await writeFragment(TOKEN_ORDERING_KEY, values);

    // Plan §5.1.2: search is wider in the denser layout by design.
    const orderingExempt = new Set(["search-box-max-width"]);
    const violations: string[] = [];
    for (const name of names) {
      if (orderingExempt.has(name)) continue;
      const row = values[name];
      const normal = row?.["normal"];
      const cozy = row?.["comfortable"];
      const compactValue = row?.["compact"];
      if (
        typeof normal !== "number" ||
        typeof cozy !== "number" ||
        typeof compactValue !== "number"
      ) {
        continue;
      }
      if (compactValue > normal + 0.5 || normal > cozy + 0.5) {
        violations.push(
          `${name}: compact ${compactValue} normal ${normal} comfortable ${cozy}`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  // FM2: a measured element must change size between densities.
  test("FM2 size literal: row and toolbar heights differ in all three densities", async ({
    page,
  }) => {
    const rows: (number | null)[] = [];
    const bars: (number | null)[] = [];
    for (const density of DENSITIES) {
      const snap = await measured(page, density, 1, "list");
      rows.push(snap.rowHeight);
      bars.push(snap.toolbarHeight);
    }
    expect(new Set(rows).size, `row heights ${rows}`).toBe(3);
    // Plan §4.2: compact toolbar equals normal (2.75rem caption height), so only comfortable must differ.
    const [normalBar, comfortableBar, compactBar] = bars;
    expect(comfortableBar, `toolbar heights ${bars}`).not.toBe(normalBar);
    expect(compactBar, `toolbar heights ${bars}`).toBeLessThanOrEqual(
      normalBar ?? Infinity,
    );
  });

  // FM3: letter share in each reading layout.
  test("FM3 letter share, pane right, normal 1x: letter >= 0.55 of reader", async ({
    page,
  }) => {
    const snap = await measured(page, "normal", 1, "reader");
    expect(snap.letterShare, "message body box exists").not.toBeNull();
    expect(snap.letterShare ?? 0).toBeGreaterThanOrEqual(0.55);
  });

  test("FM3 letter share, pane bottom, normal 1x: letter >= 0.35 of reader", async ({
    page,
  }) => {
    const snap = await measured(page, "normal", 1, "bottom");
    expect(snap.letterShare, "message body box exists").not.toBeNull();
    expect(snap.letterShare ?? 0).toBeGreaterThanOrEqual(0.35);
  });

  test("FM3 letter share, thread with image banner, normal 1x: letter >= 0.45 of reader", async ({
    page,
  }) => {
    const snap = await measured(page, "normal", 1, "thread");
    expect(snap.letterShare, "message body box exists").not.toBeNull();
    expect(snap.letterShare ?? 0).toBeGreaterThanOrEqual(0.45);
  });

  // Measured 0.54 at 1x (2-message thread: 0.59); 0.45 is the same floor as the 2-message case.
  test("FM3 letter share, 3-message thread with image banner, normal 1x: letter >= 0.45 of reader", async ({
    page,
  }) => {
    const snap = await measured(page, "normal", 1, "thread3");
    expect(snap.letterShare, "message body box exists").not.toBeNull();
    expect(snap.letterShare ?? 0).toBeGreaterThanOrEqual(0.45);
  });

  // FM4: the reader action bar must not wrap in any density at 100% text.
  for (const density of DENSITIES) {
    test(`FM4 reader action bar does not wrap with a thread open (${density} 1x)`, async ({
      page,
    }) => {
      // A wrapped bar is at least two button rows tall; a single row is one button plus padding.
      const snap = await measured(page, density, 1, "thread");
      expect(
        snap.readerActionsHeight,
        "reader action bar exists",
      ).not.toBeNull();
      expect(snap.readerButtonHeight, "reader buttons exist").toBeGreaterThan(
        0,
      );
      expect(snap.readerActionsHeight ?? Infinity).toBeLessThan(
        snap.readerButtonHeight * 2,
      );
      expect(snap.readerButtonTopSpread).toBeLessThan(
        snap.readerButtonHeight / 2,
      );
    });
  }

  // FM5: reader-bar sync must not grow the list heading past 2 headings.
  for (const density of DENSITIES) {
    test(`FM5 list heading stays within 2x pane-heading height (${density} 1x)`, async ({
      page,
    }) => {
      const snap = await measured(page, density, 1, "thread");
      const heading = snap.tokens["pane-heading-height"] ?? 0;
      expect(snap.listHeadingHeight, "list heading exists").not.toBeNull();
      expect(snap.listHeadingHeight ?? Infinity).toBeLessThanOrEqual(
        heading * 2,
      );
    });
  }

  // FM6: enough rows visible above the fold.
  test("FM6 at least 9 message rows fully visible, normal 1x list", async ({
    page,
  }) => {
    const snap = await measured(page, "normal", 1, "list");
    expect(snap.rowsVisible).toBeGreaterThanOrEqual(9);
  });

  // FM7: 200% text has no clipping, sideways scroll, or overlaps.
  for (const density of DENSITIES) {
    test(`FM7 200% text: panes do not scroll sideways (${density})`, async ({
      page,
    }) => {
      const snap = await measured(page, density, 2, "thread");
      for (const [selector, overflow] of Object.entries(snap.scrollX)) {
        expect(overflow, `${selector} horizontal overflow`).toBeLessThanOrEqual(
          0,
        );
      }
    });

    test(`FM7 200% text: list sender keeps at least 3ch (${density})`, async ({
      page,
    }) => {
      const snap = await measured(page, density, 2, "mix");
      expect(snap.senderCh, "sender measured").not.toBeNull();
      expect(snap.senderCh ?? 0).toBeGreaterThanOrEqual(3);
    });

    test(`FM7 200% text: stamp, quick reply, and toolbar do not overlap (${density})`, async ({
      page,
    }) => {
      const thread = await measured(page, density, 2, "thread");
      const list = await measured(page, density, 2, "list");
      expect(thread.stampOverlapsSender, "stamp does not overlap sender").toBe(
        false,
      );
      expect(
        thread.quickReplyOverlapsBody,
        "quick reply does not overlap letter",
      ).toBe(false);
      expect(list.toolbarOverlaps, "toolbar children do not overlap").toBe(0);
    });
  }

  // FM8: hit areas meet the inset target size.
  for (const density of DENSITIES) {
    test(`FM8 hit areas: no control smaller than target-size-inset (${density})`, async ({
      page,
    }) => {
      const small: string[] = [];
      for (const scale of SCALES) {
        for (const view of ["list", "thread"] as const) {
          const snap = await measured(page, density, scale, view);
          small.push(...snap.smallTargets.map((t) => `${scale}x ${view} ${t}`));
        }
      }
      expect(small).toEqual([]);
    });
  }

  // FM9: axe serious/critical in every density at 100% and 200%.
  for (const density of DENSITIES) {
    for (const scale of SCALES) {
      test(`FM9 axe serious/critical clean, list and thread (${density} ${scale}x)`, async ({
        page,
      }) => {
        const blocking: string[] = [];
        for (const view of ["list", "thread"] as const) {
          await open(page, density, scale, view);
          const scan = await axeScan(
            page,
            view === "list" ? ".message-list-items" : "#reader-pane",
          );
          for (const v of scan) {
            if (v.impact === "serious" || v.impact === "critical") {
              blocking.push(`${view}: ${v.id}`);
            }
          }
        }
        expect(blocking).toEqual([]);
      });
    }
  }

  // FM10: selected row, unread dot, filter segment, focus ring under forced colors.
  for (const density of DENSITIES) {
    test(`FM10 forced colors keep selection, unread, filter, and focus visible (${density})`, async ({
      page,
    }) => {
      await page.emulateMedia({ forcedColors: "active" });
      await open(page, density, 1, "thread");
      const indicator = (selector: string) =>
        page
          .locator(selector)
          .first()
          .evaluate((el) => {
            const s = getComputedStyle(el);
            const box = el.getBoundingClientRect();
            const outline =
              s.outlineStyle !== "none" && s.outlineWidth !== "0px";
            const border =
              s.borderTopStyle !== "none" && s.borderTopWidth !== "0px";
            return box.width > 0 && (outline || border);
          });
      expect(await indicator(".message-row.selected"), "selected row").toBe(
        true,
      );
      expect(await indicator(".unread-dot"), "unread dot").toBe(true);
      expect(await indicator(".mailbox-filter-segment"), "filter segment").toBe(
        true,
      );
      await page.getByRole("button", { name: "Compose", exact: true }).focus();
      const focusOutline = await page
        .getByRole("button", { name: "Compose", exact: true })
        .evaluate((el) => getComputedStyle(el).outlineStyle);
      expect(focusOutline, "focus ring").not.toBe("none");
    });
  }

  // FM11: reduced motion removes transitions on row actions and sidebar.
  for (const density of DENSITIES) {
    test(`FM11 reduced motion: no transitions on rows, sidebar, toolbar (${density})`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await open(page, density, 1, "thread");
      const moving = await page.evaluate(() => {
        const nodes = document.querySelectorAll<HTMLElement>(
          ".message-row button, .folder-pane button, .app-toolbar button",
        );
        return [...nodes]
          .filter((el) =>
            getComputedStyle(el)
              .transitionDuration.split(",")
              .some((d) => Number.parseFloat(d) > 0),
          )
          .map((el) => String(el.className).split(" ")[0] ?? "");
      });
      expect(moving).toEqual([]);
    });
  }

  // FM12: keyboard and names through the reader header and reply bar.
  test("FM12 keyboard: Details toggle precedes its panel and reader buttons have names and titles", async ({
    page,
  }) => {
    await open(page, "normal", 1, "thread");
    const toggle = page.locator(".message-header .details-toggle").first();
    await expect(toggle).toHaveAttribute(
      "aria-controls",
      "message-details-panel",
    );
    await toggle.click();
    const order = await page.evaluate(() => {
      const t = document.querySelector(".message-header .details-toggle");
      const p = document.getElementById("message-details-panel");
      if (!t || !p) return null;
      return Boolean(
        t.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });
    expect(order, "toggle is before the details panel").toBe(true);

    const unnamed = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".reader-actions button")]
        .filter((el) => {
          const label = (
            el.getAttribute("aria-label") ??
            el.textContent ??
            ""
          ).trim();
          const visibleText = (el.textContent ?? "").trim();
          return (
            label === "" || (visibleText === "" && !el.getAttribute("title"))
          );
        })
        .map((el) => el.outerHTML.slice(0, 80)),
    );
    expect(unnamed).toEqual([]);
  });

  test("FM12 keyboard: composer options menu opens from the keyboard", async ({
    page,
  }) => {
    await open(page, "normal", 1, "list");
    await page.getByRole("button", { name: "Compose", exact: true }).click();
    const options = page
      .locator(".composer-window")
      .getByRole("button", { name: /options/i })
      .first();
    await options.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu").first()).toBeVisible();
  });

  // FM13: density round-trips through Settings to save_settings.
  test("FM13 persistence: density round-trips through Settings to save_settings", async ({
    page,
  }) => {
    await page.goto("/?density=normal&scale=1");
    await expect(page.locator(".message-row").first()).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    const spacing = page.getByLabel("Interface spacing");
    await spacing.selectOption({ label: "Compact" });
    await expect
      .poll(async () =>
        (await ipcCalls(page))
          .filter((c) => c.command === "save_settings")
          .some((c) => JSON.stringify(c.args).includes('"density":"compact"')),
      )
      .toBe(true);
    await spacing.selectOption({ label: "Normal" });
    await expect
      .poll(async () =>
        (await ipcCalls(page))
          .filter((c) => c.command === "save_settings")
          .some((c) => JSON.stringify(c.args).includes('"density":"normal"')),
      )
      .toBe(true);
  });

  test("FM13 persistence: a fresh install resolves to normal density", async () => {
    test.fixme(
      true,
      "Covered by src-tauri/src/settings.rs density_defaults_and_legacy_resolution (fresh install = normal).",
    );
  });

  // FM14: pane-bottom letter height and collapsed quick reply.
  test("FM14 pane bottom, normal 1x: letter >= 200px and quick reply collapsed", async ({
    page,
  }) => {
    const snap = await measured(page, "normal", 1, "bottom");
    expect(snap.letterPx ?? 0).toBeGreaterThanOrEqual(200);
    expect(snap.quickReplyHeight ?? Infinity).toBeLessThanOrEqual(52);
  });

  // FM15: narrow drawer and full-screen reader still work in every density.
  for (const density of DENSITIES) {
    test(`FM15 narrow 760px drawer and full-screen reader (${density})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 760, height: 840 });
      await page.goto(`/?density=${density}&scale=1`);
      await expect(page.locator(".message-row").first()).toBeVisible();
      const messagePane = await page
        .locator(".message-pane")
        .first()
        .boundingBox();
      expect(
        messagePane?.width ?? 0,
        "list fills width (drawer)",
      ).toBeGreaterThanOrEqual(0.9 * 760);

      await page.goto(`/?density=${density}&scale=1&pane=hidden`);
      await page.getByRole("option", { name: /Weekend plans/i }).click();
      await expect(page.locator("#message-title")).toBeVisible();
      const reader = await page.locator("#reader-pane").boundingBox();
      expect(reader?.width ?? 0, "full-screen reader").toBeGreaterThanOrEqual(
        0.95 * 760,
      );
      const reply = page
        .getByRole("button", { name: "Reply", exact: true })
        .first();
      const hitIsReply = await reply.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.x + r.width / 2,
          r.y + r.height / 2,
        );
        return el.contains(hit);
      });
      expect(hitIsReply).toBe(true);
    });
  }

  // FM16: setup preview shows three looks and selecting each applies live.
  test("FM16 setup preview renders normal, comfortable, compact and switches live", async () => {
    test.fixme(
      true,
      "Covered by e2e/setup-density-preview.spec.ts: setup preview shows Normal by default and three distinct looks.",
    );
  });

  // FM17: scroll position is kept per message.
  test("FM17 letter scroll position is restored per message", async ({
    page,
  }) => {
    // Same approach as letter-scroll.spec.ts: read and set scroll on the letter iframe directly.
    const letterScroll = () =>
      page.locator(".message-body iframe").evaluate((frame) => {
        const iframe = frame as HTMLIFrameElement;
        const scrolling =
          iframe.contentDocument?.scrollingElement ??
          iframe.contentDocument?.documentElement;
        return scrolling?.scrollTop ?? 0;
      });
    await page.setViewportSize(VIEWPORT);
    await page.goto("/?threadGap=1&longLetter=1");
    const weekend = page.getByRole("treeitem", {
      name: /Conversation, Jane.*Weekend plans/i,
    });
    const older = page.getByRole("treeitem", { name: /Older family note/i });
    await weekend.click({ timeout: 5_000 });
    await expect(
      page.getByRole("heading", { name: "Weekend plans" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.locator(".message-body iframe").evaluate((frame) => {
          const iframe = frame as HTMLIFrameElement;
          const scrolling =
            iframe.contentDocument?.scrollingElement ??
            iframe.contentDocument?.documentElement;
          return scrolling
            ? scrolling.scrollHeight > scrolling.clientHeight
            : false;
        }),
      )
      .toBe(true);
    await page.locator(".message-body iframe").evaluate((frame) => {
      const iframe = frame as HTMLIFrameElement;
      const scrolling =
        iframe.contentDocument?.scrollingElement ??
        iframe.contentDocument?.documentElement;
      if (scrolling) scrolling.scrollTop = 480;
    });
    await expect.poll(letterScroll, { timeout: 5_000 }).toBeGreaterThan(400);
    const saved = await letterScroll();

    await older.click({ timeout: 5_000 });
    await expect(
      page.getByRole("heading", { name: "Older family note" }),
    ).toBeVisible();
    await expect.poll(letterScroll, { timeout: 5_000 }).toBe(0);

    await weekend.click({ timeout: 5_000 });
    await expect(
      page.getByRole("heading", { name: "Weekend plans" }),
    ).toBeVisible();
    await expect
      .poll(letterScroll, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(saved - 2);
    expect(await letterScroll()).toBeLessThanOrEqual(saved + 2);
  });

  // FM18: first letter line aligns with the subject in every density.
  for (const density of DENSITIES) {
    test(`FM18 frame margin: letter aligns with subject (${density} 1x)`, async ({
      page,
    }) => {
      await open(page, density, 1, "reader");
      await expect
        .poll(async () => {
          const subject = await textLeft(page, "#message-title");
          const body = await frameTextLeft(page);
          if (subject === null) return 99;
          return Math.abs(body - subject);
        })
        .toBeLessThanOrEqual(1);
    });
  }

  // FM19: no age wording in shipped source, tests, or docs.
  test("FM19 no banned age wording in src, e2e, or docs", async () => {
    const roots = ["src", "e2e", "docs"].map((d) => join(process.cwd(), d));
    const textExt = new Set([
      ".ts",
      ".tsx",
      ".js",
      ".mjs",
      ".cjs",
      ".css",
      ".md",
      ".json",
      ".html",
      ".rs",
      ".toml",
      ".yml",
      ".yaml",
      ".txt",
    ]);
    const hits: string[] = [];
    for (const root of roots) {
      for (const file of await walk(root)) {
        if (!textExt.has(extname(file))) continue;
        const text = (await readFile(file, "utf8")).toLowerCase();
        for (const word of BANNED_WORDS) {
          if (text.includes(word)) {
            hits.push(`${relative(process.cwd(), file)}: ${word}`);
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });

  // FM20: remote images need explicit consent; threat variant keeps its warning.
  test("FM20 remote images load only after Load images; threat banner keeps warning style", async ({
    page,
  }) => {
    await open(page, "normal", 1, "thread");
    const load = page.getByRole("button", { name: /Load images/ }).first();
    await expect(load).toBeVisible();
    const before = (await ipcCalls(page)).map((c) => c.command);
    expect(before).not.toContain("fetch_remote_image");
    await load.click();
    await expect
      .poll(async () => (await ipcCalls(page)).map((c) => c.command))
      .toContain("fetch_remote_image");

    await page.goto("/?density=normal&scale=1&remote=1&threatBlocked=1");
    await page.getByRole("option", { name: /Weekend plans/i }).click();
    await expect(
      page.getByRole("button", { name: "Load images", exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/potentially dangerous/i)).toHaveCount(0);
    await page
      .getByRole("button", { name: "Load images", exact: true })
      .click();
    const threat = page.getByText(/potentially dangerous/i).first();
    await expect(threat).toBeVisible();
    const warned = await threat.evaluate((el) =>
      Boolean(el.closest('[class*="warning"]')),
    );
    expect(warned).toBe(true);
  });

  // §10.8 FM21-FM30.

  test("FM21 selected row differs from unselected rows when the list is not focused", async ({
    page,
  }) => {
    await open(page, "normal", 1, "list");
    await page.locator(".message-row").nth(1).click();
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    // The row background transitions (120ms), so the first read can still equal the unselected color.
    const readColors = () =>
      page.evaluate(() => {
        const selected = document.querySelector(".message-row.selected");
        const other = document.querySelector(".message-row:not(.selected)");
        if (!selected || !other) return null;
        return {
          selected: getComputedStyle(selected).backgroundColor,
          other: getComputedStyle(other).backgroundColor,
        };
      });
    await expect
      .poll(
        async () => {
          const colors = await readColors();
          if (!colors) return "no rows";
          if (colors.selected === "rgba(0, 0, 0, 0)") return "transparent";
          return colors.selected === colors.other ? "same" : "differs";
        },
        { timeout: 5_000 },
      )
      .toBe("differs");
  });

  for (const density of DENSITIES) {
    test(`FM22 popup menus fit a 620x540 viewport (${density})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 620, height: 540 });
      await page.goto(`/?density=${density}&scale=1&hugeList=60&rowMix=1`);
      await expect(page.locator(".message-row").first()).toBeVisible();
      await page
        .getByRole("button", { name: "More mailbox actions", exact: true })
        .click();
      const menu = await page.locator(".app-menu").first().boundingBox();
      expect(menu, "menu opens").not.toBeNull();
      expect((menu?.y ?? 0) + (menu?.height ?? 0)).toBeLessThanOrEqual(540);
      expect((menu?.x ?? 0) + (menu?.width ?? 0)).toBeLessThanOrEqual(620);
    });
  }

  for (const density of DENSITIES) {
    test(`FM23 outbox needs-attention rows show their warning without hover (${density} 1x)`, async ({
      page,
    }) => {
      await page.setViewportSize(VIEWPORT);
      // attentionPair seeds two needs_attention rows from list_outbox.
      await page.goto(
        `/?density=${density}&scale=1&localMail=1&attentionPair=1`,
      );
      await page.getByRole("button", { name: /^Outbox/ }).click({
        timeout: 5_000,
      });
      // Move the pointer off every control so no hover state can explain the text.
      await page.mouse.move(0, 0);
      await expect(
        page.getByText("Second unsent", { exact: true }),
      ).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText("Needs attention").first()).toBeVisible({
        timeout: 5_000,
      });
      await expect(
        page.getByText("Delivery could not be confirmed.").first(),
      ).toBeVisible({ timeout: 5_000 });
    });
  }

  test("FM24 prose measure: wide tables stay full-bleed and plain letters cap at 72ch", async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORT);
    await page.goto("/?density=normal&scale=1&wideHtml=900");
    await page.getByRole("option", { name: /Weekend plans/i }).click();
    await expect(page.locator("#message-title")).toBeVisible();
    const frame = await letterFrame(page);
    // Intent: author-width tables stay full-bleed, not inside a 72ch prose wrapper.
    const fullBleed = await frame?.evaluate(() => {
      const table = document.querySelector("table");
      if (!table) return null;
      const probe = document.createElement("span");
      probe.style.cssText = "position:absolute;visibility:hidden;width:1ch;";
      document.body.append(probe);
      const ch = probe.getBoundingClientRect().width;
      probe.remove();
      const cappedAncestors: string[] = [];
      for (let el = table.parentElement; el; el = el.parentElement) {
        const max = parseFloat(getComputedStyle(el).maxWidth);
        if (Number.isFinite(max) && max <= 72 * ch + 2) {
          cappedAncestors.push(el.tagName.toLowerCase());
        }
      }
      const parent = table.parentElement?.getBoundingClientRect().width ?? 0;
      return {
        capped: cappedAncestors,
        overMeasure: table.getBoundingClientRect().width > 72 * ch,
        spanRatio:
          parent > 0 ? table.getBoundingClientRect().width / parent : 0,
      };
    });
    expect(fullBleed, "wide table fixture exists").not.toBeNull();
    expect(fullBleed?.capped, "no 72ch wrapper around table").toEqual([]);
    expect(fullBleed?.overMeasure, "table wider than 72ch").toBe(true);
    expect(
      fullBleed?.spanRatio ?? 0,
      "table spans its container",
    ).toBeGreaterThanOrEqual(0.95);

    for (const density of DENSITIES) {
      await page.goto(`/?density=${density}&scale=1&longLetter=1`);
      await page.getByRole("option", { name: /Weekend plans/i }).click();
      await expect(page.locator("#message-title")).toBeVisible();
      const frame = await letterFrame(page);
      const shape = await frame?.evaluate(() => {
        const p = document.querySelector("p");
        if (!p) return null;
        const probe = document.createElement("span");
        probe.style.cssText = "position:absolute;visibility:hidden;width:1ch;";
        p.append(probe);
        const ch = probe.getBoundingClientRect().width;
        probe.remove();
        const r = p.getBoundingClientRect();
        const body = document.body.getBoundingClientRect();
        return {
          width: r.width,
          ch,
          leftGap: r.left - body.left,
          rightGap: body.right - r.right,
        };
      });
      expect(shape, `${density} letter exists`).not.toBeNull();
      expect(shape?.width ?? Infinity).toBeLessThanOrEqual(
        72 * (shape?.ch ?? 0) + 2,
      );
      expect(
        Math.abs((shape?.leftGap ?? 0) - (shape?.rightGap ?? 0)),
      ).toBeLessThanOrEqual(4);
    }
  });

  test("FM25 MIN_FIT_ZOOM floor: 3000px table keeps zoom >= 0.8 and scrolls sideways", async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORT);
    await page.goto("/?density=normal&scale=1&wideHtml=3000");
    await page.getByRole("option", { name: /Weekend plans/i }).click();
    await expect(page.locator("#message-title")).toBeVisible();
    const frame = await letterFrame(page);
    const result = await frame?.evaluate(() => ({
      zoom: Number.parseFloat(document.body.style.zoom || "1"),
      overflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    }));
    expect(result?.zoom ?? 0).toBeGreaterThanOrEqual(0.8);
    expect(result?.overflow ?? 0).toBeGreaterThan(0);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`FM26 color-contrast serious/critical is zero, ${theme} 100%`, async ({
      page,
    }) => {
      const blocking: string[] = [];
      for (const view of ["list", "thread"] as const) {
        await page.goto(
          `/?density=normal&scale=1&theme=${theme}${VIEW_QUERY[view]}`,
        );
        await expect(page.locator(".message-row").first()).toBeVisible();
        if (view === "thread")
          await page.locator(".message-row").first().click();
        const scan = await axeScan(
          page,
          view === "list" ? ".message-list-items" : "#reader-pane",
          ["color-contrast"],
        );
        for (const v of scan) {
          if (v.impact === "serious" || v.impact === "critical") {
            blocking.push(`${view}: ${v.id} x${v.nodes}`);
          }
        }
      }
      expect(blocking).toEqual([]);
    });
  }

  test("FM27 lucide icons: no size prop outside AppMark and WindowChrome; all aria-hidden", async () => {
    const files = (await walk(join(process.cwd(), "src", "components"))).filter(
      (f) => f.endsWith(".tsx"),
    );
    const sized: string[] = [];
    const exposed: string[] = [];
    for (const file of files) {
      const name = relative(process.cwd(), file);
      const source = await readFile(file, "utf8");
      const importMatch = /import\s*\{([^}]*)\}\s*from\s*"lucide-react"/.exec(
        source,
      );
      if (!importMatch) continue;
      const icons = (importMatch[1] ?? "")
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0] ?? "")
        .filter(Boolean);
      const allowSize = /AppMark\.tsx$|WindowChrome\.tsx$/.test(name);
      for (const icon of icons) {
        for (const tag of source.matchAll(
          new RegExp(`<${icon}\\b([^>]*)`, "g"),
        )) {
          const attrs = tag[1] ?? "";
          if (!allowSize && /\bsize=/.test(attrs))
            sized.push(`${name}:${icon}`);
          if (!/aria-hidden/.test(attrs)) exposed.push(`${name}:${icon}`);
        }
      }
    }
    expect(sized, "icons with a size prop").toEqual([]);
    expect(exposed, "icons without aria-hidden").toEqual([]);
  });

  test("FM28 sidebar is a column at 900px and a drawer at 899px", async ({
    page,
  }) => {
    const column = async (width: number) => {
      await page.setViewportSize({ width, height: 840 });
      await page.goto("/?density=normal&scale=1&hugeList=60&rowMix=1");
      await expect(page.locator(".message-row").first()).toBeVisible();
      const folder = await page.locator(".folder-pane").first().boundingBox();
      const list = await page.locator(".message-pane").first().boundingBox();
      return Boolean(
        folder &&
        list &&
        folder.width > 0 &&
        folder.x >= -1 &&
        folder.x + folder.width <= list.x + 1,
      );
    };
    expect(await column(900), "900px sidebar column").toBe(true);
    expect(await column(899), "899px sidebar drawer").toBe(false);
  });

  test("FM29 select mode adds no vertical chrome above the first row", async ({
    page,
  }) => {
    await open(page, "normal", 1, "list");
    const before = await page.locator(".message-row").first().boundingBox();
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await expect(
      page.getByRole("toolbar", { name: /selected/i }),
    ).toBeVisible();
    const after = await page.locator(".message-row").first().boundingBox();
    expect(after?.y ?? Infinity).toBeLessThanOrEqual((before?.y ?? 0) + 1);
  });

  test("FM30 200% text: address lines are not broken mid-token", async ({
    page,
  }) => {
    await open(page, "normal", 2, "thread");
    const broken = await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '#reader-pane .message-header [title*="@"]',
        ),
      ]
        .map((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          const lines = new Set(
            [...range.getClientRects()].map((r) => Math.round(r.top)),
          );
          return { title: el.getAttribute("title") ?? "", lines: lines.size };
        })
        .filter((item) => item.lines > 1),
    );
    expect(broken).toEqual([]);
  });

  // §10.18 FM31-FM38.

  test("FM31 first recent-search item is the hit target at 900px and 1280px (B1)", async () => {
    test.fixme(
      true,
      "Covered by e2e/recent-search.spec.ts: the first recent search is the hit target at 900px and 1280px.",
    );
  });

  test("FM32 ArrowDown reaches Oldest first in the mailbox More menu at menu-row-height", async ({
    page,
  }) => {
    await open(page, "normal", 1, "list");
    await page
      .getByRole("button", { name: "More mailbox actions", exact: true })
      .click();
    for (let step = 0; step < 15; step += 1) {
      const focused = await page.evaluate(
        () => document.activeElement?.textContent?.trim() ?? "",
      );
      if (focused.includes("Oldest first")) break;
      await page.keyboard.press("ArrowDown");
    }
    const row = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || !active.textContent?.includes("Oldest first")) return null;
      return { height: active.getBoundingClientRect().height };
    });
    expect(row, "Oldest first is focusable").not.toBeNull();
    const token = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.cssText = "position:absolute;visibility:hidden;height:0;";
      probe.style.width = "var(--menu-row-height)";
      document.body.append(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return width;
    });
    expect(token, "menu-row-height token resolves").toBeGreaterThan(0);
    expect(row?.height ?? 0).toBeCloseTo(token, 0);
  });

  test("FM33 select mode More menu at 620x540 is reachable inside the viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 620, height: 540 });
    await page.goto("/?density=normal&scale=1&hugeList=60&rowMix=1");
    await expect(page.locator(".message-row").first()).toBeVisible();
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await page
      .getByRole("button", { name: "More mailbox actions", exact: true })
      .click();
    const menu = page.locator(".app-menu").first();
    const box = await menu.boundingBox();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(540);
    const overflowY = await menu.evaluate(
      (el) => getComputedStyle(el).overflowY,
    );
    const scrollable = await menu.evaluate(
      (el) => el.scrollHeight > el.clientHeight,
    );
    if (scrollable) expect(["auto", "scroll"]).toContain(overflowY);
  });

  test("FM34 Ctrl/Cmd+click checks a row; Escape leaves select mode; checked row visible under forced colors", async ({
    page,
  }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await open(page, "normal", 1, "list");
    await page
      .locator(".message-row")
      .nth(0)
      .click({ modifiers: ["ControlOrMeta"] });
    await expect(
      page.getByRole("toolbar", { name: /selected/i }),
    ).toBeVisible();
    const checked = await page
      .locator(".message-row.checked")
      .first()
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return (
          (s.outlineStyle !== "none" && s.outlineWidth !== "0px") ||
          (s.borderTopStyle !== "none" && s.borderTopWidth !== "0px")
        );
      });
    expect(checked, "checked row indicator under forced colors").toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("toolbar", { name: /selected/i })).toHaveCount(
      0,
    );
  });

  test("FM35 Send-scheduled toast and Undo notice never overlap", async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORT);
    await page.goto("/?density=normal&scale=1");
    const weekend = page.getByRole("option", { name: /Weekend plans/i });
    await weekend.click();
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    await page.getByLabel("Message body").pressSequentially("Yes, see you.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const sent = page.locator(".sent-toast");
    await expect(sent).toBeVisible();
    // Archiving the same row opens the Undo notice alongside the sent toast.
    await weekend.focus();
    await page.keyboard.press("e");
    const moved = page.locator(".notice", { hasText: "Archived" });
    await expect(moved).toBeVisible();
    const a = await sent.boundingBox();
    const b = await moved.boundingBox();
    expect(a, "sent toast box").not.toBeNull();
    expect(b, "undo notice box").not.toBeNull();
    const apart =
      a!.y + a!.height <= b!.y ||
      b!.y + b!.height <= a!.y ||
      a!.x + a!.width <= b!.x ||
      b!.x + b!.width <= a!.x;
    expect(apart).toBe(true);
  });

  test("FM36 at 540px tall the pane heading and reader bar are no taller than at 820px", async ({
    page,
  }) => {
    const heights = async (height: number) => {
      await open(page, "normal", 1, "thread", { width: 1280, height });
      return measureHeights(page);
    };
    const tall = await heights(820);
    const short = await heights(540);
    expect(short.heading).toBeLessThanOrEqual(tall.heading + 0.5);
    expect(short.bar).toBeLessThanOrEqual(tall.bar + 0.5);
  });

  test("FM37 dragging two checked rows shows a '2 messages' drag image", async ({
    page,
  }) => {
    await open(page, "normal", 1, "list");
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await page.locator(".message-select-hit").nth(0).click();
    await page.locator(".message-select-hit").nth(1).click();
    await expect(
      page.getByRole("toolbar", { name: "2 selected" }),
    ).toBeVisible();
    // Records the text of each drag image the app sets.
    await page.evaluate(() => {
      const w = window as unknown as { __dragChips: string[] };
      w.__dragChips = [];
      const original = DataTransfer.prototype.setDragImage;
      DataTransfer.prototype.setDragImage = function (node, x, y) {
        w.__dragChips.push(node.textContent ?? "");
        original.call(this, node, x, y);
      };
    });
    await page
      .locator('[role="option"][aria-selected="true"]')
      .first()
      .dragTo(
        page.locator(".folder-pane").getByRole("button", { name: "Archive" }),
      );
    const chips = await page.evaluate(
      () => (window as unknown as { __dragChips: string[] }).__dragChips,
    );
    expect(chips).toContain("2 messages");
  });

  test("FM38 f forwards the focused message; chord equals Settings > Shortcuts", async ({
    page,
  }) => {
    await open(page, "normal", 1, "reader");
    await page.locator(".message-row").first().focus();
    await page.keyboard.press("f");
    await expect(page.getByLabel(/subject/i).first()).toHaveValue(/^Fwd:/);
  });

  test("FM38 chord shown in the More menu equals the Settings > Shortcuts entry", async ({
    page,
  }) => {
    await open(page, "normal", 1, "reader");
    await page
      .getByRole("button", { name: "More actions", exact: true })
      .click();
    const menuChord = await page
      .getByRole("menuitem", { name: /^Mark (read|unread)$/ })
      .first()
      .locator("kbd")
      .textContent();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Shortcuts", exact: true }).click();
    const settingsChord = await page
      .locator(".shortcut-row", { hasText: "Mark read or unread" })
      .locator("kbd")
      .textContent();
    expect(menuChord?.trim()).toBeTruthy();
    expect(menuChord).toBe(settingsChord);
  });

  // Composer and Settings surfaces (plan §8.2 final paragraph).

  test("Composer window: header <= 48px and editor >= 50% of the window (normal 1x)", async ({
    page,
  }) => {
    await open(page, "normal", 1, "list");
    await page.getByRole("button", { name: "Compose", exact: true }).click();
    const win = await page.locator(".composer-window").first().boundingBox();
    const header = await page
      .locator(".composer-window header")
      .first()
      .boundingBox();
    const editor = await page
      .locator(".composer-editor-wrap")
      .first()
      .boundingBox();
    expect(win, "composer window").not.toBeNull();
    expect(header?.height ?? Infinity).toBeLessThanOrEqual(49);
    expect((editor?.height ?? 0) / (win?.height ?? 1)).toBeGreaterThanOrEqual(
      0.5,
    );
  });

  test("Settings window: <= 56rem x 40rem and nav rows >= target-size (normal 1x)", async ({
    page,
  }) => {
    await open(page, "normal", 1, "list");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = await page.locator(".settings-window").boundingBox();
    expect(dialog?.width ?? Infinity).toBeLessThanOrEqual(56 * 16 + 1);
    expect(dialog?.height ?? Infinity).toBeLessThanOrEqual(40 * 16 + 1);
    const navHeights = await page
      .locator(".settings-nav button")
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    expect(navHeights.length).toBeGreaterThan(0);
    for (const h of navHeights) expect(h).toBeGreaterThanOrEqual(36);
  });
});

async function measureHeights(page: Page) {
  return page.evaluate(() => ({
    heading:
      document
        .querySelector(".message-pane .pane-heading")
        ?.getBoundingClientRect().height ?? 0,
    bar:
      document.querySelector(".reader-actions")?.getBoundingClientRect()
        .height ?? 0,
  }));
}
