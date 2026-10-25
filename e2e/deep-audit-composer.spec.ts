import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachIpcLog, recordIpc, recordedCalls } from "./ipc-recorder";
import { installMockIpc } from "./mock-ipc";
import { receivesPointerHit } from "./pointer-hit";

// Failure modes covered here:
// 1. At 620x540 with 200% text the Send bar sits below the window fold and is
//    reachable only by discovering an internal scroll.
// 2. The To input is squeezed below a usable width by the Cc/Bcc/Reply-To
//    toggles sharing its row.
// 3. Fixing (1) with nested scrollers traps keyboard focus or the Send click.
// 4. The reflow breaks the normal desktop layout or the resize memory.
// 5. The scrolling footer clips Send options, so items are visible but get no
//    pointer hits.
// 6. Each scheduling choice must still send at the time it names.
// Screenshots land in test-results/deep-audit-composer-*.png with the IPC log.

test.beforeEach(async ({ page }) => {
  await installMockIpc(page);
  await recordIpc(page);
});

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/deep-audit-composer-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
  await attachIpcLog(page, testInfo);
});

async function openComposer(page: Page, query: string) {
  await page.goto(query);
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await expect(page.locator(".composer-window")).toBeVisible();
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function box(locator: ReturnType<Page["locator"]>): Promise<Box> {
  const value = await locator.boundingBox();
  if (!value) throw new Error("element is not visible");
  return value;
}

async function fillLetter(page: Page, subject: string) {
  await page.locator("#composer-to").fill("pat@example.com");
  await page
    .getByRole("textbox", { name: "Subject", exact: true })
    .fill(subject);
  await page
    .getByRole("textbox", { name: "Message body" })
    .fill("Scheduled body");
}

/** The send_message drafts sent so far in this page. */
async function sentDrafts(page: Page): Promise<Array<{ sendAt?: string }>> {
  return (await recordedCalls(page))
    .filter((call) => call.command === "send_message")
    .map((call) => (call.args as { draft: { sendAt?: string } }).draft);
}

/** Local wall-clock value for a datetime-local input. */
function localInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ].join("T");
}

for (const density of ["comfortable", "compact"] as const) {
  test(`minimum window keeps Send visible: ${density}, 200%`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 620, height: 540 });
    await openComposer(page, `/?density=${density}&scale=2`);

    const composer = await box(page.locator(".composer-window"));
    const send = await box(
      page.getByRole("button", { name: "Send", exact: true }),
    );

    // The window itself must not scroll: the page stays put.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await page.evaluate(() => window.scrollX)).toBe(0);

    // Send is fully inside the composer window and the viewport, no scroll.
    expect(send.y).toBeGreaterThanOrEqual(composer.y - 1);
    expect(send.y + send.height).toBeLessThanOrEqual(
      composer.y + composer.height + 1,
    );
    expect(send.x).toBeGreaterThanOrEqual(composer.x - 1);
    expect(send.x + send.width).toBeLessThanOrEqual(
      composer.x + composer.width + 1,
    );
    expect(send.y).toBeGreaterThanOrEqual(0);
    expect(send.y + send.height).toBeLessThanOrEqual(540);
    expect(send.x + send.width).toBeLessThanOrEqual(620);

    // To keeps a usable width instead of squeezing beside the toggles.
    const toWidth = await page
      .locator("#composer-to")
      .evaluate((node) => (node as HTMLElement).clientWidth);
    expect(toWidth).toBeGreaterThanOrEqual(200);

    // The Cc/Bcc/Reply-To toggles wrap to their own row below To.
    const toBox = await box(page.locator("#composer-to"));
    const toggles = page.locator(".to-field-toggles .cc-toggle");
    expect(await toggles.count()).toBeGreaterThanOrEqual(2);
    for (let index = 0; index < (await toggles.count()); index += 1) {
      const toggle = await box(toggles.nth(index));
      expect(toggle.y).toBeGreaterThanOrEqual(toBox.y + toBox.height - 2);
      expect(toggle.x + toggle.width).toBeLessThanOrEqual(
        composer.x + composer.width + 1,
      );
    }

    // Fill the letter first: this enables Send and proves autosave runs.
    await page.locator("#composer-to").fill("pat@example.com");
    await page
      .getByRole("textbox", { name: "Subject", exact: true })
      .fill("Minimum window audit");
    await page
      .getByRole("textbox", { name: "Message body" })
      .fill("A short line stays editable.");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(page.getByText(/Draft saved/).first()).toBeVisible();

    // Send menu, shortcut hint, and discard affordances are unchanged.
    await expect(
      page.getByRole("button", { name: "Send options" }),
    ).toBeEnabled();
    await expect(page.locator(".send-kbd-hint")).toBeVisible();
    await expect(page.getByRole("button", { name: "Discard" })).toBeVisible();
    await page.getByRole("button", { name: "Send options" }).click();
    // Visible is not enough: each item must be the element a pointer hits.
    const sendMenu = page.getByRole("menu", { name: "Send options" });
    const menuItems = sendMenu.getByRole("menuitem");
    await expect(menuItems).toHaveCount(4);
    for (let index = 0; index < 4; index += 1) {
      const item = menuItems.nth(index);
      await item.scrollIntoViewIfNeeded();
      expect(
        await receivesPointerHit(item),
        `${await item.innerText()} must receive pointer hits`,
      ).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(sendMenu).toHaveCount(0);

    // A long letter makes the middle scroll while the send bar stays put.
    const longBody = Array.from(
      { length: 40 },
      (_, index) => `Audit line ${index + 1} keeps the middle scrolling`,
    ).join("\n");
    await page.getByRole("textbox", { name: "Message body" }).fill(longBody);
    const overflow = await page.locator(".composer-body").evaluate((node) => ({
      scrollable: node.scrollHeight - node.clientHeight,
      clientHeight: node.clientHeight,
    }));
    expect(overflow.scrollable).toBeGreaterThan(40);
    // The send bar must not starve the body at 200%: keep a usable letter area.
    expect(overflow.clientHeight).toBeGreaterThanOrEqual(180);
    await page.locator(".composer-body").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    const pinned = await box(
      page.getByRole("button", { name: "Send", exact: true }),
    );
    expect(pinned.y + pinned.height).toBeLessThanOrEqual(
      composer.y + composer.height + 1,
    );

    // Keyboard focus travels through the dialog into the letter (past the
    // formatting toolbar) while Send stays visible.
    await page.getByRole("textbox", { name: "Subject", exact: true }).click();
    let bodyFocused = false;
    for (let index = 0; index < 20 && !bodyFocused; index += 1) {
      await page.keyboard.press("Tab");
      bodyFocused = await page.evaluate(() => {
        const active = document.activeElement;
        const name =
          active instanceof HTMLElement
            ? (active.getAttribute("aria-label") ?? active.className ?? "")
            : "";
        return name.includes("Message body");
      });
    }
    await expect(
      page.getByRole("textbox", { name: "Message body" }),
    ).toBeFocused();

    // Send from the scrolled body produces the send IPC.
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await recordedCalls(page)).filter(
            (call) => call.command === "send_message",
          ).length,
      )
      .toBeGreaterThan(0);
  });
}

for (const density of ["comfortable", "compact"] as const) {
  test(`normal desktop layout is unchanged: ${density}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openComposer(page, `/?density=${density}&scale=1`);

    const composer = await box(page.locator(".composer-window"));
    const send = await box(
      page.getByRole("button", { name: "Send", exact: true }),
    );
    expect(send.y).toBeGreaterThanOrEqual(composer.y - 1);
    expect(send.y + send.height).toBeLessThanOrEqual(
      composer.y + composer.height + 1,
    );

    // Recipients still share one row at desktop width.
    const toBox = await box(page.locator("#composer-to"));
    const toggles = page.locator(".to-field-toggles .cc-toggle");
    expect(await toggles.count()).toBeGreaterThanOrEqual(2);
    for (let index = 0; index < (await toggles.count()); index += 1) {
      const toggle = await box(toggles.nth(index));
      const middle = toggle.y + toggle.height / 2;
      expect(middle).toBeGreaterThanOrEqual(toBox.y - 1);
      expect(middle).toBeLessThanOrEqual(toBox.y + toBox.height + 1);
    }

    // Resize memory still works: the grip grows the stored window size.
    const grip = page.getByRole("button", { name: "Resize message window" });
    await expect(grip).toBeVisible();
    await grip.focus();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const state = (
            window as unknown as {
              __POSTAL_SNAP_TEST__?: {
                savedSettings?: Array<{ composerWidth?: number }>;
              };
            }
          ).__POSTAL_SNAP_TEST__;
          return state?.savedSettings?.at(-1)?.composerWidth ?? 0;
        }),
      )
      .toBeGreaterThan(composer.width);
  });
}

// Each scheduling choice must receive a pointer hit at 620x540 and send at the
// time it names.
for (const density of ["comfortable", "compact"] as const) {
  test(`Send tonight at 9 PM sends at 9 PM: ${density}, 620x540 200%`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 620, height: 540 });
    await openComposer(page, `/?density=${density}&scale=2`);
    await fillLetter(page, "Tonight");
    await page.getByRole("button", { name: "Send options" }).click();
    const item = page
      .getByRole("menu", { name: "Send options" })
      .getByRole("menuitem", { name: "Send tonight at 9 PM", exact: true });
    await item.scrollIntoViewIfNeeded();
    expect(await receivesPointerHit(item)).toBe(true);
    await item.click();

    await expect(page.locator(".composer-window")).toHaveCount(0);
    const drafts = await sentDrafts(page);
    expect(drafts).toHaveLength(1);
    const when = new Date(drafts[0].sendAt ?? "");
    expect(when.getTime()).toBeGreaterThan(Date.now());
    expect(when.getHours()).toBe(21);
    expect(when.getMinutes()).toBe(0);
  });

  test(`Send tomorrow at 8 AM sends tomorrow: ${density}, 620x540 200%`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 620, height: 540 });
    await openComposer(page, `/?density=${density}&scale=2`);
    await fillLetter(page, "Tomorrow");
    await page.getByRole("button", { name: "Send options" }).click();
    const item = page
      .getByRole("menu", { name: "Send options" })
      .getByRole("menuitem", { name: "Send tomorrow at 8 AM", exact: true });
    await item.scrollIntoViewIfNeeded();
    expect(await receivesPointerHit(item)).toBe(true);
    await item.click();

    await expect(page.locator(".composer-window")).toHaveCount(0);
    const drafts = await sentDrafts(page);
    expect(drafts).toHaveLength(1);
    const when = new Date(drafts[0].sendAt ?? "");
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(when.toDateString()).toBe(tomorrow.toDateString());
    expect(when.getHours()).toBe(8);
    expect(when.getMinutes()).toBe(0);
  });

  test(`a picked date and time sends at that time: ${density}, 620x540 200%`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 620, height: 540 });
    await openComposer(page, `/?density=${density}&scale=2`);
    await fillLetter(page, "Picked");
    await page.getByRole("button", { name: "Send options" }).click();
    const menu = page.getByRole("menu", { name: "Send options" });
    const choose = menu.getByRole("menuitem", {
      name: "Pick a date and time…",
      exact: true,
    });
    await choose.scrollIntoViewIfNeeded();
    expect(await receivesPointerHit(choose)).toBe(true);
    await choose.click();

    const picked = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    picked.setHours(10, 30, 0, 0);
    await menu.getByLabel("Date and time").fill(localInputValue(picked));
    await menu.getByRole("button", { name: "Schedule", exact: true }).click();

    await expect(page.locator(".composer-window")).toHaveCount(0);
    const drafts = await sentDrafts(page);
    expect(drafts).toHaveLength(1);
    expect(new Date(drafts[0].sendAt ?? "").getTime()).toBe(picked.getTime());
  });
}

// The body-level menu keeps the keyboard and dismissal contract.
for (const density of ["comfortable", "compact"] as const) {
  test(`Send options keys work at 620x540 200%: ${density}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 620, height: 540 });
    await openComposer(page, `/?density=${density}&scale=2`);
    await fillLetter(page, "Keyboard");
    const chevron = page.getByRole("button", { name: "Send options" });
    const sendMenu = page.getByRole("menu", { name: "Send options" });
    const items = sendMenu.getByRole("menuitem");

    await chevron.click();
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press("End");
    await expect(items.nth(3)).toBeFocused();
    await page.keyboard.press("Home");
    await expect(items.nth(0)).toBeFocused();
    const menuShot = testInfo.outputPath("send-menu-open-200.png");
    await page.screenshot({ path: menuShot });
    await testInfo.attach("send-menu-open-200", {
      path: menuShot,
      contentType: "image/png",
    });

    await page.keyboard.press("Escape");
    await expect(sendMenu).toHaveCount(0);
    await expect(chevron).toBeFocused();

    // Enter reopens the menu; ArrowDown then Space chooses Send tonight.
    await page.keyboard.press("Enter");
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Space");
    await expect(page.locator(".composer-window")).toHaveCount(0);
    const drafts = await sentDrafts(page);
    expect(drafts).toHaveLength(1);
    expect(new Date(drafts[0].sendAt ?? "").getHours()).toBe(21);
  });

  test(`an outside press closes Send options without sending: ${density}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 620, height: 540 });
    await openComposer(page, `/?density=${density}&scale=2`);
    await fillLetter(page, "Outside");
    await page.getByRole("button", { name: "Send options" }).click();
    const sendMenu = page.getByRole("menu", { name: "Send options" });
    await expect(sendMenu).toBeVisible();

    // The header's middle has no control, so the press lands outside the menu.
    const header = await box(page.locator(".composer-window > header"));
    await page.mouse.click(
      header.x + header.width / 2,
      header.y + header.height / 2,
    );

    await expect(sendMenu).toHaveCount(0);
    await expect(page.locator(".composer-window")).toBeVisible();
    expect(await sentDrafts(page)).toHaveLength(0);
  });
}

// The Send options menu must follow the Send split when the footer scrolls.
for (const density of ["comfortable", "compact"] as const) {
  test(`Send options stay inside the viewport edge when the footer scrolls: ${density}, 620x540 200%`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 620, height: 540 });
    await openComposer(page, `/?density=${density}&scale=2`);
    await fillLetter(page, "Scrolling footer");
    await page.getByRole("button", { name: "Send options" }).click();
    const menu = page.getByRole("menu", { name: "Send options" });
    await expect(menu).toBeVisible();

    const footer = page
      .locator(".composer-window footer")
      .filter({ has: page.locator(".send-split") });
    const overflow = await footer.evaluate((node) => ({
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      "footer must scroll sideways at 620x540 200% so the Send split can move",
    ).toBeGreaterThan(overflow.clientWidth);

    // Scroll about 40px, then wait two frames for the scroll handler.
    await footer.evaluate((node) => {
      node.scrollLeft += 40;
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );

    // --space-2 (0.5rem) in px at the root font size, which scales with text.
    const edge = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const token = root.getPropertyValue("--space-2").trim();
      if (!token.endsWith("rem")) throw new Error(`--space-2 is ${token}`);
      return Number.parseFloat(token) * Number.parseFloat(root.fontSize);
    });
    const split = await box(page.locator(".send-split"));
    const menuBox = await box(menu);
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    const expectedLeft = Math.max(
      edge,
      Math.min(split.x, viewportWidth - edge - menuBox.width),
    );
    expect(
      Math.abs(menuBox.x - expectedLeft),
      `menu left ${menuBox.x}px must follow the Send split (expected ${expectedLeft}px)`,
    ).toBeLessThanOrEqual(1);

    const firstItem = menu.getByRole("menuitem").first();
    expect(
      await receivesPointerHit(firstItem),
      "first Send option must receive pointer hits after the footer scrolls",
    ).toBe(true);
  });
}

// Failures: custom scheduling cannot receive keyboard focus; Tab dismisses
// the form; keyboard submission sends immediately or changes the chosen time.
for (const density of ["comfortable", "compact"] as const) {
  for (const scale of [1, 2]) {
    test(`custom scheduling works by keyboard: ${density}, ${scale * 100}%`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 620, height: 540 });
      await openComposer(page, `/?density=${density}&scale=${scale}`);
      await fillLetter(page, "Keyboard schedule");
      const trigger = page.getByRole("button", { name: "Send options" });
      await trigger.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      const field = page.locator(".schedule-form input");
      await expect(field).toBeFocused();
      const picked = new Date(Date.now() + 3 * 86400000);
      picked.setHours(10, 30, 0, 0);
      await field.fill(localInputValue(picked));
      const schedule = page.getByRole("button", {
        name: "Schedule",
        exact: true,
      });
      // datetime-local has multiple native segments in Chromium.
      for (
        let index = 0;
        index < 12 &&
        !(await schedule.evaluate((node) => node === document.activeElement));
        index++
      ) {
        await page.keyboard.press("Tab");
      }
      await expect(schedule).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(field).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.locator(".send-menu")).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(await sentDrafts(page)).toHaveLength(0);
      await page.keyboard.press("Enter");
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await expect(field).toBeFocused();
      await expect(field).toHaveValue(localInputValue(picked));
      for (
        let index = 0;
        index < 12 &&
        !(await schedule.evaluate((node) => node === document.activeElement));
        index++
      ) {
        await page.keyboard.press("Tab");
      }
      await page.keyboard.press("Enter");
      await expect(page.locator(".composer-window")).toHaveCount(0);
      const drafts = await sentDrafts(page);
      expect(drafts).toHaveLength(1);
      expect(new Date(drafts[0].sendAt ?? "").getTime()).toBe(picked.getTime());
    });
  }
}

// Failures: modifier Send bypasses the chosen date; blank/past dates send
// immediately; closing the picker leaves a stale schedule on normal Send.
for (const density of ["comfortable", "compact"] as const) {
  for (const chord of ["Control+Enter", "Meta+Enter"]) {
    test(`modifier Send respects custom schedule: ${density}, ${chord}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 620, height: 540 });
      await openComposer(page, `/?density=${density}&scale=2`);
      await fillLetter(page, "Modifier schedule");
      await page.getByRole("button", { name: "Send options" }).click();
      await page
        .getByRole("menuitem", { name: "Pick a date and time…", exact: true })
        .click();
      const field = page.locator(".schedule-form input");
      const date = new Date(Date.now() + 3 * 86400000);
      date.setHours(10, 30, 0, 0);
      await field.fill(localInputValue(date));
      await field.press(chord);
      await expect(page.locator(".composer-window")).toHaveCount(0);
      const drafts = await sentDrafts(page);
      expect(drafts).toHaveLength(1);
      expect(new Date(drafts[0].sendAt ?? "").getTime()).toBe(date.getTime());
    });

    test(`modifier Send refuses invalid schedules and normal Send stays immediate: ${density}, ${chord}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 620, height: 540 });
      await openComposer(page, `/?density=${density}&scale=2`);
      await fillLetter(page, "Invalid schedule");
      await page.getByRole("button", { name: "Send options" }).click();
      await page
        .getByRole("menuitem", { name: "Pick a date and time…", exact: true })
        .click();
      const field = page.locator(".schedule-form input");
      await field.press(chord);
      // Escape remains available; no request may reach the send IPC.
      await expect(page.locator(".composer-window")).toBeVisible();
      expect(await sentDrafts(page)).toHaveLength(0);
      const past = new Date(Date.now() - 86400000);
      past.setHours(10, 30, 0, 0);
      await field.fill(localInputValue(past));
      await field.press(chord);
      await expect(page.locator(".composer-window")).toBeVisible();
      expect(await sentDrafts(page)).toHaveLength(0);
      const distant = new Date(Date.now() + 400 * 86400000);
      await field.fill(localInputValue(distant));
      await field.press(chord);
      await expect(page.locator(".composer-window")).toBeVisible();
      expect(await sentDrafts(page)).toHaveLength(0);
      await page.keyboard.press("Escape");
      await expect(page.locator(".schedule-form")).toHaveCount(0);
      await page.getByRole("textbox", { name: "Message body" }).focus();
      await page.keyboard.press(chord);
      await expect(page.locator(".composer-window")).toHaveCount(0);
      const drafts = await sentDrafts(page);
      expect(drafts).toHaveLength(1);
      expect(drafts[0].sendAt).toBeUndefined();
    });
  }
}

// Failure: editing a link leaves the underlying composer's Send shortcut live.
for (const density of ["comfortable", "compact"] as const) {
  for (const chord of ["Control+Enter", "Meta+Enter"]) {
    test(`link dialog blocks underlying Send: ${density}, ${chord}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 620, height: 540 });
      await openComposer(page, `/?density=${density}&scale=2`);
      await fillLetter(page, "Link editing");
      await page.getByRole("button", { name: "Show formatting" }).click();
      await page.getByRole("button", { name: "More formatting" }).click();
      await page
        .getByRole("button", { name: "Insert link", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Insert link",
        exact: true,
      });
      const field = dialog.getByRole("textbox", { name: "Web address" });
      await field.fill("https://example.test/resource");
      await field.press(chord);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(await sentDrafts(page)).toHaveLength(0);
      await expect(page.locator(".composer-window")).toBeVisible();
    });
  }
}
