import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifactsAfterEach, ipcCommands } from "./ipc";

test.afterEach(attachArtifactsAfterEach);

// Failure modes (FMn) for native window glass in the web layer:
// FM1 supported and enabled -> vibrant; sidebar transparent, content opaque.
// FM2 native reduced transparency -> opaque chrome.
// FM3 forced colors -> opaque chrome.
// FM4 unsupported platform -> no translucency toggle; opaque chrome.
// FM5 disabling stops the 10 s native reduce-transparency poll.
// FM6 repeated toggles add no matchMedia listeners.
// FM7 the poll never runs off macOS.

const macUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const windowsUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

/** Alpha channel of a computed CSS color, 0 to 1. */
function alphaOf(color: string): number {
  const match = color.match(/^(?:rgba?|color)\((.*)\)$/);
  if (!match) return NaN;
  const parts = match[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 4) return 1;
  const raw = parts[3];
  return raw.endsWith("%") ? parseFloat(raw) / 100 : parseFloat(raw);
}

async function alphaFor(page: Page, selector: string): Promise<number> {
  const color = await page
    .locator(selector)
    .first()
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  return alphaOf(color);
}

async function openAppearance(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
}

async function setTranslucent(page: Page, on: boolean) {
  const box = page.getByLabel("Translucent window background");
  if (on) await box.check();
  else await box.uncheck();
  await expect(page.locator("html")).toHaveAttribute(
    "data-window-fx",
    on ? "vibrant" : "opaque",
  );
}

async function enableTranslucency(page: Page) {
  await openAppearance(page);
  await setTranslucent(page, true);
  await page.getByRole("button", { name: "Close settings" }).click();
}

test.describe("macOS native glass", () => {
  test.use({ userAgent: macUserAgent });
  test.beforeEach(async ({ page }) => installMockIpc(page));

  test("FM1 vibrant chrome is transparent while list, reader and body stay opaque", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto("/");
    await page.locator(".mail-shell").waitFor();
    await enableTranslucency(page);
    await expect(page.locator("html")).toHaveAttribute(
      "data-window-fx",
      "vibrant",
    );
    expect(await alphaFor(page, ".folder-pane")).toBe(0);
    expect(await alphaFor(page, ".message-pane")).toBe(1);
    await page.getByRole("option", { name: /Weekend plans/i }).click();
    expect(await alphaFor(page, ".message-body")).toBe(1);
    expect(await alphaFor(page, ".reader-pane")).toBe(1);
  });

  test("FM2 native reduced transparency keeps chrome opaque", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto("/?nativeReducedTransparency=1");
    await page.locator(".mail-shell").waitFor();
    await expect(page.locator("html")).toHaveAttribute(
      "data-reduce-transparency",
      "true",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-window-fx",
      "opaque",
    );
    expect(await alphaFor(page, ".folder-pane")).toBe(1);
  });

  test("FM3 forced colors keeps chrome opaque", async ({ page }) => {
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto("/");
    await page.locator(".mail-shell").waitFor();
    await enableTranslucency(page);
    await page.emulateMedia({ forcedColors: "active" });
    await expect(page.locator("html")).toHaveAttribute(
      "data-window-fx",
      "opaque",
    );
    expect(await alphaFor(page, ".folder-pane")).toBe(1);
    expect(await alphaFor(page, ".message-pane")).toBe(1);
  });

  test("FM4 unsupported native glass hides the toggle and stays opaque", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto("/?noWindowFx=1");
    await page.locator(".mail-shell").waitFor();
    await expect(page.locator("html")).toHaveAttribute(
      "data-window-fx",
      "opaque",
    );
    await openAppearance(page);
    await expect(
      page.getByRole("checkbox", { name: /Translucent window background/ }),
    ).toHaveCount(0);
    expect(await alphaFor(page, ".folder-pane")).toBe(1);
  });

  test("FM5 disabling translucency stops the native poll", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-11-07T10:00:00Z") });
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto("/");
    await page.locator(".mail-shell").waitFor();
    await enableTranslucency(page);
    await page.clock.pauseAt(new Date("2026-11-07T10:00:05Z"));
    await page.clock.runFor(25_000);
    const polled = (await ipcCommands(page)).filter(
      (command) => command === "accessibility_reduce_transparency",
    ).length;
    expect(polled).toBeGreaterThanOrEqual(2);

    await openAppearance(page);
    await setTranslucent(page, false);
    const baseline = (await ipcCommands(page)).filter(
      (command) => command === "accessibility_reduce_transparency",
    ).length;
    await page.clock.runFor(25_000);
    const after = (await ipcCommands(page)).filter(
      (command) => command === "accessibility_reduce_transparency",
    ).length;
    expect(after - baseline).toBe(0);
  });

  test("FM6 repeated toggles add no matchMedia listeners", async ({ page }) => {
    await page.addInitScript(() => {
      const live: Array<{
        mql: MediaQueryList;
        type: string;
        fn: unknown;
      }> = [];
      const counter = window as unknown as { __mqlLive: () => number };
      counter.__mqlLive = () => live.length;
      const add = MediaQueryList.prototype.addEventListener;
      const remove = MediaQueryList.prototype.removeEventListener;
      const same = (
        entry: { mql: MediaQueryList; type: string; fn: unknown },
        mql: MediaQueryList,
        type: string,
        fn: unknown,
      ) => entry.mql === mql && entry.type === type && entry.fn === fn;
      MediaQueryList.prototype.addEventListener = function (
        this: MediaQueryList,
        type: string,
        fn: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (fn && !live.some((entry) => same(entry, this, type, fn)))
          live.push({ mql: this, type, fn });
        return add.call(
          this,
          type,
          fn as EventListenerOrEventListenerObject,
          options,
        );
      };
      MediaQueryList.prototype.removeEventListener = function (
        this: MediaQueryList,
        type: string,
        fn: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
      ) {
        const index = live.findIndex((entry) => same(entry, this, type, fn));
        if (index >= 0) live.splice(index, 1);
        return remove.call(
          this,
          type,
          fn as EventListenerOrEventListenerObject,
          options,
        );
      };
    });
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto("/");
    await page.locator(".mail-shell").waitFor();
    await openAppearance(page);
    await setTranslucent(page, true);
    const live = () =>
      page.evaluate(() =>
        (window as unknown as { __mqlLive: () => number }).__mqlLive(),
      );
    const baseline = await live();
    for (let i = 0; i < 5; i += 1) {
      await setTranslucent(page, false);
      await setTranslucent(page, true);
    }
    expect(await live()).toBe(baseline);
  });
});

test.describe("non-macOS native glass", () => {
  test.use({ userAgent: windowsUserAgent });
  test.beforeEach(async ({ page }) => installMockIpc(page));

  test("FM7 the reduce-transparency poll never runs off macOS", async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-11-07T10:00:00Z") });
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto("/");
    await page.locator(".mail-shell").waitFor();
    await enableTranslucency(page);
    await page.clock.pauseAt(new Date("2026-11-07T10:00:05Z"));
    const count = async () =>
      (await ipcCommands(page)).filter(
        (command) => command === "accessibility_reduce_transparency",
      ).length;
    const baseline = await count();
    await page.clock.runFor(25_000);
    expect((await count()) - baseline).toBe(0);
  });
});
