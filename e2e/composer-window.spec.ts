import { mkdirSync, writeFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The reply composer docks so short that only a few lines fit.
// 2. Dragging the header moves the whole app window instead.
// 3. Header buttons start a drag instead of acting.
// 4. The composer can be dragged off-screen, losing its header.
// 5. Maximize keeps the drag offset, or Restore forgets the placement.
// 6. Resize goes below a usable size, past the window, or needs a mouse.
// 7. Narrow windows get a floating composer or a move cursor.
// 8. Reply quotes show raw ISO time; forwards lose sender, date, subject.
// 9. Restore after the app window shrank puts the composer off-screen.
// 10. The resize grip is smaller than the 44px target minimum.
// Measurements go to test-results/composer-window.json with a screenshot.

test.beforeEach(async ({ page }) => installMockIpc(page));

const results: Record<string, unknown> = {};

function composer(page: Page): Locator {
  return page.locator(".composer-window");
}

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  if (!value) throw new Error("composer is not visible");
  return value;
}

async function dragBy(page: Page, handle: Locator, dx: number, dy: number) {
  const start = await box(handle);
  const x = start.x + Math.min(40, start.width / 2);
  const y = start.y + start.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

async function openReply(page: Page) {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(composer(page)).toBeVisible();
}

test.afterAll(() => {
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/composer-window.json",
    JSON.stringify(results, null, 2),
  );
});

test("reply and new message leave room to write", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openReply(page);
  const replyEditor = await box(page.locator(".composer-window .tiptap"));
  results.replyEditorHeight = replyEditor.height;
  expect(replyEditor.height).toBeGreaterThanOrEqual(240);
  await page.getByRole("button", { name: "Save draft and close" }).click();

  await page.getByRole("button", { name: "Compose" }).click();
  const editor = await box(page.locator(".composer-window .tiptap"));
  results.composeEditorHeight = editor.height;
  expect(editor.height).toBeGreaterThanOrEqual(320);
});

test("drags inside the app and stays on screen", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openReply(page);
  const header = page.locator(".composer-window > header");
  await expect(header).not.toHaveAttribute("data-tauri-drag-region", /.*/);

  const before = await box(composer(page));
  await dragBy(page, header, -150, -80);
  const after = await box(composer(page));
  results.dragDelta = { x: after.x - before.x, y: after.y - before.y };
  expect(Math.round(after.x - before.x)).toBe(-150);
  expect(Math.round(after.y - before.y)).toBe(-80);

  // Far past the corner: the header must stay reachable.
  await dragBy(page, header, 3000, 3000);
  const clamped = await box(composer(page));
  const clampedHeader = await box(header);
  results.clampedComposer = clamped;
  expect(clamped.x + 80).toBeLessThanOrEqual(1280);
  expect(clampedHeader.y + clampedHeader.height).toBeLessThanOrEqual(800);
  await dragBy(page, header, -6000, -6000);
  const topLeft = await box(composer(page));
  expect(topLeft.y).toBeGreaterThanOrEqual(0);
  expect(topLeft.x + topLeft.width).toBeGreaterThanOrEqual(80);
});

test("header buttons act instead of dragging", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openReply(page);
  const placed = await box(composer(page));
  await page.getByRole("button", { name: "Maximize editor" }).click();
  const maximized = await box(composer(page));
  expect(maximized.width).toBeGreaterThan(placed.width);

  await page.getByRole("button", { name: "Restore editor" }).click();
  await dragBy(page, page.locator(".composer-window > header"), -100, -50);
  const moved = await box(composer(page));
  await page.getByRole("button", { name: "Maximize editor" }).click();
  const full = await box(composer(page));
  expect(full.x).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Restore editor" }).click();
  const restored = await box(composer(page));
  results.restoreDelta = { x: restored.x - moved.x, y: restored.y - moved.y };
  expect(Math.abs(restored.x - moved.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(restored.y - moved.y)).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "Minimize draft" }).click();
  await expect(composer(page)).toHaveCount(0);
});

test("resizes with the grip and keyboard within limits", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Compose" }).click();
  const grip = page.getByRole("button", { name: "Resize message window" });
  await expect(grip).toBeVisible();

  const gripBox = await box(grip);
  results.gripSize = { width: gripBox.width, height: gripBox.height };
  expect(gripBox.width).toBeGreaterThanOrEqual(44);
  expect(gripBox.height).toBeGreaterThanOrEqual(44);

  const before = await box(composer(page));
  await dragBy(page, grip, -200, -150);
  const smaller = await box(composer(page));
  expect(smaller.width).toBeLessThan(before.width);
  expect(smaller.height).toBeLessThan(before.height);

  await dragBy(page, grip, -3000, -3000);
  const minimum = await box(composer(page));
  results.minimumSize = { width: minimum.width, height: minimum.height };
  expect(minimum.width).toBeGreaterThanOrEqual(480);
  expect(minimum.height).toBeGreaterThanOrEqual(360);

  await grip.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  const keyed = await box(composer(page));
  expect(keyed.width).toBeGreaterThan(minimum.width);
  expect(keyed.height).toBeGreaterThan(minimum.height);

  await dragBy(page, grip, 4000, 4000);
  const maximum = await box(composer(page));
  expect(maximum.x + maximum.width).toBeLessThanOrEqual(1280);
  expect(maximum.y + maximum.height).toBeLessThanOrEqual(800);
  await page.screenshot({ path: "test-results/composer-window.png" });
});

test("narrow windows keep a full-window composer", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Compose" }).click();
  await expect(composer(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Resize message window" }),
  ).toHaveCount(0);
  await expect(page.locator(".composer-window > header")).not.toHaveCSS(
    "cursor",
    "move",
  );
  const before = await box(composer(page));
  await dragBy(page, page.locator(".composer-window > header"), 100, 100);
  const after = await box(composer(page));
  expect(after.x).toBe(before.x);
  expect(after.y).toBe(before.y);
});

test("reply and forward quote readable headers", async ({ page }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await page.setViewportSize({ width: 1280, height: 800 });
  await openReply(page);
  const reply = page.locator(".composer-window .tiptap");
  await expect(reply).toContainText("Jane wrote:");
  await expect(reply).not.toContainText("T12:00:00Z");
  await page.getByRole("button", { name: "Save draft and close" }).click();
  await expect(composer(page)).toHaveCount(0);

  await page.getByRole("button", { name: "Forward", exact: true }).click();
  const forward = page.locator(".composer-window .tiptap");
  await expect(forward).toContainText("Forwarded message");
  await expect(forward).toContainText("From: Jane <jane@example.com>");
  await expect(forward).toContainText("Subject: Weekend plans");
  await expect(forward).not.toContainText("T12:00:00Z");
  results.forwardQuote = await forward.innerText();
});

test("restore after the window shrinks stays on screen", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Compose" }).click();
  await dragBy(page, page.locator(".composer-window > header"), 150, 0);
  await page.getByRole("button", { name: "Maximize editor" }).click();
  await page.setViewportSize({ width: 900, height: 700 });
  await page.getByRole("button", { name: "Restore editor" }).click();
  const restored = await box(composer(page));
  results.restoredAfterShrink = restored;
  expect(restored.x + 80).toBeLessThanOrEqual(900);
  expect(restored.x + restored.width).toBeGreaterThanOrEqual(80);
  expect(restored.width).toBeLessThanOrEqual(900);
});
