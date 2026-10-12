import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Full-screen reading leaves the mailbox visible around the message.
// 2. Reply sits further left than the subject.
// 3. The list header and the reader toolbar end on different lines.
// 4. Search is taller than Compose, so the toolbar looks uneven.
// 5. The letter starts further left than the subject, including full screen.
// 6. The mailbox title does not line up with the sender.
// 7. Bottom reading hides the letter under the window edge.
// 8. The composer letter does not share the address-field inset.

test.beforeEach(async ({ page }) => installMockIpc(page));

async function openWeekend(page: Page, query = "") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/${query}`);
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
}

test("full-screen reading covers the mailbox", async ({ page }) => {
  await openWeekend(page, "?pane=hidden&theme=dark");
  await expect(page.getByRole("dialog")).toBeVisible();

  const coverage = await page.evaluate(() => {
    const chrome = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--native-chrome-height",
      ),
    );
    const reader = document
      .getElementById("reader-pane")!
      .getBoundingClientRect();
    const misses: Array<{ x: number; y: number; name: string }> = [];
    const xs = [8, 36, window.innerWidth / 2, window.innerWidth - 8];
    const ys = [
      chrome + 8,
      chrome + 36,
      window.innerHeight / 2,
      window.innerHeight - 8,
    ];
    for (const x of xs) {
      for (const y of ys) {
        const hit = document.elementFromPoint(x, y);
        if (!hit?.closest("#reader-pane, .window-chrome")) {
          misses.push({
            x,
            y,
            name:
              hit instanceof Element
                ? `${hit.tagName}.${hit.className}`
                : "none",
          });
        }
      }
    }
    return {
      chrome,
      top: reader.top,
      left: reader.left,
      right: reader.right,
      bottom: reader.bottom,
      width: window.innerWidth,
      height: window.innerHeight,
      misses,
    };
  });

  expect(coverage.misses).toEqual([]);
  expect(coverage.top).toBeLessThanOrEqual(1);
  expect(coverage.left).toBeLessThanOrEqual(1);
  expect(coverage.right).toBeGreaterThanOrEqual(coverage.width - 1);
  expect(coverage.bottom).toBeGreaterThanOrEqual(coverage.height - 1);

  const close = await page
    .getByRole("button", { name: "Close message" })
    .boundingBox();
  const platform = await page.evaluate(
    () => document.documentElement.dataset.platform,
  );
  expect(close!.y).toBeLessThan(coverage.chrome + 8);
  if (platform === "macos") expect(close!.x).toBeGreaterThanOrEqual(78);

  mkdirSync("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/reader-chrome-hidden.png",
    animations: "disabled",
  });
  writeFileSync(
    "test-results/reader-chrome-hidden.json",
    JSON.stringify(coverage, null, 2),
  );
});

test("mail toolbars share insets with the message and the list", async ({
  page,
}) => {
  await openWeekend(page, "?theme=light");

  const aligned = await page.evaluate(() => {
    const box = (selector: string) => {
      const node = document.querySelector(selector);
      if (!(node instanceof HTMLElement)) throw new Error(selector);
      return node.getBoundingClientRect();
    };
    const title = box("#message-title");
    const actions = box(".reader-action-group");
    const heading = box(".pane-heading");
    const readerBar = box(".reader-actions");
    const compose = box(".compose-button");
    const search = box(".search-box");
    const scope = box(".search-scope");
    return {
      actionInset: Math.round(actions.left - title.left),
      barDelta: Math.round(readerBar.bottom - heading.bottom),
      searchDelta: Math.round(search.height - compose.height),
      scopeHeight: Math.round(scope.height),
    };
  });

  expect(Math.abs(aligned.actionInset)).toBeLessThanOrEqual(1);
  expect(Math.abs(aligned.barDelta)).toBeLessThanOrEqual(1);
  expect(Math.abs(aligned.searchDelta)).toBeLessThanOrEqual(1);
  expect(aligned.scopeHeight).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: "test-results/reader-chrome-aligned.png",
    animations: "disabled",
  });

  await page.goto("/?density=compact&theme=dark");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  const compact = await page.evaluate(() => {
    const box = (selector: string) =>
      document.querySelector(selector)!.getBoundingClientRect();
    return {
      actionInset: Math.round(
        box(".reader-action-group").left - box("#message-title").left,
      ),
      barDelta: Math.round(
        box(".reader-actions").bottom - box(".pane-heading").bottom,
      ),
    };
  });
  expect(Math.abs(compact.actionInset)).toBeLessThanOrEqual(1);
  expect(Math.abs(compact.barDelta)).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: "test-results/reader-chrome-compact.png",
    animations: "disabled",
  });
});

test("large text keeps toolbar labels inside their controls", async ({
  page,
}) => {
  await openWeekend(page, "?scale=2&theme=light");
  const clipped = await page.evaluate(() => {
    const nodes = [
      ...document.querySelectorAll(
        ".reader-actions button, .compose-button, .get-mail-button, .search-box",
      ),
    ];
    return nodes
      .filter(
        (node) =>
          node instanceof HTMLElement &&
          (node.scrollHeight > node.clientHeight + 1 ||
            node.scrollWidth > node.clientWidth + 1),
      )
      .map((node) =>
        node instanceof HTMLElement ? node.innerText || node.className : "",
      );
  });
  expect(clipped).toEqual([]);
  const largeBars = await page.evaluate(() => {
    const box = (selector: string) =>
      document.querySelector(selector)!.getBoundingClientRect();
    return Math.round(
      box(".reader-actions").bottom - box(".pane-heading").bottom,
    );
  });
  expect(Math.abs(largeBars)).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: "test-results/reader-chrome-large.png",
    animations: "disabled",
  });

  await page.goto("/?pane=hidden&scale=2&theme=dark");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({
    path: "test-results/reader-chrome-hidden-large.png",
    animations: "disabled",
  });
});

test("composer toolbars use the same inset as the address fields", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page
    .getByRole("button", { name: /formatting/i })
    .first()
    .click();
  const pads = await page.evaluate(() => {
    const pad = (selector: string) =>
      getComputedStyle(document.querySelector(selector)!).paddingLeft;
    return {
      address: pad(".address-fields"),
      format: pad(".format-toolbar"),
      header: pad(".composer-window > header"),
      footer: pad(".composer-window footer"),
      editor: pad(".tiptap"),
    };
  });
  expect(pads.format).toBe(pads.address);
  expect(pads.header).toBe(pads.address);
  expect(pads.footer).toBe(pads.address);
  expect(pads.editor).toBe(pads.address);
  await page.screenshot({
    path: "test-results/reader-chrome-composer.png",
    animations: "disabled",
  });
});

function textLeft(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!(node instanceof HTMLElement)) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect().left;
  }, selector);
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

for (const [name, query] of [
  ["reading pane", "?theme=light"],
  ["full screen", "?pane=hidden&theme=dark"],
  ["compact", "?density=compact&theme=light"],
  ["bottom", "?pane=bottom&theme=light"],
] as const) {
  test(`the letter lines up with the subject in the ${name}`, async ({
    page,
  }) => {
    await openWeekend(page, query);
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

test("the mailbox title lines up with the sender", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?theme=light");
  const title = await textLeft(page, ".pane-heading h1");
  const sender = await textLeft(page, ".message-sender");
  expect(title).not.toBeNull();
  expect(Math.abs((sender ?? 0) - (title ?? 0))).toBeLessThanOrEqual(1);

  await page.goto("/?density=compact&scale=2");
  const compactTitle = await textLeft(page, ".pane-heading h1");
  const compactSender = await textLeft(page, ".message-sender");
  expect(
    Math.abs((compactSender ?? 0) - (compactTitle ?? 0)),
  ).toBeLessThanOrEqual(1);
});

test("bottom reading keeps the letter inside the pane", async ({ page }) => {
  await openWeekend(page, "?pane=bottom&theme=light");
  const boxes = await page.evaluate(() => {
    const pane = document
      .querySelector(".reader-pane")!
      .getBoundingClientRect();
    const body = document
      .querySelector(".message-body")!
      .getBoundingClientRect();
    return {
      paneBottom: pane.bottom,
      bodyTop: body.top,
      bodyBottom: body.bottom,
      bodyHeight: body.height,
      paneTop: pane.top,
    };
  });
  expect(boxes.bodyTop).toBeGreaterThanOrEqual(boxes.paneTop);
  expect(boxes.bodyBottom).toBeLessThanOrEqual(boxes.paneBottom + 1);
  expect(boxes.bodyHeight).toBeGreaterThan(48);
});

test("plain text uses the same inset as the subject", async ({ page }) => {
  await openWeekend(page, "?blankHtml=1&theme=light");
  const subject = await textLeft(page, "#message-title");
  const body = await textLeft(page, ".plain-text-body");
  expect(subject).not.toBeNull();
  expect(Math.abs((body ?? 0) - (subject ?? 0))).toBeLessThanOrEqual(1);
});
