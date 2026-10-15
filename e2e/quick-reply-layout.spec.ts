import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The box is a sliver (textarea inside a label) instead of full width.
// 2. The box edge does not line up with the message title.
// 3. Collapsed, the box is taller than one control or shows the footer.
// 4. Focused or filled, the box stays under three lines or loses its footer.
// 5. A filled box collapses on blur (WebKit buttons never take focus).
// 6. The box does not grow with typing, or grows past its token cap.
// 7. The bottom pane cap or the static short-window rule is lost.
// 8. Reply is not the rightmost footer button.
// 9. Ctrl/Cmd+Enter does not open the reply composer.
// 10. A note leaks to another message or expands the wrong one.
// Compact density and 200% text are covered. Each test ends with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/quick-reply-layout-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

async function openMessage(page: Page, query = "") {
  await page.goto(`/${query ? `?${query}` : ""}`);
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
  await expect(page.locator("form.quick-reply")).toBeVisible();
}

const noteBox = (page: Page) =>
  page.getByRole("textbox", { name: "Write a reply" });

async function rect(locator: Locator) {
  const value = await locator.boundingBox();
  if (!value) throw new Error("element is not visible");
  return value;
}

// Resolves any length expression (token, min(), dvh) to pixels.
async function px(page: Page, expression: string): Promise<number> {
  return page.evaluate((value) => {
    const probe = document.createElement("div");
    probe.style.cssText = `position:absolute;visibility:hidden;height:${value}`;
    (document.querySelector(".mail-shell") ?? document.body).append(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    return height;
  }, expression);
}

async function lineHeight(box: Locator): Promise<number> {
  return box.evaluate((node) => {
    const style = getComputedStyle(node);
    const value = parseFloat(style.lineHeight);
    return Number.isNaN(value) ? parseFloat(style.fontSize) * 1.2 : value;
  });
}

const lines = (count: number) =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");

const variants = [
  ["comfortable", ""],
  ["compact", "density=compact"],
  ["200% text", "scale=2"],
] as const;

for (const [label, query] of variants) {
  test(`collapsed box is one control, full width, and aligned (${label})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openMessage(page, query);
    const box = noteBox(page);
    const textarea = await rect(box);
    const control = await px(page, "var(--control-height)");
    expect(textarea.height).toBeLessThanOrEqual(control * 1.3);
    const pane = await rect(page.locator(".reader-pane"));
    const title = await rect(page.locator("#message-title"));
    const content = pane.width - 2 * (title.x - pane.x);
    expect(textarea.width).toBeGreaterThanOrEqual(content * 0.9);
    expect(Math.abs(textarea.x - title.x)).toBeLessThanOrEqual(1);
    await expect(page.locator(".quick-reply-footer")).toBeHidden();
  });

  test(`focused box shows three lines and the footer (${label})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openMessage(page, `${query}&groupReply=1&replyAllPref=1`);
    const box = noteBox(page);
    await box.focus();
    const textarea = await rect(box);
    expect(textarea.height).toBeGreaterThanOrEqual((await lineHeight(box)) * 3);
    const footer = page.locator(".quick-reply-footer");
    await expect(footer).toBeVisible();
    await expect(footer.locator(".quick-reply-to")).toContainText("To Jane");
    const reply = await rect(
      footer.getByRole("button", { name: "Start reply", exact: true }),
    );
    const all = await rect(
      footer.getByRole("button", { name: "Start reply to everyone" }),
    );
    expect(reply.x).toBeGreaterThan(all.x);
    expect(reply.x + reply.width).toBeGreaterThanOrEqual(all.x + all.width);
    const to = await rect(footer.locator(".quick-reply-to"));
    expect(to.x).toBeLessThan(all.x);
  });
}

test("a filled box stays expanded after focus leaves", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openMessage(page);
  const box = noteBox(page);
  await box.fill("See you then");
  await page.locator("#message-title").click();
  await expect(box).not.toBeFocused();
  expect((await rect(box)).height).toBeGreaterThanOrEqual(
    (await lineHeight(box)) * 3,
  );
  await expect(page.locator(".quick-reply-footer")).toBeVisible();
  await expect(page.locator("form.quick-reply")).toHaveAttribute(
    "data-filled",
    /.*/,
  );
});

for (const [label, query] of variants) {
  test(`typing grows the box up to the token cap (${label})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openMessage(page, query);
    const box = noteBox(page);
    const cap = await px(page, "var(--quick-reply-max-block)");
    expect(cap).toBeGreaterThan(0);
    await box.fill(lines(4));
    const four = (await rect(box)).height;
    await box.fill(lines(40));
    const many = (await rect(box)).height;
    expect(many).toBeGreaterThanOrEqual(four);
    expect(many).toBeLessThanOrEqual(cap + 1);
    expect(many).toBeGreaterThanOrEqual(cap - 2);
    expect(
      await box.evaluate((node) => node.scrollHeight > node.clientHeight),
    ).toBe(true);
  });
}

test("the box grows line by line below the cap", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openMessage(page);
  const box = noteBox(page);
  const cap = await px(page, "var(--quick-reply-max-block)");
  const line = await lineHeight(box);
  await box.fill(lines(3));
  const three = (await rect(box)).height;
  if (cap > three + line * 1.5) {
    await box.fill(lines(5));
    expect((await rect(box)).height).toBeGreaterThan(three + line);
  }
  expect(cap).toBeGreaterThan(0);
});

test("the bottom pane caps the box at a share of the reader", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openMessage(page, "pane=bottom");
  const box = noteBox(page);
  await box.fill(lines(40));
  const height = (await rect(box)).height;
  const reader = await px(page, "var(--rendered-reader-height)");
  expect(height).toBeLessThanOrEqual(reader * 0.35 + 1);
  const form = await rect(page.locator("form.quick-reply"));
  expect(form.height).toBeLessThan(reader * 0.6);
  expect(await px(page, "var(--quick-reply-max-block)")).toBeGreaterThan(0);
});

test("short windows keep the quick reply static", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await openMessage(page);
  await expect(page.locator("form.quick-reply")).toHaveCSS(
    "position",
    "static",
  );
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(page.locator("form.quick-reply")).toHaveCSS(
    "position",
    "sticky",
  );
});

test("Ctrl+Enter starts the reply with the note", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openMessage(page);
  const box = noteBox(page);
  await box.fill("See you then");
  await box.press("Control+Enter");
  await expect(
    page.getByRole("textbox", { name: "Subject", exact: true }),
  ).toHaveValue(/Weekend plans/);
  await expect(box).toHaveValue("");
  const body = page.getByRole("textbox", { name: "Message body", exact: true });
  await expect(body).toContainText("See you then");
  await expect(body).toBeFocused();
});

test("Cmd+Enter starts the reply with the note", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openMessage(page);
  const box = noteBox(page);
  await box.fill("On my way");
  await box.press("Meta+Enter");
  await expect(
    page.getByRole("textbox", { name: "Subject", exact: true }),
  ).toHaveValue(/Weekend plans/);
  const body = page.getByRole("textbox", { name: "Message body", exact: true });
  await expect(body).toContainText("On my way");
  await expect(body).toBeFocused();
});

test("notes expand only their own message", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?threadGap=1");
  const weekend = page.getByRole("treeitem", {
    name: /Conversation, Jane.*Weekend plans/i,
  });
  const older = page.getByRole("treeitem", { name: /Older family note/i });
  await weekend.click();
  const box = noteBox(page);
  const form = page.locator("form.quick-reply");
  const collapsed = (await rect(box)).height;
  await box.fill("See you then");
  await older.click();
  await expect(
    page.getByRole("heading", { name: "Older family note" }),
  ).toBeVisible();
  await expect(box).toHaveValue("");
  await expect(form).not.toHaveAttribute("data-filled", /.*/);
  expect((await rect(box)).height).toBeLessThanOrEqual(collapsed + 1);
  await weekend.click();
  await expect(box).toHaveValue("See you then");
  await expect(form).toHaveAttribute("data-filled", /.*/);
  expect((await rect(box)).height).toBeGreaterThan(collapsed + 1);
});
