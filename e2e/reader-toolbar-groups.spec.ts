import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here: T1-T5, H1-H3.
// T1 more than three toolbar groups; T2 "1 of 1" / nav not last;
// T3 bar and list heading heights differ; T4 star name or title lost;
// T5 Back/Close order moves; H1 header links wrap apart;
// H2 notices off the title inset; H3 conversation index off the title.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/reader-toolbar-groups-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

async function open(page: Page, query: string, size = [1280, 800]) {
  await page.setViewportSize({ width: size[0], height: size[1] });
  await page.goto(`/?${query}`);
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
}

const names = (page: Page, group: number) =>
  page
    .locator(".reader-action-group")
    .nth(group)
    .locator("button")
    .evaluateAll((nodes) =>
      nodes.map(
        (n) => n.getAttribute("aria-label") || (n.textContent ?? "").trim(),
      ),
    );

test("one message has two groups and no navigation", async ({ page }) => {
  await open(page, "theme=light");
  await expect(page.locator(".reader-action-group")).toHaveCount(2);
  expect(await names(page, 0)).toEqual(["Reply", "Reply all", "Forward"]);
  expect(await names(page, 1)).toEqual([
    "Add star",
    "Archive",
    "Move to trash",
    "More actions",
  ]);
  await expect(page.locator(".reader-position")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Next message" })).toHaveCount(
    0,
  );
});

test("star keeps its name, pressed state and tooltip", async ({ page }) => {
  await open(page, "theme=light");
  const star = page.getByRole("button", { name: "Add star", exact: true });
  await expect(star).toHaveAttribute("aria-pressed", "false");
  await expect(star).toHaveAttribute("title", /Add star/);
  await star.click();
  const on = page.getByRole("button", { name: "Remove star", exact: true });
  await expect(on).toHaveAttribute("aria-pressed", "true");
  await expect(on).toHaveAttribute("title", /Remove star/);
});

test("a thread adds navigation last and right-aligned", async ({ page }) => {
  await open(page, "threadGap=1");
  await expect(page.locator(".reader-action-group")).toHaveCount(3);
  await expect(page.locator(".reader-position")).toHaveText("1 of 3");
  const geo = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll(".reader-action-group")];
    const groups = nodes.map((n) => n.getBoundingClientRect());
    const bar = document.querySelector(".reader-actions")!;
    const pad = Number.parseFloat(getComputedStyle(bar).paddingRight);
    return {
      navLast: nodes[2].classList.contains("reader-nav"),
      order: groups[0].left < groups[1].left && groups[1].left < groups[2].left,
      rightGap: Math.round(
        bar.getBoundingClientRect().right - pad - groups[2].right,
      ),
      oneRow: groups.every((g) => Math.abs(g.top - groups[0].top) <= 1),
    };
  });
  expect(geo.navLast).toBe(true);
  expect(geo.order).toBe(true);
  expect(geo.oneRow).toBe(true);
  expect(Math.abs(geo.rightGap)).toBeLessThanOrEqual(1);
});

const combos = [
  ...(["comfortable", "compact"] as const).flatMap((density) =>
    [1, 2].flatMap((scale) =>
      (["right", "bottom"] as const).map((pane) => ({
        name: `${density} x${scale} ${pane}`,
        query: `threadGap=1&density=${density}&scale=${scale}&pane=${pane}`,
        size: [1280, 800],
        pane,
      })),
    ),
  ),
  { name: "900px", query: "threadGap=1", size: [900, 800], pane: "right" },
  { name: "640px", query: "threadGap=1", size: [640, 800], pane: "right" },
];

for (const combo of combos) {
  test(`matrix ${combo.name} keeps three groups, unclipped, in sync`, async ({
    page,
  }) => {
    await open(page, combo.query, combo.size);
    const m = await page.evaluate(() => {
      const bar = document.querySelector(".reader-actions")!;
      const barBox = bar.getBoundingClientRect();
      const clipped = [...bar.querySelectorAll("button")]
        .filter((b) => b.getClientRects().length > 0)
        .filter(
          (b) =>
            b.scrollWidth > b.clientWidth + 1 ||
            b.scrollHeight > b.clientHeight + 1 ||
            b.getBoundingClientRect().right > barBox.right + 1 ||
            b.getBoundingClientRect().left < barBox.left - 1,
        ).length;
      const heading = document.querySelector(".message-pane .pane-heading");
      return {
        groups: bar.querySelectorAll(".reader-action-group").length,
        clipped,
        barHeight: Math.round(barBox.height),
        headingHeight: heading
          ? Math.round(heading.getBoundingClientRect().height)
          : 0,
        headingVisible: heading ? heading.getClientRects().length > 0 : false,
      };
    });
    expect(m.groups).toBeLessThanOrEqual(3);
    expect(m.clipped).toBe(0);
    if (combo.pane === "right" && m.headingVisible) {
      expect(Math.abs(m.barHeight - m.headingHeight)).toBeLessThanOrEqual(1);
    }
  });
}

test("Back stays first in the narrow view", async ({ page }) => {
  await open(page, "threadGap=1", [640, 800]);
  const order = await page.evaluate(() => {
    const bar = document.querySelector(".reader-actions")!;
    const back = document.querySelector(".mobile-reader-back")!;
    const group = document.querySelector(".reader-unified-actions")!;
    const a = back.getBoundingClientRect();
    const b = group.getBoundingClientRect();
    return {
      backFirst: bar.children[0] === back,
      backBefore: a.left < b.left || a.top < b.top,
    };
  });
  expect(order.backFirst).toBe(true);
  expect(order.backBefore).toBe(true);
});

test("Close stays first when reading is full screen", async ({ page }) => {
  await open(page, "pane=hidden&threadGap=1");
  const first = await page.evaluate(
    () =>
      [...document.querySelector(".reader-actions")!.children].find(
        (n) => n.getClientRects().length > 0,
      )?.className,
  );
  expect(first).toContain("desktop-reader-close");
});

async function textLeft(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) return null;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text && !(text.textContent ?? "").trim()) text = walker.nextNode();
    if (!text) return node.getBoundingClientRect().left;
    const range = document.createRange();
    range.selectNodeContents(text);
    return range.getClientRects()[0].left;
  }, selector);
}

test("header links share one line and start at the sender name", async ({
  page,
}) => {
  await open(page, "fileCount=2&earlier=1&inTrash=1");
  const links = page.locator(".message-header-links > *");
  expect(await links.count()).toBeGreaterThanOrEqual(3);
  const tops = await links.evaluateAll((nodes) =>
    nodes.map((n) => Math.round(n.getBoundingClientRect().top)),
  );
  expect(new Set(tops).size).toBe(1);
  const link = await textLeft(page, ".message-header-links > *");
  const name = await textLeft(page, ".sender-name");
  expect(Math.abs((link ?? 0) - (name ?? 99))).toBeLessThanOrEqual(1);
});

test("notices and the conversation index line up with the title", async ({
  page,
}) => {
  await open(page, "threadGap=1&localMail=1&replyDraft=reply&inTrash=1");
  const title = await textLeft(page, "#message-title");
  const lefts = [
    await textLeft(page, ".continue-draft p"),
    await textLeft(page, ".conversation-index button span"),
    await textLeft(page, ".remote-content-banner.warning span"),
  ];
  for (const left of lefts) {
    expect(left).not.toBeNull();
    expect(Math.abs((left ?? 0) - (title ?? 99))).toBeLessThanOrEqual(1);
  }
});
