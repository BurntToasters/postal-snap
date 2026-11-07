import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// 0.5.2 narrow list at 200% text (a), and forced-colors drag feedback (b).
// Artifacts: artifacts/0.5.2/narrow-200/metrics-<browser>.json plus PNGs.
//
// Bounds and why:
// - Heading area (title band plus filter track) stays within 1.5 row heights.
//   A row is the unit the list is read in; a heading taller than that eats rows.
// - Rows visible (at least half of the row in view): 1 at both heights. At 200%
//   the toolbar above the list is about 205px and a day header about 80px, so a
//   540px window cannot show a whole 139px row; 700px adds only a header-split row.
// - Heading buttons and filter segments meet the density target token.

const ARTIFACT_DIR = resolve(
  import.meta.dirname,
  "../artifacts/0.5.2/narrow-200",
);
const CASES = [
  { width: 620, height: 540, minRows: 1 },
  { width: 740, height: 700, minRows: 1 },
] as const;
const DENSITIES = ["normal", "comfortable", "compact"] as const;
const HEADING_TO_ROW_MAX = 1.5;

// Each test merges its record into the browser's file, so a worker restart
// after a failing test cannot drop earlier records.
async function recordMetrics(
  browserName: string,
  record: Record<string, unknown>,
) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const file = resolve(ARTIFACT_DIR, `metrics-${browserName}.json`);
  const existing = await readFile(file, "utf8").catch(() => "[]");
  const rows = (JSON.parse(existing) as Array<Record<string, unknown>>).filter(
    (row) => row.key !== record.key,
  );
  rows.push(record);
  await writeFile(file, JSON.stringify(rows, null, 2));
}

test.beforeEach(async ({ page }) => installMockIpc(page));

// Resolves a density token (which may be a min() expression) to CSS pixels.
async function resolveToken(page: Page, token: string) {
  return page.evaluate((name) => {
    const probe = document.createElement("div");
    probe.style.width = `var(${name})`;
    probe.style.position = "absolute";
    document.body.append(probe);
    const px = probe.getBoundingClientRect().width;
    probe.remove();
    return px;
  }, token);
}

test.describe("narrow list at 200% text", () => {
  for (const { width, height, minRows } of CASES) {
    for (const density of DENSITIES) {
      test(`${density} at ${width}x${height} stays usable at 200%`, async ({
        page,
      }, testInfo: TestInfo) => {
        const browserName = testInfo.project.name;
        await page.setViewportSize({ width, height });
        await page.goto(`/?density=${density}&scale=2&theme=light`);
        await expect(page.locator(".message-row").first()).toBeVisible();

        const target = await resolveToken(page, "--target-size");
        const inset = await resolveToken(page, "--target-size-inset");
        const metrics = await page.evaluate(() => {
          const pane = document.querySelector(".message-pane")!;
          const heading = pane.querySelector<HTMLElement>(".pane-heading")!;
          const filter = pane.querySelector<HTMLElement>(".mailbox-filter");
          const list = pane.querySelector<HTMLElement>(".message-list")!;
          const row = pane.querySelector<HTMLElement>(".message-row")!;
          const listBox = list.getBoundingClientRect();
          const headBox = heading.getBoundingClientRect();
          const filterBox = filter?.getBoundingClientRect();
          const rowBox = row.getBoundingClientRect();
          // A row counts when at least half of it is inside the list viewport.
          const rowsVisible = [
            ...pane.querySelectorAll<HTMLElement>(".message-row"),
          ].filter((node) => {
            const box = node.getBoundingClientRect();
            const shown =
              Math.min(box.bottom, listBox.bottom) -
              Math.max(box.top, listBox.top);
            return shown >= box.height / 2;
          }).length;
          const buttons = [
            ...pane.querySelectorAll<HTMLElement>(
              ".pane-heading-actions button",
            ),
          ].map((node) => ({
            label: node.getAttribute("aria-label") ?? node.textContent?.trim(),
            height: node.getBoundingClientRect().height,
            width: node.getBoundingClientRect().width,
          }));
          const segments = [
            ...pane.querySelectorAll<HTMLElement>(
              ".mailbox-filter-control .mailbox-filter-segment",
            ),
          ].map((node) => ({
            label: node.textContent?.trim(),
            height: node.getBoundingClientRect().height,
          }));
          const track = pane.querySelector<HTMLElement>(
            ".mailbox-filter-control",
          );
          return {
            viewport: { width: innerWidth, height: innerHeight },
            fontSize: getComputedStyle(document.documentElement).fontSize,
            headingHeight: headBox.height,
            filterHeight: filterBox?.height ?? 0,
            headingBlockHeight:
              (filterBox?.bottom ?? headBox.bottom) - headBox.top,
            rowHeight: rowBox.height,
            listHeight: listBox.height,
            rowsVisible,
            pageHorizontalOverflow:
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
            filterOverflowsTrack: track
              ? track.scrollWidth - track.clientWidth
              : 0,
            buttons,
            segments,
          };
        });

        const record = {
          density,
          ...metrics,
          targetSize: target,
          targetSizeInset: inset,
          maxHeadingBlock: HEADING_TO_ROW_MAX * metrics.rowHeight,
        };
        const slug = `${density}-${width}x${height}`;
        await recordMetrics(browserName, { key: slug, ...record });
        const shot = resolve(ARTIFACT_DIR, `${slug}.png`);
        await page.screenshot({ path: shot });
        await testInfo.attach(`${slug}.json`, {
          body: JSON.stringify(record, null, 2),
          contentType: "application/json",
        });

        expect(metrics.fontSize).toBe("32px");
        expect(
          metrics.headingBlockHeight,
          "heading area height",
        ).toBeLessThanOrEqual(HEADING_TO_ROW_MAX * metrics.rowHeight);
        expect(metrics.rowsVisible, "rows visible").toBeGreaterThanOrEqual(
          minRows,
        );
        expect(metrics.pageHorizontalOverflow).toBeLessThanOrEqual(0);
        for (const button of metrics.buttons) {
          expect(
            button.height,
            `${button.label} height`,
          ).toBeGreaterThanOrEqual(target);
        }
        for (const segment of metrics.segments) {
          expect(
            segment.height,
            `${segment.label} height`,
          ).toBeGreaterThanOrEqual(inset);
        }
      });
    }
  }
});

test.describe("forced-colors drag feedback", () => {
  test("drop target outline and drag chip use system colors", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ forcedColors: "active" });
    await page.goto("/?threadGap=1&theme=light");
    const source = page.getByRole("treeitem", { name: /Weekend plans/i });
    const folder = page
      .locator("button.folder", { hasText: "Archive" })
      .first();
    await expect(source).toBeVisible();
    await expect(folder).toBeVisible();

    // Synthetic HTML5 drag events drive the same React handlers as a pointer
    // drag, and let the test inspect the drop-target state before the drop.
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      const source = [
        ...document.querySelectorAll<HTMLElement>("[role='treeitem']"),
      ].find((node) => /Weekend plans/i.test(node.textContent ?? ""));
      const target = [
        ...document.querySelectorAll<HTMLElement>("button.folder"),
      ].find((node) => node.textContent?.trim().startsWith("Archive"));
      if (!source || !target) throw new Error("Drag nodes are missing.");
      const fire = (node: Element, type: string) =>
        node.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          }),
        );
      fire(source, "dragstart");
      fire(target, "dragenter");
      fire(target, "dragover");
    });
    await expect(page.locator(".folder.drop-target")).toHaveCount(1);
    await expect(page.locator(".drag-chip")).toHaveCount(1);

    const drag = await page.evaluate(() => {
      const folderNode = document.querySelector<HTMLElement>(
        ".folder.drop-target",
      )!;
      const chip = document.querySelector<HTMLElement>(".drag-chip")!;
      const outline = getComputedStyle(folderNode);
      const chipStyle = getComputedStyle(chip);
      return {
        outlineStyle: outline.outlineStyle,
        outlineWidth: outline.outlineWidth,
        outlineColor: outline.outlineColor,
        plainBorderWidth: getComputedStyle(
          [...document.querySelectorAll<HTMLElement>("button.folder")].find(
            (node) => node.textContent?.trim().startsWith("Trash"),
          )!,
        ).borderTopWidth,
        chipBorderStyle: chipStyle.borderTopStyle,
        chipBorderWidth: chipStyle.borderTopWidth,
        chipBorderColor: chipStyle.borderTopColor,
        chipColor: chipStyle.color,
        chipBackground: chipStyle.backgroundColor,
        chipText: chip.textContent,
      };
    });
    await page.screenshot({
      path: resolve(ARTIFACT_DIR, "forced-colors-drop-target.png"),
      animations: "disabled",
    });
    await recordMetrics(testInfo.project.name, {
      key: "forced-colors-drag",
      ...drag,
    });
    await testInfo.attach("forced-colors-drag.json", {
      body: JSON.stringify(drag, null, 2),
      contentType: "application/json",
    });
    await page.evaluate(() => {
      const source = [
        ...document.querySelectorAll<HTMLElement>("[role='treeitem']"),
      ].find((node) => /Weekend plans/i.test(node.textContent ?? ""));
      source?.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
    });

    // A thicker outline than the 1px ButtonText border on every other folder.
    expect(["solid", "dashed"]).toContain(drag.outlineStyle);
    expect(parseFloat(drag.outlineWidth)).toBeGreaterThan(
      parseFloat(drag.plainBorderWidth),
    );
    expect(drag.outlineColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(drag.chipBorderStyle).toBe("solid");
    expect(parseFloat(drag.chipBorderWidth)).toBeGreaterThan(0);
    expect(drag.chipBorderColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(drag.chipColor).not.toBe(drag.chipBackground);
  });
});
