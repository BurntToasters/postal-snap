import type { Page } from "@playwright/test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Exercise the handler shipped by the locked Tauri dependency, not a JS copy
// that could keep passing after native behavior changes. Cargo fetch supplies it.
function nativeDragScript(platform: string) {
  const lock = readFileSync("src-tauri/Cargo.lock", "utf8");
  const version = lock.match(/name = "tauri"\nversion = "([^"]+)"/)?.[1];
  const registry = join(
    process.env.CARGO_HOME ?? join(homedir(), ".cargo"),
    "registry/src",
  );
  const script = readdirSync(registry)
    .map((index) =>
      join(registry, index, `tauri-${version}`, "src/window/scripts/drag.js"),
    )
    .find(existsSync);
  if (!script)
    throw new Error(
      "Run cargo fetch --locked --manifest-path src-tauri/Cargo.toml before window bridge tests.",
    );
  return readFileSync(script, "utf8").replace(
    "__TEMPLATE_os_name__",
    JSON.stringify(platform),
  );
}

type WindowFixture = {
  windowCommands: string[];
  snapBounds: Array<{ x: number; y: number; width: number; height: number }>;
  maximized: boolean;
  fullscreen: boolean;
  failWindowAction: boolean;
  savedSettings: unknown[];
};

async function windowState(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __POSTAL_SNAP_TEST__: WindowFixture })
        .__POSTAL_SNAP_TEST__,
  );
}

const platforms = {
  macos: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

for (const [platform, userAgent] of Object.entries(platforms)) {
  test.describe(`${platform} window chrome`, () => {
    test.use({ userAgent });
    test.beforeEach(async ({ page }) => {
      await installMockIpc(page);
      await page.addInitScript({ content: nativeDragScript(platform) });
    });

    test("routes drag and double click through Tauri; excludes interactive children", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1240, height: 820 });
      await page.goto("/");
      await expect(page.locator(".account-select-label")).toHaveCount(0);
      const toolbar = page.locator(".app-toolbar");
      await toolbar.waitFor();
      await toolbar.dispatchEvent("mousedown", { button: 0, detail: 1 });
      await page
        .locator(".toolbar-flex-spacer")
        .dispatchEvent("mousedown", { button: 0, detail: 1 });
      await page
        .locator(".sidebar-titlebar-drag")
        .dispatchEvent("mousedown", { button: 0, detail: 1 });
      expect((await windowState(page)).windowCommands).toEqual([
        "start_dragging",
        "start_dragging",
        "start_dragging",
      ]);

      await toolbar.dispatchEvent("mousedown", {
        button: 0,
        detail: 2,
        clientX: 400,
        clientY: 10,
      });
      if (platform === "macos") {
        expect((await windowState(page)).maximized).toBe(false);
        await toolbar.dispatchEvent("mouseup", {
          button: 0,
          detail: 2,
          clientX: 400,
          clientY: 10,
        });
      }
      expect((await windowState(page)).windowCommands.at(-1)).toBe(
        "internal_toggle_maximize",
      );
      const count = (await windowState(page)).windowCommands.length;
      for (const selector of [
        ".get-mail-button span",
        ".compose-button svg",
        ".search-box",
        ".search-box input",
        ".search-scope",
        ".settings-button svg",
      ]) {
        await page
          .locator(selector)
          .dispatchEvent("mousedown", { button: 0, detail: 1 });
        await page
          .locator(selector)
          .dispatchEvent("mousedown", { button: 0, detail: 2 });
        await page
          .locator(selector)
          .dispatchEvent("mouseup", { button: 0, detail: 2 });
      }
      await toolbar.dispatchEvent("mousedown", { button: 2, detail: 1 });
      expect((await windowState(page)).windowCommands).toHaveLength(count);
      await page.getByRole("searchbox").fill("weekend");
      await expect(page.getByRole("searchbox")).toHaveValue("weekend");
      if (platform === "windows") {
        await expect
          .poll(async () => (await windowState(page)).snapBounds.at(-1))
          .toMatchObject({ width: 46, height: 44 });
        await page.evaluate(async () => {
          await (
            window as unknown as {
              __TAURI_INTERNALS__: {
                invoke: (
                  command: string,
                  args: Record<string, unknown>,
                ) => Promise<unknown>;
              };
            }
          ).__TAURI_INTERNALS__.invoke("plugin:event|emit", {
            event: "snap-max-hover",
            payload: true,
          });
        });
        await expect(page.locator("#maximize-window-button")).toHaveClass(
          /snap-hover/,
        );
      } else {
        expect((await windowState(page)).snapBounds).toEqual([]);
      }
    });

    test("mailbox menu supports keyboard opening and restores focus", async ({
      page,
    }) => {
      await page.goto("/");
      const trigger = page.getByRole("button", {
        name: "More mailbox actions",
      });
      await trigger.focus();
      await page.keyboard.press("ArrowDown");
      await expect(
        page.getByRole("menuitem", { name: "Mark all read" }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await expect(page.getByRole("menu")).toHaveCount(0);
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("menuitem", { name: "Mark all read" }),
      ).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("menu")).toHaveCount(0);
    });

    test("reader menu supports directional keys and restores focus", async ({
      page,
    }) => {
      await page.goto("/");
      await page.getByRole("option", { name: /Weekend plans/ }).click();
      const trigger = page.getByRole("button", { name: "More actions" });
      await trigger.focus();
      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("menuitem", { name: "Print" })).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(
        page.getByRole("menuitem", { name: "Mark unread" }),
      ).toBeFocused();
      await page.keyboard.press("End");
      await expect(
        page.getByRole("combobox", { name: "Move to folder" }),
      ).toBeFocused();
      await page.keyboard.press("Home");
      await expect(page.getByRole("menuitem", { name: "Print" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await expect(
        page.getByRole("menu", { name: "More actions" }),
      ).toHaveCount(0);
    });

    test("keeps captions clear and a drag surface reachable in setup and dialogs", async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 620, height: 540 });
      await page.goto("/?firstRun=1");
      await expect(page.locator(".setup-host")).toBeVisible();
      await expect(page.locator(".window-drag-strip")).toBeVisible();
      await page.mouse.click(220, 20);
      expect((await windowState(page)).windowCommands).toContain(
        "start_dragging",
      );

      await page.goto("/");
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(page.getByRole("tablist")).toHaveAttribute(
        "aria-orientation",
        "horizontal",
      );
      await page.getByRole("tab", { name: "General" }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("tab", { name: "Reading" })).toBeFocused();
      await expect(page.locator(".settings-window")).toBeVisible();
      expect(
        (await page.locator(".settings-window").boundingBox())!.y,
      ).toBeGreaterThanOrEqual(44);
      await page.mouse.click(220, 20);
      expect((await windowState(page)).windowCommands).toContain(
        "start_dragging",
      );
      await expect(page.locator(".global-window-caption-controls")).toBeVisible(
        { visible: platform === "windows" },
      );
      if (platform === "windows") {
        const caption = page.getByRole("group", { name: "Window controls" });
        await caption
          .getByRole("button", { name: "Minimize", exact: true })
          .click();
        expect((await windowState(page)).windowCommands.at(-1)).toBe(
          "minimize",
        );
        await caption
          .getByRole("button", { name: "Maximize", exact: true })
          .click();
        await expect(
          caption.getByRole("button", { name: "Restore", exact: true }),
        ).toBeVisible();
        await caption
          .getByRole("button", { name: "Restore", exact: true })
          .click();
        await caption
          .getByRole("button", { name: "Close", exact: true })
          .focus();
        await page.keyboard.press("Tab");
        await expect(page.locator(".settings-window :focus")).toHaveCount(1);
        await page.keyboard.press("Shift+Tab");
        await expect(
          caption.getByRole("button", { name: "Close", exact: true }),
        ).toBeFocused();
      }
      await page
        .locator(".settings-window")
        .getByRole("button", { name: "Close settings" })
        .click();
      await expect(
        page.getByRole("button", { name: "Settings", exact: true }),
      ).toBeFocused();
      await expect(page.locator("html")).not.toHaveAttribute(
        "data-overlay-chrome",
        "true",
      );
      await expect(page.locator(".window-drag-strip")).toBeHidden();
      await page.getByRole("button", { name: "Compose", exact: true }).click();
      await page
        .locator(".composer-window")
        .getByRole("button", { name: "Maximize editor", exact: true })
        .click();
      expect(
        (await page.locator(".composer-window").boundingBox())!.y,
      ).toBeGreaterThanOrEqual(44);
      const body = await page.locator(".composer-window").boundingBox();
      expect(body!.y + body!.height).toBeLessThanOrEqual(541);
      await page.screenshot({
        animations: "disabled",
        path: testInfo.outputPath(`${platform}-composer.png`),
      });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "32px";
      });
      await page.locator(".composer-editor").scrollIntoViewIfNeeded();
      await expect(page.locator(".composer-editor")).toBeInViewport();
      await page.locator(".composer-window footer").scrollIntoViewIfNeeded();
      await expect(page.locator(".composer-window footer")).toBeInViewport();
      await page.screenshot({
        animations: "disabled",
        path: testInfo.outputPath(`${platform}-composer-200.png`),
      });
    });

    test("setup remains readable and actionable at 200% text", async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 620, height: 540 });
      await page.goto("/?firstRun=1&scale=2&theme=dark");
      const setup = page.locator(".setup-page");
      await expect(setup).toBeVisible();
      await setup.evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({
        animations: "disabled",
        path: testInfo.outputPath(`${platform}-setup-top-200.png`),
      });
      await page
        .getByRole("button", { name: "Continue", exact: true })
        .scrollIntoViewIfNeeded();
      await expect(
        page.getByRole("button", { name: "Continue", exact: true }),
      ).toBeInViewport();
      expect(
        await setup.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ).toBe(true);
      await page.screenshot({
        animations: "disabled",
        path: testInfo.outputPath(`${platform}-setup-200.png`),
      });
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(page.locator(".setup-host")).toHaveJSProperty(
        "scrollTop",
        0,
      );
      await page.getByRole("button", { name: /iCloud Mail/i }).click();
      await expect(page.locator(".setup-host")).toHaveJSProperty(
        "scrollTop",
        0,
      );
      await page.screenshot({
        animations: "disabled",
        path: testInfo.outputPath(`${platform}-setup-form-top-200.png`),
      });
      const connect = page.getByRole("button", { name: "Connect securely" });
      await connect.scrollIntoViewIfNeeded();
      await expect(connect).toBeInViewport();
      await expect(
        page.getByRole("button", { name: "Back", exact: true }),
      ).toBeVisible();
      expect(
        await setup.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ).toBe(true);
      await page.screenshot({
        animations: "disabled",
        path: testInfo.outputPath(`${platform}-setup-form-200.png`),
      });
      expect(
        (await new AxeBuilder({ page }).include(".setup-page").analyze())
          .violations,
      ).toEqual([]);
    });

    for (const pane of ["right", "bottom", "hidden"]) {
      test(`${pane} pane survives grow/shrink, saved sizes, hidden sidebar and 200% text`, async ({
        page,
      }, testInfo) => {
        await page.goto(
          `/?pane=${pane}&oversized=1&tallBottom=1&hiddenSidebar=1`,
        );
        await page.locator(".mail-shell").waitFor();
        for (const scale of [1, 2, 1]) {
          await page.evaluate((value) => {
            document.documentElement.style.fontSize = `${16 * value}px`;
          }, scale);
          for (const viewport of [
            { width: 1875, height: 1400 },
            { width: 1240, height: 820 },
            { width: 900, height: 720 },
            { width: 620, height: 540 },
            { width: 1875, height: 1400 },
          ]) {
            await page.setViewportSize(viewport);
            await expect
              .poll(() =>
                page.evaluate(() => {
                  const shell =
                    document.querySelector<HTMLElement>(".mail-shell")!;
                  const toolbar =
                    document.querySelector<HTMLElement>(".app-toolbar")!;
                  const messages =
                    document.querySelector<HTMLElement>(".message-pane")!;
                  const reader =
                    document.querySelector<HTMLElement>(".reader-pane")!;
                  const bottom = Math.max(
                    messages.getBoundingClientRect().bottom,
                    reader.checkVisibility()
                      ? reader.getBoundingClientRect().bottom
                      : 0,
                  );
                  return (
                    Math.abs(bottom - innerHeight) <= 1 &&
                    shell.scrollWidth <= innerWidth + 1 &&
                    Math.abs(
                      messages.getBoundingClientRect().top -
                        toolbar.getBoundingClientRect().bottom,
                    ) <= 1
                  );
                }),
              )
              .toBe(true);
            for (const selector of [
              ".get-mail-button span",
              ".compose-button span",
              ".search-box input",
              ".settings-button",
            ]) {
              await expect(page.locator(selector)).toBeVisible();
              const bounds = (await page.locator(selector).boundingBox())!;
              expect(bounds.x).toBeGreaterThanOrEqual(0);
              expect(bounds.x + bounds.width).toBeLessThanOrEqual(
                viewport.width + 1,
              );
            }
          }
        }
        for (const settings of (await windowState(page)).savedSettings) {
          expect(settings).toMatchObject({
            folderPaneWidth: 400,
            messagePaneWidth: 720,
            readerPaneHeight: 800,
            sidebarVisible: false,
          });
        }
        expect(
          (await page.locator(".app-toolbar").boundingBox())!.height,
        ).toBeLessThan(100);
        await page.setViewportSize({ width: 620, height: 540 });
        await page.getByRole("button", { name: "Show mailboxes" }).click();
        await expect(page.locator(".folder-pane")).toBeVisible();
        await page
          .getByRole("button", { name: "Close mailboxes", exact: true })
          .last()
          .click();
        for (const settings of (await windowState(page)).savedSettings) {
          expect(settings).toMatchObject({
            folderPaneWidth: 400,
            messagePaneWidth: 720,
            readerPaneHeight: 800,
            sidebarVisible: false,
          });
        }
        await page.setViewportSize({ width: 1240, height: 820 });
        await page.screenshot({
          animations: "disabled",
          path: testInfo.outputPath(`${platform}-${pane}.png`),
        });
      });
    }

    test("populated readers, empty mailboxes and print retain reachable content", async ({
      page,
    }, testInfo) => {
      for (const pane of ["right", "bottom", "hidden"]) {
        await page.setViewportSize({ width: 1240, height: 820 });
        await page.goto(`/?pane=${pane}&theme=dark`);
        await page.getByRole("option", { name: /Weekend plans/ }).click();
        await expect(page.locator(".message-body")).toBeVisible();
        await page.screenshot({
          animations: "disabled",
          path: testInfo.outputPath(`${platform}-${pane}-populated.png`),
        });
        await page.setViewportSize({ width: 620, height: 540 });
        await page.evaluate(() => {
          document.documentElement.style.fontSize = "32px";
        });
        const body = page.locator(".message-body");
        await body.scrollIntoViewIfNeeded();
        await expect(body).toBeInViewport();
        expect((await body.boundingBox())!.height).toBeGreaterThanOrEqual(179);
        await page.screenshot({
          animations: "disabled",
          path: testInfo.outputPath(`${platform}-${pane}-reader-200.png`),
        });
        await page
          .getByRole("button", { name: "Back to message list", exact: true })
          .click();
        await expect(page.locator(".message-body")).toHaveCount(0);
        await page.goto(`/?pane=${pane}&empty=1`);
        await expect(page.locator(".message-row")).toHaveCount(0);
      }
      await page.setViewportSize({ width: 1240, height: 820 });
      await page.goto("/?pane=hidden");
      await page.getByRole("option", { name: /Weekend plans/ }).click();
      await expect(page.locator(".message-body")).toBeVisible();
      await page.emulateMedia({ media: "print" });
      await expect(page.locator(".window-chrome")).toBeHidden();
      await expect(page.locator(".reader-pane")).toHaveCSS(
        "position",
        "static",
      );
      await expect(page.locator(".app-viewport")).toHaveCSS(
        "overflow",
        "visible",
      );
    });

    test("light/dark settings at 200% retain reachable content and keyboard contrast", async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 620, height: 540 });
      for (const theme of ["light", "dark"]) {
        await page.goto(`/?theme=${theme}&scale=2`);
        await page
          .getByRole("button", { name: "Settings", exact: true })
          .click();
        const content = page.locator(".settings-content");
        await expect(content).toBeVisible();
        const bounds = (await content.boundingBox())!;
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(541);
        await content.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await page.screenshot({
          animations: "disabled",
          path: testInfo.outputPath(`${platform}-${theme}-settings-200.png`),
        });
        expect(
          (await new AxeBuilder({ page }).include(".settings-window").analyze())
            .violations,
        ).toEqual([]);
      }
      await page.emulateMedia({
        forcedColors: "active",
        reducedMotion: "reduce",
      });
      await expect(page.locator(".settings-window")).toHaveCSS(
        "transition-duration",
        "0s",
      );
    });
  });
}

test.describe("whole-app responsive UI", () => {
  test.use({ userAgent: platforms.windows });

  test("keeps every settings destination reachable without horizontal clipping", async ({
    page,
  }) => {
    await installMockIpc(page);
    await page.setViewportSize({ width: 620, height: 540 });
    await page.goto("/?scale=2");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const names = [
      "General",
      "Reading",
      "Notifications",
      "Storage",
      "Accounts",
      "Shortcuts",
      "Updates",
      "Advanced",
      "About",
    ];
    for (const name of names) {
      const tab = page.getByRole("tab", { name });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tabpanel", { name })).toBeVisible();
      expect(
        await page
          .locator(".settings-window")
          .evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
      ).toBe(true);
      expect(
        await page
          .locator(".settings-content")
          .evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
      ).toBe(true);
    }
  });
});

test.describe("Windows Store caption lifecycle", () => {
  test.use({ userAgent: platforms.windows });
  test("uses close (not destroy), restores fullscreen and reports native failures", async ({
    page,
  }) => {
    await installMockIpc(page, "store");
    await page.goto("/");
    const caption = page.getByRole("group", { name: "Window controls" });
    await caption.getByRole("button", { name: "Close", exact: true }).click();
    expect((await windowState(page)).windowCommands).toEqual(["close"]);
    await page.evaluate(() => {
      (
        window as unknown as { __POSTAL_SNAP_TEST__: WindowFixture }
      ).__POSTAL_SNAP_TEST__.fullscreen = true;
    });
    await caption
      .getByRole("button", { name: "Maximize", exact: true })
      .click();
    expect((await windowState(page)).windowCommands.at(-1)).toBe(
      "set_fullscreen",
    );
    expect((await windowState(page)).fullscreen).toBe(false);
    await page.evaluate(() => {
      (
        window as unknown as { __POSTAL_SNAP_TEST__: WindowFixture }
      ).__POSTAL_SNAP_TEST__.failWindowAction = true;
    });
    await caption
      .getByRole("button", { name: "Minimize", exact: true })
      .click();
    await expect(page.getByRole("alert")).toHaveText(
      /The window action could not finish/,
    );
  });
});
