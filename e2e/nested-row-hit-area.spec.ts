import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

test.beforeEach(async ({ page }) => installMockIpc(page));

for (const [label, query] of [
  ["comfortable 100%", ""],
  ["compact 100%", "&density=compact"],
  ["comfortable 200%", "&scale=2"],
  ["compact 200%", "&density=compact&scale=2"],
] as const) {
  test(`a nested row opens from its center with hover actions visible (${label})`, async ({
    page,
  }, testInfo: TestInfo) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/?threadGap=1${query}`);

    await page
      .getByRole("treeitem", {
        name: /Conversation, Jane.*Weekend plans/i,
      })
      .click();
    const older = page.getByRole("treeitem", { name: /Older family note/i });
    await expect(older).toBeVisible();
    await older.scrollIntoViewIfNeeded();
    const star = older
      .locator("xpath=..")
      .locator('button.row-action[data-action="star"]');

    const point = await older.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    });
    await page.mouse.move(point.x, point.y);
    await expect
      .poll(() =>
        older
          .locator("xpath=..")
          .locator(".row-actions")
          .evaluate((node) => getComputedStyle(node).opacity),
      )
      .toBe("1");

    const center = await older.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      const wrap = node.parentElement;
      const cluster = wrap?.querySelector(".row-actions");
      const clusterRect = cluster?.getBoundingClientRect();
      return {
        row: {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
        },
        point: { x, y },
        hit: {
          tag: hit?.tagName ?? null,
          className: hit instanceof HTMLElement ? hit.className : null,
          row: hit?.closest(".message-row") === node,
          action:
            hit?.closest("button.row-action")?.getAttribute("data-action") ??
            null,
        },
        cluster: clusterRect
          ? {
              left: clusterRect.left,
              right: clusterRect.right,
              top: clusterRect.top,
              bottom: clusterRect.bottom,
              opacity: getComputedStyle(cluster!).opacity,
            }
          : null,
        starPressed: wrap
          ?.querySelector('button.row-action[data-action="star"]')
          ?.getAttribute("aria-pressed"),
      };
    });

    await page.mouse.click(center.point.x, center.point.y);
    await page
      .waitForFunction(
        () =>
          document.querySelector("#message-title")?.textContent?.trim() ===
            "Older family note" ||
          document
            .querySelector(
              '.message-row-wrap.thread-child button.row-action[data-action="star"]',
            )
            ?.getAttribute("aria-pressed") === "true",
        null,
        { timeout: 1500 },
      )
      .catch(() => undefined);

    const result = {
      variant: label,
      before: center,
      after: {
        heading: await page.locator("#message-title").textContent(),
        starPressed: await star.getAttribute("aria-pressed"),
      },
    };
    const screenshot = testInfo.outputPath("nested-row-center.png");
    await page.screenshot({ path: screenshot });
    await testInfo.attach("nested-row-center", {
      path: screenshot,
      contentType: "image/png",
    });
    await testInfo.attach("nested-row-center-geometry", {
      body: `${JSON.stringify(result, null, 2)}\n`,
      contentType: "application/json",
    });

    expect(center.hit.row).toBe(true);
    expect(center.hit.action).toBeNull();
    expect(result.after.heading?.trim()).toBe("Older family note");
    expect(result.after.starPressed).toBe("false");
  });
}
