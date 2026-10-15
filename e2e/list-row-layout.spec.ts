import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here (docs/0.4.2-UI-FAILURE-INVENTORY.md):
// R1  Star and read hit columns push rows off the 5-7px list gutter.
// R2  A selected row paints accent blocks outside the row.
// R13 Select mode: title, filter, day and sender drift apart.
// R18 The sender collapses below 3em at 200% text.
// R19 The star is not an inline .star-mark; hit columns remain.
// L1  Title, filter, day heading and sender share no left edge.
// L2  The day count does not line up with the date column.
// L3  Load-more keeps a bordered style.
// S1  The Unread folders toggle is a bordered box.
// Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/list-row-layout-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

const MIX = "?rowMix=1&theme=light";

async function lefts(page: Page) {
  return page.evaluate(() => {
    const left = (selector: string): number | null => {
      const node = document.querySelector(selector);
      return node ? node.getBoundingClientRect().left : null;
    };
    return {
      title: left(".pane-heading h1"),
      filter: left(".mailbox-filter-control"),
      day: left(".list-day > span"),
      sender: left(".message-sender"),
    };
  });
}

async function expectOneEdge(page: Page) {
  const edges = await lefts(page);
  for (const [name, value] of Object.entries(edges)) {
    expect(value, name).not.toBeNull();
  }
  const base = edges.sender!;
  for (const [name, value] of Object.entries(edges)) {
    expect(Math.abs(value! - base), `${name} vs sender`).toBeLessThanOrEqual(1);
  }
}

test("rows sit 5-7px from the list edge with no hit columns", async ({
  page,
}) => {
  await page.goto(`/${MIX}`);
  await expect(page.locator(".message-row").first()).toBeVisible();
  const facts = await page.evaluate(() => {
    const list = document.querySelector(".message-list")!;
    const wrap = document.querySelector(".message-row-wrap")!;
    const row = wrap.querySelector(".message-row")!;
    return {
      inset:
        row.getBoundingClientRect().left - list.getBoundingClientRect().left,
      firstIsRow: wrap.firstElementChild === row,
      starHits: document.querySelectorAll(".message-star-hit").length,
      readHits: document.querySelectorAll(".message-read-hit").length,
      dotVisible: getComputedStyle(row.querySelector(".unread-dot")!)
        .visibility,
    };
  });
  expect(facts.inset).toBeGreaterThanOrEqual(5);
  expect(facts.inset).toBeLessThanOrEqual(7);
  expect(facts.firstIsRow).toBe(true);
  expect(facts.starHits).toBe(0);
  expect(facts.readHits).toBe(0);
  expect(facts.dotVisible).toBe("visible");
});

test("a starred row shows an inline star mark in the subject", async ({
  page,
}) => {
  await page.goto(`/${MIX}`);
  await expect(page.locator(".message-row").first()).toBeVisible();
  const mark = page.locator(".message-subject .star-mark");
  await expect(mark.first()).toBeVisible();
  const inside = await mark.first().evaluate((node) => {
    const row = node.closest(".message-row")!.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    return box.left >= row.left && box.right <= row.right;
  });
  expect(inside).toBe(true);
});

test("the select checkbox leads the wrap in select mode", async ({ page }) => {
  await page.goto(`/${MIX}`);
  await page.locator("button.list-day").first().click();
  await expect(page.locator(".message-select-hit").first()).toBeVisible();
  const first = await page
    .locator(".message-row-wrap")
    .first()
    .evaluate((wrap) => wrap.firstElementChild?.className ?? "");
  expect(first).toContain("message-select-hit");
});

test("a selected row paints no accent outside the row", async ({ page }) => {
  await page.goto(`/${MIX}`);
  await page.locator(".message-row", { hasText: /Pinned reminder/i }).click();
  await expect(
    page.locator(".message-row", { hasText: /Pinned reminder/i }),
  ).toHaveAttribute("aria-selected", "true");
  await page.mouse.move(2, 2);
  const stray = await page.evaluate(() => {
    const accent = getComputedStyle(document.documentElement)
      .getPropertyValue("--accent")
      .trim();
    const probe = document.createElement("i");
    probe.style.color = accent;
    document.body.append(probe);
    const accentRgb = getComputedStyle(probe).color;
    probe.remove();
    const wrap = document.querySelector(
      ".message-row.selected",
    )!.parentElement!;
    const row = wrap.querySelector(".message-row")!.getBoundingClientRect();
    let outside = 0;
    for (const node of wrap.querySelectorAll("*")) {
      if (node.closest(".message-row")) continue;
      const style = getComputedStyle(node);
      if (style.backgroundColor !== accentRgb) continue;
      if (Number(style.opacity) === 0) continue;
      const box = node.getBoundingClientRect();
      if (
        box.left < row.left - 0.5 ||
        box.right > row.right + 0.5 ||
        box.top < row.top - 0.5 ||
        box.bottom > row.bottom + 0.5
      )
        outside += 1;
    }
    return outside;
  });
  expect(stray).toBe(0);
});

const cases = [
  { name: "comfortable", query: "" },
  { name: "compact", query: "&density=compact" },
  { name: "200%", query: "&scale=2" },
  { name: "compact 200%", query: "&density=compact&scale=2" },
];

for (const { name, query } of cases) {
  test(`title, filter, day and sender share one left edge: ${name}`, async ({
    page,
  }) => {
    await page.goto(`/${MIX}${query}`);
    await expect(page.locator(".message-row").first()).toBeVisible();
    await expectOneEdge(page);
  });

  test(`title, filter, day and sender share one left edge in select mode: ${name}`, async ({
    page,
  }) => {
    await page.goto(`/${MIX}${query}`);
    await page.locator("button.list-day").first().click();
    await expect(page.locator(".message-select-hit").first()).toBeVisible();
    await expect(page.locator(".message-pane")).toHaveClass(/selecting/);
    await expectOneEdge(page);
  });
}

test("the day count lines up with the date column", async ({ page }) => {
  await page.goto(`/${MIX}`);
  await expect(page.locator(".message-row").first()).toBeVisible();
  const gap = await page.evaluate(() => {
    const count = document.querySelector(".list-day-count")!;
    const when = document.querySelector(".message-when")!;
    return Math.abs(
      count.getBoundingClientRect().right - when.getBoundingClientRect().right,
    );
  });
  expect(gap).toBeLessThanOrEqual(1);
});

test("the sender keeps three characters of room at 200%", async ({ page }) => {
  await page.goto(`/${MIX}&scale=2`);
  await expect(page.locator(".message-row").first()).toBeVisible();
  const ratio = await page.evaluate(() => {
    const senders = [...document.querySelectorAll(".message-sender")];
    return Math.min(
      ...senders.map(
        (node) =>
          node.getBoundingClientRect().width /
          parseFloat(getComputedStyle(node).fontSize),
      ),
    );
  });
  expect(ratio).toBeGreaterThanOrEqual(3);
});

test("the size hides in a narrow list", async ({ page }) => {
  await page.goto(`/${MIX}&messagePaneWidth=240`);
  await expect(page.locator(".message-row").first()).toBeVisible();
  await expect(page.locator(".message-size").first()).toBeHidden();
  await page.goto(`/${MIX}&messagePaneWidth=520`);
  await expect(page.locator(".message-size").first()).toBeVisible();
});

test("load more is borderless", async ({ page }) => {
  await page.goto("/?pagination=1&theme=light");
  const button = page.locator(".load-more-button");
  await expect(button).toBeVisible();
  const border = await button.evaluate(
    (node) => getComputedStyle(node).borderTopWidth,
  );
  expect(border).toBe("0px");
});

test("the Unread folders toggle is borderless, centered, and pressed-styled", async ({
  page,
}) => {
  await page.goto("/?theme=light");
  const toggle = page.getByRole("button", { name: "Unread folders" });
  await expect(toggle).toBeVisible();
  const facts = await toggle.evaluate((node) => {
    const style = getComputedStyle(node);
    const heading = node.closest(".sidebar-section-heading")!;
    const title = heading.querySelector(".sidebar-section-title")!;
    const mid = (el: Element) => {
      const r = el.getBoundingClientRect();
      return (r.top + r.bottom) / 2;
    };
    return {
      border: style.borderTopWidth,
      offset: Math.abs(mid(node) - mid(title)),
    };
  });
  expect(facts.border).toBe("0px");
  expect(facts.offset).toBeLessThanOrEqual(2);
  const idle = await toggle.evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  await toggle.click();
  await page.mouse.move(600, 600);
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const pressed = await toggle.evaluate((node) => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, border: style.borderTopWidth };
  });
  expect(pressed.background).not.toBe(idle);
  expect(pressed.border).toBe("0px");
});

test("a selected row shows every mark in a color unlike its background", async ({
  page,
}) => {
  await page.goto(`/${MIX}`);
  const row = page.locator(".message-row", { hasText: /Pinned reminder/i });
  await row.click({ position: { x: 24, y: 16 } });
  await expect(row).toHaveAttribute("aria-selected", "true");
  await page.mouse.move(2, 2);
  const clashes = await row.evaluate((node) => {
    const bg = getComputedStyle(node).backgroundColor;
    return [...node.querySelectorAll(".message-subject svg")].filter(
      (mark) => getComputedStyle(mark).color === bg,
    ).length;
  });
  expect(clashes).toBe(0);
  expect(await row.locator(".pin-mark").count()).toBeGreaterThan(0);
});

for (const density of ["comfortable", "compact"] as const) {
  for (const pane of ["right", "bottom"] as const) {
    for (const height of [800, 640]) {
      test(`large-text heading controls stay visible: ${density} ${pane} ${height}`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width: 1280, height });
        await page.goto(
          `/?rowMix=1&density=${density}&scale=2&theme=dark&pane=${pane}`,
        );
        await expect(page.locator(".message-row").first()).toBeVisible();
        await expect
          .poll(() =>
            page
              .locator("html")
              .evaluate((node) => getComputedStyle(node).fontSize),
          )
          .toBe("32px");
        const metrics = await page.evaluate(() => {
          const heading = document.querySelector(".pane-heading")!;
          const band = heading.getBoundingClientRect();
          const pane = document.querySelector(".message-pane")!;
          const paneBox = pane.getBoundingClientRect();
          const list = document.querySelector(".message-list")!;
          const listBox = list.getBoundingClientRect();
          const buttons = [
            ...heading.querySelectorAll(
              ".pane-heading-actions > button, .mailbox-more > button",
            ),
          ].map((button) => {
            const box = button.getBoundingClientRect();
            const hit = document.elementFromPoint(
              box.left + box.width / 2,
              box.top + box.height / 2,
            );
            return {
              label: button.getAttribute("aria-label") ?? button.textContent,
              insideHeading: box.top >= band.top && box.bottom <= band.bottom,
              unobscured: hit !== null && button.contains(hit),
              bottom: box.bottom,
            };
          });
          return {
            buttons,
            headingBottom: band.bottom,
            listHeight: list.clientHeight,
            listInsidePane: listBox.bottom <= paneBox.bottom + 1,
            paneOverflow: pane.scrollHeight - pane.clientHeight,
            documentOverflow:
              document.documentElement.scrollHeight - window.innerHeight,
          };
        });
        await testInfo.attach("heading-metrics", {
          body: JSON.stringify(metrics, null, 2),
          contentType: "application/json",
        });
        expect.soft(metrics.buttons).toHaveLength(2);
        for (const button of metrics.buttons) {
          expect
            .soft(button.insideHeading, `${button.label}: inside heading`)
            .toBe(true);
          expect
            .soft(button.unobscured, `${button.label}: unobscured center`)
            .toBe(true);
        }
        expect
          .soft(metrics.listHeight, "list remains usable")
          .toBeGreaterThan(32);
        expect.soft(metrics.listInsidePane).toBe(true);
        expect.soft(metrics.paneOverflow).toBeLessThanOrEqual(1);
        expect.soft(metrics.documentOverflow).toBeLessThanOrEqual(1);
      });
    }
  }
}
