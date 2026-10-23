import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachIpcLog, recordIpc, recordedCalls } from "./ipc-recorder";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. At 620x540 with 200% text the Send bar sits below the window fold and is
//    reachable only by discovering an internal scroll.
// 2. The To input is squeezed below a usable width by the Cc/Bcc/Reply-To
//    toggles sharing its row.
// 3. Fixing (1) with nested scrollers traps keyboard focus or the Send click.
// 4. The reflow breaks the normal desktop layout or the resize memory.
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
    await expect(
      page.getByRole("menuitem", { name: "Send now" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitem", { name: "Send now" })).toHaveCount(
      0,
    );

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
