import type { Locator } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. At 200% text, toolbar and folder icons stay at their 100% size.
// 2. At 200% text, Settings selects clip their value ("Auto (Sy").
// 3. At 200% text, Get Mail wraps or is clipped by Compose.
// 4. At 200% text, setup step numbers spill out of their circles.
// 5. In a narrow window the reader date takes the sender's place.

test.beforeEach(async ({ page }) => installMockIpc(page));

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  if (!value) throw new Error("Element has no layout box");
  return value;
}

test("icons grow with 200% text", async ({ page }) => {
  await page.goto("/?scale=2");
  const getMail = page.locator(".get-mail-button svg");
  const folder = page.locator(".folder svg").first();
  expect((await box(getMail)).width).toBeGreaterThanOrEqual(30);
  expect((await box(folder)).height).toBeGreaterThanOrEqual(30);
  await page.screenshot({ path: "test-results/large-text-mailbox.png" });
});

test("Get Mail stays on one unclipped line at 200% text", async ({ page }) => {
  await page.goto("/?scale=2");
  const button = page.getByRole("button", { name: "Get Mail" });
  const fits = await button.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  );
  expect(fits).toBe(true);
  const compose = await box(page.getByRole("button", { name: "Compose" }));
  const getMail = await box(button);
  expect(getMail.x + getMail.width).toBeLessThanOrEqual(compose.x);
  expect(getMail.height).toBeLessThan(compose.height * 1.5);
});

test("Settings selects show their whole value at 200% text", async ({
  page,
}) => {
  await page.goto("/?scale=2");
  await page.getByRole("button", { name: "Settings" }).click();
  const appearance = page.getByRole("combobox", { name: "Appearance" });
  await expect(appearance).toBeVisible();
  const clipped = await appearance.evaluate((element) => {
    const select = element as HTMLSelectElement;
    const probe = document.createElement("span");
    probe.textContent = select.selectedOptions[0]?.text ?? "";
    probe.style.font = getComputedStyle(select).font;
    probe.style.position = "absolute";
    document.body.append(probe);
    const needed = probe.getBoundingClientRect().width;
    probe.remove();
    return needed > select.clientWidth;
  });
  expect(clipped).toBe(false);
  await page.screenshot({ path: "test-results/large-text-settings.png" });
});

test("setup step numbers fit their circles at 200% text", async ({ page }) => {
  await page.goto("/?firstRun=1&scale=2");
  const step = page.locator(".setup-flow-progress > div > span").first();
  await expect(step).toBeVisible();
  const overflows = await step.evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1,
  );
  expect(overflows).toBe(false);
});

test("narrow reader keeps the sender beside the avatar", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 700 });
  await page.goto("/");
  await page.locator('[role="option"]').first().click();
  const avatar = await box(page.locator(".message-header .sender-avatar"));
  const sender = await box(page.locator(".message-header .sender-details"));
  const time = await box(page.locator(".message-header time"));
  expect(sender.x).toBeGreaterThan(avatar.x + avatar.width - 1);
  expect(sender.y).toBeLessThan(avatar.y + avatar.height);
  expect(time.y).toBeGreaterThanOrEqual(sender.y + sender.height - 1);
  await page.screenshot({ path: "test-results/narrow-reader-header.png" });
});
