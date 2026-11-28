import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifactsAfterEach, emitTauriEvent } from "./ipc";

const macUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

test.afterEach(attachArtifactsAfterEach);
test.beforeEach(async ({ page }) => installMockIpc(page));

test.describe("D1 macOS traffic light clearance in drawer band", () => {
  test.use({ userAgent: macUserAgent });

  test("app-toolbar clears traffic lights at 820px across all densities and 200% scale", async ({
    page,
  }) => {
    for (const combo of [
      { density: "normal", scale: 1 },
      { density: "comfortable", scale: 2 },
      { density: "compact", scale: 2 },
    ]) {
      await page.setViewportSize({ width: 820, height: 800 });
      await page.goto(`/?density=${combo.density}&scale=${combo.scale}`);
      await expect(page.locator(".app-toolbar")).toBeVisible();
      const geometry = await page.evaluate(() => {
        const toolbar = document.querySelector<HTMLElement>(".app-toolbar")!;
        const toggle = toolbar.querySelector<HTMLElement>(".sidebar-toggle")!;
        const padLeft = Number.parseFloat(
          getComputedStyle(toolbar).paddingLeft,
        );
        const toggleRect = toggle.getBoundingClientRect();
        return {
          platform: document.documentElement.dataset.platform,
          padLeft,
          toggleLeft: toggleRect.left,
        };
      });
      expect(geometry.platform).toBe("macos");
      expect(geometry.padLeft).toBeGreaterThanOrEqual(72);
      expect(geometry.toggleLeft).toBeGreaterThanOrEqual(70);
    }
  });
});

test("D2 & D3 Modal focus restoration and central inert stack isolation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/?localMail=1&outboxPreview=1");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "About", exact: true }).click();
  const creditsBtn = page.getByRole("button", {
    name: "Licenses and credits",
    exact: true,
  });
  await creditsBtn.focus();
  await creditsBtn.click();
  await expect(
    page.getByRole("dialog", { name: "Licenses and credits" }),
  ).toBeVisible();

  const stackedInert = await page.evaluate(() => ({
    viewport: document.querySelector(".app-viewport")?.hasAttribute("inert"),
    settingsLayer: document
      .querySelector(".settings-layer")
      ?.hasAttribute("inert"),
  }));
  expect(stackedInert.viewport).toBe(true);
  expect(stackedInert.settingsLayer).toBe(true);
  const topTrap = await page.evaluate(() => {
    const active = document.activeElement;
    const trap =
      active instanceof Element
        ? active.closest<HTMLElement>("[data-dialog-focus-trap]")
        : null;
    return {
      focusedInsideCredits: Boolean(
        document.querySelector(".license-credits-dialog")?.contains(active),
      ),
      activeTrapLabel: trap?.getAttribute("aria-labelledby"),
    };
  });
  expect(topTrap.focusedInsideCredits).toBe(true);
  expect(topTrap.activeTrapLabel).toBe("license-credits-title");

  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Licenses and credits" }),
  ).toHaveCount(0);
  await expect(creditsBtn).toBeFocused();
  expect(
    await page.evaluate(() =>
      document.querySelector(".settings-layer")?.hasAttribute("inert"),
    ),
  ).toBe(false);

  await page.getByRole("button", { name: "Close settings" }).click();

  await page.getByRole("button", { name: "Compose" }).click();
  await expect(page.getByRole("dialog", { name: "New message" })).toBeVisible();
  expect(
    await page.evaluate(() =>
      document.querySelector(".app-viewport")?.hasAttribute("inert"),
    ),
  ).toBe(true);
  const composer = page.getByRole("dialog", { name: "New message" });
  const messageOptions = composer.getByRole("button", {
    name: "Message options",
  });
  await messageOptions.click();
  const optionsMenu = composer.getByRole("menu", { name: "Message options" });
  await expect(optionsMenu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(optionsMenu).toHaveCount(0);
  await expect(composer).toBeVisible();
  await expect(messageOptions).toBeFocused();
  await emitTauriEvent(page, "shortcut-help", null).catch(() => undefined);
  await page.keyboard.press("Escape");
  await expect(composer).toHaveCount(0);

  await page.setViewportSize({ width: 700, height: 800 });
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .first()
    .click();
  await expect(page.locator("#reader-pane[aria-modal='true']")).toBeVisible();
  const overlayInert = await page.evaluate(() => ({
    toolbar: document.querySelector(".app-toolbar")?.hasAttribute("inert"),
    messages: document.querySelector(".message-pane")?.hasAttribute("inert"),
  }));
  expect(overlayInert.toolbar).toBe(true);
  expect(overlayInert.messages).toBe(true);
});

test("D2 visible top dialog owns focus before deferred focus timers", async ({
  page,
}) => {
  await page.addInitScript(() => {
    type TestWindow = Window & { __pendingDialogFocus?: Array<() => void> };
    const testWindow = window as TestWindow;
    testWindow.__pendingDialogFocus = [];
    const nativeTimeout = window.setTimeout.bind(window);
    const patchedTimeout = (...args: Parameters<typeof window.setTimeout>) => {
      const [handler, delay, ...handlerArgs] = args;
      const stack = new Error().stack ?? "";
      if (
        delay === 0 &&
        stack.includes("useDialogFocus") &&
        typeof handler === "function"
      ) {
        testWindow.__pendingDialogFocus?.push(() => handler(...handlerArgs));
        return 0;
      }
      return nativeTimeout(...args);
    };
    window.setTimeout = patchedTimeout as typeof window.setTimeout;
  });
  await page.setViewportSize({ width: 1200, height: 820 });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "About", exact: true }).click();
  const opener = page.getByRole("button", {
    name: "Licenses and credits",
    exact: true,
  });
  await opener.focus();
  await opener.click();
  const credits = page.getByRole("dialog", { name: "Licenses and credits" });
  await expect(credits).toBeVisible();
  await expect(page.locator(".settings-layer")).toHaveAttribute("inert", "");

  const focusState = await page.evaluate(() => {
    const active = document.activeElement;
    const trap =
      active instanceof Element
        ? active.closest<HTMLElement>("[data-dialog-focus-trap]")
        : null;
    const testWindow = window as Window & {
      __pendingDialogFocus?: Array<() => void>;
    };
    return {
      focusedInsideCredits: Boolean(
        document.querySelector(".license-credits-dialog")?.contains(active),
      ),
      activeTrapLabel: trap?.getAttribute("aria-labelledby"),
      pendingFocusTimers: testWindow.__pendingDialogFocus?.length ?? 0,
    };
  });
  expect(focusState.focusedInsideCredits).toBe(true);
  expect(focusState.activeTrapLabel).toBe("license-credits-title");
  expect(focusState.pendingFocusTimers).toBe(0);

  await page.keyboard.press("Escape");
  await expect(credits).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test.describe("D4, D5 & D7 Vibrancy generation guard, warnings/settings contrast, and a11y override", () => {
  test.use({ userAgent: macUserAgent });

  test("D4 syncWorkspaceWindowFx ignores stale slow native resolution", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const mock = window.__POSTAL_SNAP_MOCK__ as {
        handlers: Record<string, (args: Record<string, unknown>) => unknown>;
      };
      const baseSet = mock.handlers.set_workspace_window_fx;
      let calls = 0;
      mock.handlers.set_workspace_window_fx = async (args) => {
        calls += 1;
        if (args.enabled === true && calls >= 1) {
          await new Promise((resolve) => setTimeout(resolve, 260));
        }
        return baseSet(args);
      };
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    const toggle = page.getByLabel("Translucent window background");
    await toggle.check();
    await page.waitForTimeout(40);
    await toggle.uncheck();
    await page.waitForTimeout(320);
    await expect(page.locator("html")).toHaveAttribute(
      "data-window-fx",
      "opaque",
    );
  });

  test("D5 & D7 Vibrant mode preserves warning banner tint, settings group contrast, and reduced-transparency sidebar", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/?trashThread=1");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    await page.getByLabel("Translucent window background").check();
    await expect(page.locator("html")).toHaveAttribute(
      "data-window-fx",
      "vibrant",
    );

    const settingsBg = await page.evaluate(() => ({
      content: getComputedStyle(document.querySelector(".settings-content")!)
        .backgroundColor,
      group: getComputedStyle(document.querySelector(".settings-group")!)
        .backgroundColor,
    }));
    expect(settingsBg.content).not.toBe(settingsBg.group);

    await page.getByRole("button", { name: "Close settings" }).click();
    await page.getByRole("button", { name: "Trash", exact: true }).click();
    await page.locator('[role="treeitem"], [role="option"]').first().click();
    await expect(page.locator(".remote-content-banner.warning")).toBeVisible();
    const bannerColors = await page.evaluate(() => ({
      warning: getComputedStyle(
        document.querySelector(".remote-content-banner.warning")!,
      ).backgroundColor,
      bar: getComputedStyle(document.querySelector(".app-toolbar")!)
        .backgroundColor,
    }));
    expect(bannerColors.warning).not.toBe(bannerColors.bar);

    await page.evaluate(() => {
      document.documentElement.dataset.windowFx = "vibrant";
    });
    await page.emulateMedia({ contrast: "more" });
    await page.evaluate(() => {
      document.documentElement.dataset.windowFx = "vibrant";
    });
    const sidebarVibrantFallback = await page.evaluate(() => ({
      sidebar: getComputedStyle(document.querySelector(".folder-pane")!)
        .backgroundColor,
      surface: getComputedStyle(document.documentElement)
        .getPropertyValue("--surface")
        .trim(),
      sidebarToken: getComputedStyle(document.documentElement)
        .getPropertyValue("--sidebar-bg")
        .trim(),
    }));
    const [sidebarHex, surfaceColor] = await page.evaluate(() => {
      const el = document.createElement("div");
      el.style.backgroundColor = "var(--surface)";
      document.body.appendChild(el);
      const sBg = getComputedStyle(el).backgroundColor;
      el.remove();
      return [
        getComputedStyle(document.querySelector(".folder-pane")!)
          .backgroundColor,
        sBg,
      ];
    });
    expect(sidebarVibrantFallback.sidebar).toBe(sidebarHex);
    expect(sidebarHex).not.toBe(surfaceColor);
  });
});

test("D6 accountsTab avoids button inside button and notificationsTab falls back to email", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as {
      handlers: Record<string, (args: Record<string, unknown>) => unknown>;
    };
    const baseList = mock.handlers.list_accounts;
    mock.handlers.list_accounts = (args) => {
      const list = baseList(args) as Array<Record<string, unknown>>;
      if (list[1]) list[1].displayName = "";
      return list;
    };
  });

  await page.goto("/?multiAccount=1&authError=1");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  const nestedCount = await page.evaluate(
    () =>
      document.querySelectorAll(
        "button.account-overview-row button, button.account-overview-row [role='status']",
      ).length,
  );
  expect(nestedCount).toBe(0);

  await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  await expect(
    page.getByRole("checkbox", {
      name: "Notify for new mail: reader@fastmail.com",
    }),
  ).toBeVisible();
});

// Failure cases: stale toolbar state, lost toolbar handoff/return selections,
// wrong pointer caret restoration, and formatting applied to the wrong text.
test("D8 Toolbar and radiogroup roving Arrow navigation preserves native select arrows", async ({
  page,
}) => {
  await page.addInitScript(() => {
    type TestWindow = Window & {
      __holdComposerSelectionChanges?: boolean;
      __heldComposerSelectionChanges?: number;
      __releaseComposerSelectionChanges?: () => number;
    };
    const testWindow = window as TestWindow;
    testWindow.__holdComposerSelectionChanges = false;
    testWindow.__heldComposerSelectionChanges = 0;
    window.addEventListener(
      "selectionchange",
      (event) => {
        if (!testWindow.__holdComposerSelectionChanges) return;
        testWindow.__heldComposerSelectionChanges =
          (testWindow.__heldComposerSelectionChanges ?? 0) + 1;
        event.stopImmediatePropagation();
      },
      true,
    );
    testWindow.__releaseComposerSelectionChanges = () => {
      testWindow.__holdComposerSelectionChanges = false;
      const held = testWindow.__heldComposerSelectionChanges ?? 0;
      if (held > 0) document.dispatchEvent(new Event("selectionchange"));
      return held;
    };
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .first()
    .click();
  const bulkToolbar = page.getByRole("toolbar", { name: /selected/i });
  await expect(bulkToolbar).toBeVisible();
  const bulkArchive = bulkToolbar.getByRole("button", { name: /Archive/i });
  await bulkArchive.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    bulkToolbar.getByRole("button", { name: /Trash|Delete/i }),
  ).toBeFocused();
  expect(
    await bulkToolbar.evaluate(
      (el) => el.querySelectorAll("[tabindex='0']").length,
    ),
  ).toBe(1);

  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  await page.getByRole("button", { name: /^Manage Sam\b/ }).click();
  await page.getByRole("button", { name: "Identity", exact: true }).click();

  const colorGroup = page.locator(".account-color-picker[role='radiogroup']");
  const initialChecked = colorGroup.locator(
    "[role='radio'][aria-checked='true']",
  );
  const initialColor = await initialChecked.getAttribute("data-color");
  expect(initialColor).toBeTruthy();
  await initialChecked.focus();
  expect(
    await colorGroup.evaluate(
      (el) => el.querySelectorAll("[role='radio'][tabindex='0']").length,
    ),
  ).toBe(1);
  await page.keyboard.press("ArrowRight");
  const nextRadio = await page.evaluate(() =>
    document.activeElement?.getAttribute("role"),
  );
  expect(nextRadio).toBe("radio");
  await expect(
    colorGroup.locator(`[role='radio'][data-color='${initialColor}']`),
  ).toHaveAttribute("aria-checked", "false");

  const sigToolbar = page.locator(".signature-editor-toolbar[role='toolbar']");
  const boldBtn = sigToolbar.getByRole("button", { name: "Bold", exact: true });
  await boldBtn.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    sigToolbar.getByRole("button", { name: "Italic", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Close settings" }).click();

  await page.getByRole("button", { name: "Compose" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await composer
    .getByRole("button", { name: /Show formatting|Formatting/i })
    .click();
  const fontSelect = composer.getByRole("combobox", {
    name: "Font",
    exact: true,
  });
  const editor = composer.locator(".composer-editor");
  const boldButton = composer.getByRole("button", {
    name: "Bold",
    exact: true,
  });
  await editor.fill("Bold state");
  await editor.press("ControlOrMeta+A");
  await editor.press("ControlOrMeta+B");
  await expect(boldButton).toHaveAttribute("aria-pressed", "true");
  await expect(editor.locator("strong")).toHaveText("Bold state");
  await editor.press("ControlOrMeta+A");
  await editor.press("ControlOrMeta+B");
  await expect(boldButton).toHaveAttribute("aria-pressed", "false");
  await expect(editor.locator("strong")).toHaveCount(0);

  await editor.fill("Keyboard selection");
  await editor.press("ControlOrMeta+A");
  await fontSelect.focus();
  // Native ArrowRight can change a select on Linux; focus must stay native.
  await page.keyboard.press("ArrowRight");
  await expect(fontSelect).toBeFocused();
  // Typeahead chooses the same option across platforms where ArrowRight differs.
  await fontSelect.press("G");
  await expect(fontSelect).toHaveValue("Georgia");
  await expect(fontSelect).toBeFocused();
  const selectedFont = editor.locator("span[style*='font-family']");
  await expect(selectedFont).toHaveText("Keyboard selection");
  expect(
    await selectedFont.evaluate(
      (element) => (element as HTMLElement).style.fontFamily,
    ),
  ).toBe("Georgia");

  const caretAtEditorEnd = async (expectedText: string) =>
    editor.evaluate((node, text) => {
      const selection = window.getSelection();
      if (
        !selection?.isCollapsed ||
        !selection.anchorNode ||
        !node.contains(selection.anchorNode)
      ) {
        return false;
      }
      const prefix = document.createRange();
      prefix.selectNodeContents(node);
      prefix.setEnd(selection.anchorNode, selection.anchorOffset);
      return prefix.toString() === text;
    }, expectedText);
  await editor.focus();
  await editor.evaluate((node) => {
    const testWindow = window as Window & {
      __holdComposerSelectionChanges?: boolean;
      __heldComposerSelectionChanges?: number;
    };
    testWindow.__heldComposerSelectionChanges = 0;
    testWindow.__holdComposerSelectionChanges = true;
    const text = node.querySelector("span[style*='font-family']")?.firstChild;
    if (!(text instanceof Text)) throw new Error("Font text node is missing");
    window.getSelection()?.collapse(text, text.textContent?.length ?? 0);
  });
  expect(await caretAtEditorEnd("Keyboard selection")).toBe(true);

  const fontSizeSelect = composer.getByRole("combobox", {
    name: "Font size",
    exact: true,
  });
  await fontSizeSelect.focus();
  await page.keyboard.press("ArrowRight");
  await expect(fontSizeSelect).toBeFocused();
  await fontSizeSelect.press("L");
  await expect(fontSizeSelect).toHaveValue("20px");
  await expect(fontSizeSelect).toBeFocused();
  await editor.focus();
  await editor.pressSequentially("!");
  await expect(editor).toHaveText("Keyboard selection!");
  expect(await caretAtEditorEnd("Keyboard selection!")).toBe(true);
  const caretFontSize = editor.locator("span[style*='font-size']");
  await expect(caretFontSize).toHaveCount(1);
  await expect(caretFontSize).toHaveText("!");
  expect(
    await caretFontSize.evaluate(
      (element) => (element as HTMLElement).style.fontSize,
    ),
  ).toBe("20px");
  const heldSelectionChanges = await page.evaluate(() => {
    const testWindow = window as Window & {
      __releaseComposerSelectionChanges?: () => number;
    };
    return testWindow.__releaseComposerSelectionChanges?.() ?? 0;
  });
  expect(heldSelectionChanges).toBeGreaterThan(0);

  await editor.fill("Keep these words");
  await editor.press("ControlOrMeta+A");
  await composer
    .getByRole("button", { name: "More formatting", exact: true })
    .click();
  await composer
    .getByRole("button", { name: "Clear formatting", exact: true })
    .click();
  await editor.focus();
  await editor.evaluate((node) => {
    const testWindow = window as Window & {
      __holdComposerSelectionChanges?: boolean;
      __heldComposerSelectionChanges?: number;
    };
    testWindow.__heldComposerSelectionChanges = 0;
    testWindow.__holdComposerSelectionChanges = true;
    const text = node.querySelector("p")?.firstChild;
    if (!(text instanceof Text))
      throw new Error("Composer text node is missing");
    window.getSelection()?.collapse(text, text.textContent?.length ?? 0);
  });
  await fontSelect.focus();
  await expect(fontSelect).toBeFocused();
  await editor.focus();

  await page.evaluate(() => {
    const testWindow = window as Window & {
      __heldComposerSelectionChanges?: number;
    };
    testWindow.__heldComposerSelectionChanges = 0;
  });
  await editor.evaluate((node) => {
    const text = node.querySelector("p")?.firstChild;
    if (!(text instanceof Text))
      throw new Error("Composer text node is missing");
    const selection = window.getSelection();
    if (!selection) throw new Error("Native selection is missing");
    const end = text.textContent?.length ?? 0;
    selection.setBaseAndExtent(text, end, text, end - 5);
  });
  const readEditorSelection = async () =>
    editor.evaluate((node) => {
      const selection = window.getSelection();
      const anchorNode = selection?.anchorNode;
      const focusNode = selection?.focusNode;
      const insideEditor = Boolean(
        anchorNode &&
        focusNode &&
        node.contains(anchorNode) &&
        node.contains(focusNode),
      );
      let backwards = false;
      if (insideEditor && selection?.anchorNode && selection.focusNode) {
        const anchor = document.createRange();
        anchor.setStart(selection.anchorNode, selection.anchorOffset);
        anchor.collapse(true);
        const focus = document.createRange();
        focus.setStart(selection.focusNode, selection.focusOffset);
        focus.collapse(true);
        backwards =
          !selection.isCollapsed &&
          anchor.compareBoundaryPoints(Range.START_TO_START, focus) > 0;
      }
      return {
        text: selection?.toString() ?? "",
        backwards,
        insideEditor,
      };
    });
  expect(await readEditorSelection()).toEqual({
    text: "words",
    backwards: true,
    insideEditor: true,
  });

  await fontSelect.focus();
  await expect(fontSelect).toBeFocused();
  await fontSelect.press("G");
  await expect(fontSelect).toHaveValue("Georgia");
  await expect(fontSelect).toBeFocused();
  await expect(editor).toHaveText("Keep these words");
  const selectedWord = editor.locator("span[style*='font-family']");
  await expect(selectedWord).toHaveCount(1);
  await expect(selectedWord).toHaveText("words");
  expect(
    await selectedWord.evaluate(
      (element) => (element as HTMLElement).style.fontFamily,
    ),
  ).toBe("Georgia");
  await editor.focus();
  await expect.poll(readEditorSelection).toEqual({
    text: "words",
    backwards: true,
    insideEditor: true,
  });
  await editor.pressSequentially("X");
  await expect(editor).toHaveText("Keep these X");
  const heldRangeSelectionChanges = await page.evaluate(() => {
    const testWindow = window as Window & {
      __releaseComposerSelectionChanges?: () => number;
    };
    return testWindow.__releaseComposerSelectionChanges?.() ?? 0;
  });
  expect(heldRangeSelectionChanges).toBeGreaterThan(0);

  const firstCharacterPoint = await editor.evaluate((node) => {
    const text = node.querySelector("p")?.firstChild;
    if (!(text instanceof Text))
      throw new Error("Composer text node is missing");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + 1, y: rect.top + rect.height / 2 };
  });
  await fontSelect.focus();
  await page.mouse.click(firstCharacterPoint.x, firstCharacterPoint.y);
  await page.keyboard.type("Y");
  await expect(editor).toHaveText("YKeep these X");
});

test("D9 & D10 ContextMenu restores focus from child span/svg and renders block scroll fade", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 180 });
  await page.goto("/");

  const rowSubject = page
    .getByRole("option", { name: /Weekend plans/i })
    .first()
    .locator(".message-subject");
  await rowSubject.click({ button: "right" });
  const menu = page.locator(".context-menu");
  await expect(menu).toBeVisible();
  const scrollCue = await menu.evaluate((el) => {
    const after = getComputedStyle(el, "::after");
    return {
      cue: el.getAttribute("data-scroll-cue"),
      display: after.display,
      height: Number.parseFloat(after.height),
    };
  });
  expect(scrollCue.cue).toBe("more");
  expect(scrollCue.display).toBe("block");
  expect(scrollCue.height).toBeGreaterThan(0);

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }).first(),
  ).toBeFocused();
});

test("D11 OutboxPreviewDialog renders close icon instead of clipped text", async ({
  page,
}) => {
  await page.goto("/?localMail=1&outboxPreview=1");
  await page.getByRole("button", { name: /^Outbox/ }).click();
  await page
    .getByRole("region", { name: "Outbox" })
    .getByRole("button", { name: "Open", exact: true })
    .first()
    .click();
  const previewDialog = page.locator(".attachment-preview-dialog");
  await expect(previewDialog).toBeVisible();
  const closeBtn = previewDialog.locator("header button.icon-button");
  const info = await closeBtn.evaluate((btn) => ({
    text: btn.textContent?.trim() ?? "",
    hasSvg: Boolean(btn.querySelector("svg")),
    scrollWidth: btn.scrollWidth,
    clientWidth: btn.clientWidth,
  }));
  expect(info.hasSvg).toBe(true);
  expect(info.text).toBe("");
  expect(info.scrollWidth).toBeLessThanOrEqual(info.clientWidth + 2);
});

test("D12 Composer toolbar buttons and color-control scale cleanly at 200% text in all densities", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const density of ["normal", "comfortable", "compact"] as const) {
    await page.goto(`/?density=${density}&scale=2`);
    await page.getByRole("button", { name: "Compose" }).click();
    const composer = page.getByRole("dialog", { name: "New message" });
    await expect(composer).toBeVisible();
    await composer
      .getByRole("button", { name: /Show formatting|Formatting/i })
      .click();
    const colorControl = composer.locator(".color-control").first();
    const metrics = await colorControl.evaluate((ctrl) => {
      const ctrlRect = ctrl.getBoundingClientRect();
      const spanRect = ctrl.querySelector("span")?.getBoundingClientRect();
      return {
        ctrlHeight: ctrlRect.height,
        spanHeight: spanRect?.height ?? 0,
        scrollHeight: ctrl.scrollHeight,
        clientHeight: ctrl.clientHeight,
      };
    });
    expect(metrics.ctrlHeight).toBeGreaterThanOrEqual(44);
    expect(metrics.ctrlHeight).toBeGreaterThanOrEqual(metrics.spanHeight - 2);
    expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + 2);
  }
});

test("D13 SetupWizard progress list semantics and standalone unsupported discovery heading", async ({
  page,
}) => {
  await page.goto("/?noAccounts=1");
  await expect(page.locator(".setup-progress[role='list']")).toBeVisible();

  const nonListItems = await page.evaluate(
    () =>
      Array.from(
        document.querySelector(".setup-progress[role='list']")?.children ?? [],
      ).filter(
        (child) =>
          child.getAttribute("role") !== "listitem" &&
          child.getAttribute("aria-hidden") !== "true",
      ).length,
  );
  expect(nonListItems).toBe(0);

  await page.getByRole("button", { name: /Other email account/i }).click();
  await page.getByLabel("Email address").fill("user@outlook.com");
  await page.getByRole("button", { name: /Find settings/i }).click();
  await expect(page.locator("h1#setup-form-title")).toBeVisible();
});

test("D14 MessageList ARIA wrapper roles, threaded multiselectable, and active-only Settings aria-controls", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  const structure = await page.evaluate(() => {
    const tree = document.querySelector("[role='tree']");
    const wrappersWithoutNone = Array.from(
      tree?.querySelectorAll(".virtual-row, .message-row-wrap") ?? [],
    ).filter((el) => el.getAttribute("role") !== "none").length;
    const unhiddenDays = Array.from(
      tree?.querySelectorAll(".list-day-group") ?? [],
    ).filter((el) => el.getAttribute("aria-hidden") !== "true").length;
    return {
      hasTree: Boolean(tree),
      wrappersWithoutNone,
      unhiddenDays,
    };
  });
  expect(structure.hasTree).toBe(true);
  expect(structure.wrappersWithoutNone).toBe(0);
  expect(structure.unhiddenDays).toBe(0);

  await page.getByRole("button", { name: "Select", exact: true }).click();
  await expect(page.locator("[role='tree'], [role='listbox']")).toHaveAttribute(
    "aria-multiselectable",
    "true",
  );

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const inactiveControls = await page.evaluate(
    () =>
      Array.from(
        document.querySelectorAll("[role='tab'][aria-selected='false']"),
      ).filter((tab) => tab.hasAttribute("aria-controls")).length,
  );
  expect(inactiveControls).toBe(0);
});
