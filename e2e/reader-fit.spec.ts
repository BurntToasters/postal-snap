import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A fixed-width email wider than the reading pane scrolls sideways.
// 2. An email that already fits is shrunk anyway.
// 3. Widening the pane keeps an old, too-small zoom.
// 4. A very wide email shrinks until the text is unreadable.
// Measurements go to test-results/reader-fit.json with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

const results: Record<string, unknown> = {};

test.afterAll(() => {
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/reader-fit.json",
    JSON.stringify(results, null, 2),
  );
});

async function openMessage(page: Page, query: string) {
  await page.goto(`/${query}`);
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(page.getByTitle("Message content")).toBeVisible();
}

function frameMetrics(page: Page) {
  return page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>(
      ".message-body iframe",
    );
    const doc = frame?.contentDocument;
    const root = doc?.documentElement;
    return {
      clientWidth: root?.clientWidth ?? 0,
      scrollWidth: root?.scrollWidth ?? 0,
      zoom: Number(doc?.body.style.zoom || 1),
    };
  });
}

test("fits a fixed-width email to a narrow reading pane", async ({ page }) => {
  await page.setViewportSize({ width: 1242, height: 822 });
  await openMessage(page, "?wideHtml=700");
  await expect
    .poll(async () => {
      const m = await frameMetrics(page);
      return m.scrollWidth - m.clientWidth;
    })
    .toBeLessThanOrEqual(1);
  const fitted = await frameMetrics(page);
  results.narrowPane = fitted;
  expect(fitted.zoom).toBeLessThan(1);
  expect(fitted.zoom).toBeGreaterThanOrEqual(0.6);
  await page.screenshot({ path: "test-results/reader-fit.png" });

  // A wider window lets the email return to full size.
  await page.setViewportSize({ width: 2400, height: 822 });
  await expect.poll(async () => (await frameMetrics(page)).zoom).toBe(1);
  results.widePane = await frameMetrics(page);
});

test("leaves an email that fits at full size", async ({ page }) => {
  await page.setViewportSize({ width: 1242, height: 822 });
  await openMessage(page, "");
  const metrics = await frameMetrics(page);
  results.fitsAlready = metrics;
  expect(metrics.zoom).toBe(1);
});

test("stops shrinking at a readable size", async ({ page }) => {
  await page.setViewportSize({ width: 1242, height: 822 });
  await openMessage(page, "?wideHtml=3000");
  await expect.poll(async () => (await frameMetrics(page)).zoom).toBe(0.6);
  results.veryWide = await frameMetrics(page);
});
