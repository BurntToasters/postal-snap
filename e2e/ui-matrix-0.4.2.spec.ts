import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Repeatable UI artifact: screenshots and metrics per combination, with
// soft assertions so every run writes all files. Probes tolerate elements
// that older builds lack and record null for them.
type Box = { left: number; right: number; top: number; bottom: number };
type Combo = {
  name: string;
  width: number;
  height: number;
  density: "comfortable" | "compact";
  scale: 1 | 2;
  theme: "light" | "dark";
  pane: "right" | "bottom";
};

const combos: Combo[] = [];
for (const density of ["comfortable", "compact"] as const)
  for (const scale of [1, 2] as const)
    for (const theme of ["light", "dark"] as const)
      for (const pane of ["right", "bottom"] as const)
        combos.push({
          name: `1280-${density}-${scale}x-${theme}-${pane}`,
          width: 1280,
          height: 800,
          density,
          scale,
          theme,
          pane,
        });
for (const width of [900, 640])
  combos.push({
    name: `${width}-comfortable-1x-light-right`,
    width,
    height: 800,
    density: "comfortable",
    scale: 1,
    theme: "light",
    pane: "right",
  });

function artifactDir(testInfo: TestInfo): string {
  return join(
    process.env.UI_ARTIFACT_DIR ?? testInfo.outputPath("ui"),
    testInfo.project.name,
  );
}

// Page-side probe. Everything is null when the element is missing.
async function probeList(page: Page) {
  return page.evaluate(() => {
    const box = (node: Element | null | undefined): Box | null => {
      if (!node) return null;
      const r = node.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const q = (selector: string) => document.querySelector(selector);
    const list = q(".message-list");
    const listBox = box(list);
    const rows = [...document.querySelectorAll(".message-row")];
    const row = box(rows[0]);
    const filter = q(".mailbox-filter-control") ?? q(".mailbox-filter");
    const sender = q(".message-sender");
    return {
      rowInset:
        row && listBox
          ? { left: row.left - listBox.left, right: listBox.right - row.right }
          : null,
      leftEdges: {
        heading: box(q(".pane-heading h1"))?.left ?? null,
        filter: box(filter)?.left ?? null,
        day: box(q(".list-day > span"))?.left ?? null,
        sender: box(sender)?.left ?? null,
      },
      filterBand: filter
        ? { scrollWidth: filter.scrollWidth, clientWidth: filter.clientWidth }
        : null,
      senderWidth: box(sender) ? box(sender)!.right - box(sender)!.left : null,
      senderFontPx: sender
        ? parseFloat(getComputedStyle(sender).fontSize)
        : null,
    };
  });
}

async function probeHover(page: Page) {
  return page.evaluate(() => {
    const box = (node: Element | null | undefined): Box | null => {
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const rows = [...document.querySelectorAll(".message-row")];
    const row = rows[1] ?? null;
    // The cluster is a sibling of the row button inside the wrap.
    const wrap = row?.closest(".message-row-wrap") ?? null;
    const cluster = wrap?.querySelector(".row-actions") ?? null;
    return {
      row: box(row),
      cluster: box(cluster),
      clusterOpacity: cluster ? getComputedStyle(cluster).opacity : null,
      actionButtons: wrap
        ? wrap.querySelectorAll("button.row-action[data-action]").length
        : 0,
      starMark: row ? row.querySelectorAll(".star-mark").length : 0,
      date: box(row?.querySelector(".message-date, .message-when")),
    };
  });
}

async function probeReader(page: Page) {
  return page.evaluate(() => {
    const box = (node: Element | null | undefined): Box | null => {
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const reader = document.querySelector(".reader-pane");
    const area = [...document.querySelectorAll("textarea")].find(
      (node) => node.closest(".quick-reply") !== null,
    );
    return {
      // Content width: the reader minus the reply bar's inline padding.
      readerWidth: (() => {
        const bar = document.querySelector(".quick-reply");
        if (!reader) return null;
        const width = reader.getBoundingClientRect().width;
        if (!bar) return width;
        const style = getComputedStyle(bar);
        return (
          width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
        );
      })(),
      quickReply: area
        ? {
            width: area.getBoundingClientRect().width,
            height: area.getBoundingClientRect().height,
            footer: box(
              area
                .closest(".quick-reply")
                ?.querySelector(".quick-reply-footer"),
            ),
          }
        : null,
      toolbarGroups: [...document.querySelectorAll(".reader-action-group")].map(
        (node) => box(node),
      ),
      readerNav: box(document.querySelector(".reader-nav")),
    };
  });
}

test.describe("UI matrix 0.4.2", () => {
  test.setTimeout(90_000);
  test.afterAll(async ({ browserName }, testInfo) => {
    const dir = artifactDir(testInfo);
    const names = (await readdir(join(dir, "metrics")).catch(() => []))
      .filter((file) => file.endsWith(".json"))
      .sort();
    const rules: Record<string, { pass: number; fail: number }> = {};
    const failures: Record<string, string[]> = {};
    for (const file of names) {
      const data = JSON.parse(
        await readFile(join(dir, "metrics", file), "utf8"),
      );
      for (const [rule, ok] of Object.entries(
        data.rules as Record<string, boolean>,
      )) {
        rules[rule] ??= { pass: 0, fail: 0 };
        rules[rule][ok ? "pass" : "fail"] += 1;
        if (!ok) (failures[rule] ??= []).push(data.combo);
      }
    }
    let commit = "unknown";
    try {
      commit = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
    } catch {
      // Not a git checkout.
    }
    const playwright = JSON.parse(
      await readFile(
        join(process.cwd(), "node_modules/@playwright/test/package.json"),
        "utf8",
      ),
    ) as { version: string };
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "summary.json"),
      `${JSON.stringify(
        {
          commit,
          project: testInfo.project.name,
          browserName,
          playwright: playwright.version,
          combos: names.map((file) => file.replace(/\.json$/, "")),
          rules,
          failures,
        },
        null,
        2,
      )}\n`,
    );
  });

  for (const combo of combos) {
    test(`matrix ${combo.name}`, async ({ page }, testInfo) => {
      const dir = artifactDir(testInfo);
      await mkdir(join(dir, "metrics"), { recursive: true });
      const shot = (state: string) =>
        page.screenshot({
          animations: "disabled",
          path: join(dir, `${combo.name}-${state}.png`),
        });
      await installMockIpc(page);
      await page.setViewportSize({ width: combo.width, height: combo.height });
      const query = new URLSearchParams({
        rowMix: "1",
        density: combo.density,
        scale: String(combo.scale),
        theme: combo.theme,
        pane: combo.pane,
      });
      await page.goto(`/?${query}`);
      await expect(page.locator(".message-row").first()).toBeVisible();
      await expect
        .poll(() =>
          page.locator("html").evaluate((n) => getComputedStyle(n).fontSize),
        )
        .toBe(`${combo.scale * 16}px`);

      const list = await probeList(page);

      // (b) hover the second row.
      let hover = null;
      const second = page.locator(".message-row").nth(1);
      if ((await second.count()) > 0 && (await second.isVisible())) {
        await second.hover({ timeout: 2000 }).catch(() => undefined);
        hover = await probeHover(page);
      }
      await shot("hover");
      await page.mouse.move(0, 0);

      // (d) the More filters menu.
      let moreMenu = false;
      const more = page.getByRole("button", { name: /^More filters/ });
      if ((await more.count()) > 0 && (await more.first().isVisible())) {
        await more
          .first()
          .click({ timeout: 2000 })
          .catch(() => undefined);
        moreMenu = (await page.getByRole("menu").count()) > 0;
        await shot("more-filters");
        await page.keyboard.press("Escape");
      } else {
        await shot("more-filters");
      }

      // (a) open the first message.
      await page.locator(".message-row").first().click();
      await expect(page.locator(".message-body")).toBeVisible();
      await shot("list-open");

      // (c) quick reply: collapsed, then focused with three lines.
      const reply = page.getByRole("textbox", { name: "Write a reply" });
      let collapsed = null;
      let focused = null;
      if ((await reply.count()) > 0) {
        await reply.scrollIntoViewIfNeeded().catch(() => undefined);
        collapsed = await probeReader(page);
        await reply.click({ timeout: 2000 }).catch(() => undefined);
        await reply.fill("First line\nSecond line\nThird line");
        focused = await probeReader(page);
      }
      await shot("quick-reply");

      const rowW = hover?.row ? hover.row.right - hover.row.left : null;
      const edges = Object.values(list.leftEdges).filter(
        (value): value is number => value !== null,
      );
      const qrWidth =
        focused?.quickReply?.width ?? collapsed?.quickReply?.width;
      const readerWidth = focused?.readerWidth ?? collapsed?.readerWidth;
      const groups = (focused ?? collapsed)?.toolbarGroups ?? null;
      const rules = {
        rowInset:
          list.rowInset !== null &&
          [list.rowInset.left, list.rowInset.right].every(
            (inset) => inset >= 5 && inset <= 7,
          ),
        leftEdgesAligned:
          edges.length === 4 && Math.max(...edges) - Math.min(...edges) <= 1,
        noFilterOverflow:
          list.filterBand !== null &&
          list.filterBand.scrollWidth <= list.filterBand.clientWidth + 1,
        quickReplyWidth:
          qrWidth != null && readerWidth ? qrWidth / readerWidth >= 0.9 : false,
        toolbarGroups:
          groups !== null && groups.length > 0 && groups.length <= 3,
        clusterInsideRow:
          hover?.row != null &&
          hover.cluster != null &&
          hover.cluster.left >= hover.row.left &&
          hover.cluster.right <= hover.row.right &&
          hover.cluster.top >= hover.row.top &&
          hover.cluster.bottom <= hover.row.bottom,
      };
      const metrics = {
        combo: combo.name,
        project: testInfo.project.name,
        rowWidth: rowW,
        list,
        hover,
        moreMenu,
        quickReply: { collapsed, focused },
        rules,
      };
      await writeFile(
        join(dir, "metrics", `${combo.name}.json`),
        `${JSON.stringify(metrics, null, 2)}\n`,
      );
      for (const [rule, ok] of Object.entries(rules))
        expect.soft(ok, `${combo.name}: ${rule}`).toBe(true);
    });
  }
});
