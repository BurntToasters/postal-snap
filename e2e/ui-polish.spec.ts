import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

test.beforeEach(async ({ page }) => installMockIpc(page));

test("accountless setup offers display choices that apply right away", async ({
  page,
}) => {
  await page.goto("/?noAccounts=1");
  const display = page.getByRole("region", { name: "Display" });
  await expect(display).toBeVisible();

  await display
    .getByRole("combobox", { name: "Interface spacing" })
    .selectOption("compact");
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");

  await display
    .getByRole("combobox", { name: "Appearance" })
    .selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await expect(
    display.getByRole("combobox", { name: "Text size" }),
  ).toBeVisible();
  await expect(
    display.getByRole("combobox", { name: "Reading pane" }),
  ).toBeVisible();

  await page.screenshot({
    path: "test-results/ui-polish-setup-display.png",
    animations: "disabled",
    fullPage: true,
  });
});

for (const width of [1280, 420]) {
  test(`download choice keeps radio beside its text at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?noAccounts=1");
    await page.getByRole("button", { name: /iCloud Mail/i }).click();

    const choices = page.getByRole("group", { name: /Mail to keep/i });
    for (const option of await choices.locator("label").all()) {
      const radio = await option.locator("input[type=radio]").boundingBox();
      const text = await option.locator("span").first().boundingBox();
      const row = await option.boundingBox();
      expect(radio && text && row).toBeTruthy();
      if (!radio || !text || !row) return;
      // Radio stays native-sized and sits left of the copy.
      expect(radio.width).toBeLessThanOrEqual(24);
      expect(radio.x + radio.width).toBeLessThanOrEqual(text.x);
      // Copy uses most of the row instead of wrapping per letter.
      expect(text.width).toBeGreaterThan(row.width * 0.6);
      expect(row.height).toBeLessThan(140);
    }

    await choices.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/ui-polish-download-choice-${width}.png`,
      fullPage: true,
    });
  });
}

test("message context menu is compact, iconed, and groups move targets", async ({
  page,
}) => {
  await page.goto("/?nestedFolders=1");
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .click({ button: "right" });

  const menu = page.getByRole("menu", { name: "Actions" });
  await expect(menu).toBeVisible();

  const items = menu.getByRole("menuitem");
  const count = await items.count();
  expect(count).toBeGreaterThan(8);
  for (let index = 0; index < count; index += 1) {
    const entry = items.nth(index);
    await expect(entry.locator(".context-menu-icon svg")).toHaveCount(1);
    const box = await entry.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);
    expect(box?.height ?? 99).toBeLessThan(44);
  }

  await expect(menu.getByText("Move to", { exact: true })).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Move to Projects", exact: true }),
  ).toBeVisible();
  // Archive and Trash already have direct actions; no duplicate move rows.
  await expect(
    menu.getByRole("menuitem", { name: "Move to Archive" }),
  ).toHaveCount(0);
  await expect(
    menu.getByRole("menuitem", { name: /Deleted Messages/ }),
  ).toHaveCount(0);
  await expect(
    menu.getByRole("menuitem", { name: "Archive", exact: true }),
  ).toBeVisible();

  await page.screenshot({ path: "test-results/ui-polish-context-menu.png" });

  await menu
    .getByRole("menuitem", { name: "Move to Projects", exact: true })
    .click();
  await expect(menu).toHaveCount(0);
});

// Failure mode: a flattening pass strips the raised, Mail-style depth from
// the settings chrome and cards, leaving plain fills.
test("settings dialog keeps raised surfaces", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).first().click();
  const dialog = page.locator(".settings-window");
  await expect(dialog).toBeVisible();

  const gradients = await page.evaluate(() =>
    [
      ".settings-window > header",
      ".settings-nav",
      ".settings-nav button.active",
      ".settings-row, .switch-row",
    ].map((selector) => {
      const node = document.querySelector(selector);
      return node ? getComputedStyle(node).backgroundImage : "missing";
    }),
  );
  for (const image of gradients) expect(image).toContain("linear-gradient");

  await page.screenshot({ path: "test-results/ui-polish-settings.png" });
});

// Failure modes for menus: each popup drifts to its own background, padding,
// radius, or row height; the reader menu inherits pill toolbar buttons.
test("every menu shares one surface and compact rows", async ({ page }) => {
  await page.goto("/?multiAccount=1");
  const surfaces: Array<Record<string, string>> = [];

  async function capture(menuName: string, rowFilter = ":not([data-context])") {
    const menu = page.getByRole("menu", { name: menuName });
    await expect(menu).toBeVisible();
    const style = await menu.evaluate((node, filter) => {
      const css = getComputedStyle(node);
      const rows = [
        ...node.querySelectorAll<HTMLElement>(`[role="menuitem"]${filter}`),
      ].map((row) => row.getBoundingClientRect().height);
      return {
        background: css.backgroundColor,
        image: css.backgroundImage,
        padding: css.padding,
        radius: css.borderRadius,
        tallest: String(Math.max(...rows)),
        shortest: String(Math.min(...rows)),
      };
    }, rowFilter);
    surfaces.push({ menu: menuName, ...style });
  }

  await page
    .getByRole("option", { name: /Weekend plans/i })
    .click({ button: "right" });
  await capture("Actions");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await capture("More mailbox actions");
  await page.keyboard.press("Escape");

  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await capture("More actions");
  await page.screenshot({ path: "test-results/ui-polish-reader-menu.png" });
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /Sam.*sam@icloud\.com/i }).click();
  await capture("Email accounts");
  await page.keyboard.press("Escape");

  const reference = surfaces[0];
  for (const surface of surfaces) {
    expect(surface.image, surface.menu).toBe("none");
    expect(surface.background, surface.menu).toBe(reference.background);
    expect(surface.padding, surface.menu).toBe(reference.padding);
    expect(surface.radius, surface.menu).toBe(reference.radius);
    expect(Number(surface.shortest), surface.menu).toBeGreaterThanOrEqual(32);
    expect(Number(surface.tallest), surface.menu).toBeLessThan(44);
  }
});

test("reader move list uses the same folder names as the sidebar", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  const move = page.getByRole("combobox", { name: "Move to folder" });
  await expect(move.locator("option", { hasText: "Trash" })).toHaveCount(1);
  await expect(
    move.locator("option", { hasText: "Deleted Messages" }),
  ).toHaveCount(0);
});

test("heading scale and section labels stay consistent", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).first().click();
  const sizes = await page.evaluate(() => {
    const px = (selector: string) =>
      parseFloat(
        getComputedStyle(document.querySelector(selector) as Element).fontSize,
      );
    return {
      windowTitle: px(".settings-window h1"),
      panelTitle: px(".settings-panel h2"),
      sectionLabel: px(".settings-section > h3"),
    };
  });
  expect(sizes.windowTitle).toBeGreaterThan(sizes.panelTitle);
  expect(sizes.sectionLabel).toBeCloseTo(0.78 * 16, 1);
});

test("active folder and settings tab share token-based highlights", async ({
  page,
}) => {
  for (const theme of ["light", "dark"]) {
    await page.goto(`/?theme=${theme}`);
    const folder = await page
      .locator(".folder.active")
      .evaluate((node) => getComputedStyle(node).boxShadow);
    const toolbar = await page
      .locator(".app-toolbar")
      .evaluate((node) => getComputedStyle(node).boxShadow);
    await page.getByRole("button", { name: "Settings" }).first().click();
    const tab = await page
      .locator(".settings-nav button.active")
      .evaluate((node) => getComputedStyle(node).boxShadow);
    expect(tab, theme).toBe(folder);
    // Hard-coded white/black no longer leak into the shared highlight.
    expect(folder, theme).not.toMatch(/srgb 1 1 1 \/ 0\.08/);
    expect(toolbar).not.toContain("0, 0, 0, 0.05");
  }
});

// Failure modes for context-menu keyboard use: Tab leaves an orphaned open
// menu, letters do nothing, the move list is not a named group, and the
// menu floats at a stale spot after resize or window blur.
test("context menu supports Tab, typeahead, groups, and dismissal", async ({
  page,
}) => {
  await page.goto("/?nestedFolders=1");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await row.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "Actions" });
  await expect(menu).toBeVisible();

  await page.keyboard.press("m");
  await expect(menu.getByRole("menuitem", { name: "Mark read" })).toBeFocused();
  await page.keyboard.press("m");
  await expect(
    menu.getByRole("menuitem", { name: "Mark as junk" }),
  ).toBeFocused();
  await page.keyboard.press("p");
  await expect(
    menu.getByRole("menuitem", { name: "Move to Projects", exact: true }),
  ).toBeFocused();

  const group = menu.getByRole("group", { name: "Move to" });
  await expect(group.getByRole("menuitem")).toHaveCount(3);

  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
  await expect(row).toBeFocused();

  await row.click({ button: "right" });
  await expect(menu).toBeVisible();
  await page.setViewportSize({ width: 1100, height: 700 });
  await expect(menu).toHaveCount(0);

  await row.click({ button: "right" });
  await expect(menu).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(menu).toHaveCount(0);
});

// Failure mode: right-clicking inside the message frame moves focus into it,
// so a blur-to-close rule could dismiss the menu the moment it opens.
test("context menu from the message body stays open and returns focus", async ({
  page,
}) => {
  await page.goto("/?webLink=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  const frame = page.locator(".message-body iframe").contentFrame();
  await frame.getByRole("link", { name: "Open site" }).click({
    button: "right",
  });

  const menu = page.getByRole("menu", { name: "Actions" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  await page.screenshot({ path: "test-results/ui-polish-frame-menu.png" });

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(page.locator(".message-body iframe")).toBeFocused();
});

// Failure mode: forced colors strip backgrounds, so hover rows and the chosen
// download option lose their only visual cue.
test("forced colors keep menu hover and download choice visible", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/");
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .click({ button: "right" });
  const reply = page
    .getByRole("menu", { name: "Actions" })
    .getByRole("menuitem", { name: "Reply", exact: true });
  await reply.hover();
  const hoverOutline = await reply.evaluate(
    (node) => getComputedStyle(node).outlineStyle,
  );
  expect(hoverOutline).not.toBe("none");
  const separator = await page
    .locator('.app-menu [role="separator"]')
    .first()
    .evaluate((node) => getComputedStyle(node).borderTopStyle);
  expect(separator).toBe("solid");
  await page.screenshot({ path: "test-results/ui-polish-forced-menu.png" });
  await page.keyboard.press("Escape");

  await page.goto("/?noAccounts=1");
  await page.getByRole("button", { name: /iCloud Mail/i }).click();
  const chosen = page
    .getByRole("group", { name: /Mail to keep/i })
    .locator("label", { has: page.locator("input:checked") });
  const border = await chosen.evaluate(
    (node) => getComputedStyle(node).borderTopWidth,
  );
  expect(parseFloat(border)).toBeGreaterThanOrEqual(2);
  await chosen.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/ui-polish-forced-choice.png" });
});

// Failure modes: nested folders that share a leaf name become identical in
// flat move lists, and long labels truncate at 200% text.
test("move targets show full folder paths and stay whole at 200% text", async ({
  page,
}) => {
  await page.goto("/?nestedFolders=1&scale=2");
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Actions" });
  await expect(
    menu.getByRole("menuitem", { name: "Move to Projects / 2026 / Launch" }),
  ).toBeVisible();

  const clipped = await menu.evaluate((node) =>
    [...node.querySelectorAll<HTMLElement>(".context-menu-label")]
      .filter((label) => label.scrollWidth > label.clientWidth + 1)
      .map((label) => label.textContent),
  );
  expect(clipped).toEqual([]);
  await page.screenshot({ path: "test-results/ui-polish-menu-200.png" });
  await page.keyboard.press("Escape");

  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(
    page
      .getByRole("combobox", { name: "Move to folder" })
      .locator("option", { hasText: "Projects / 2026 / Launch" }),
  ).toHaveCount(1);
});

// Failure mode: keyboard text sizing reaches 175%, which the text-size lists
// lack, so Settings shows a blank choice.
test("every reachable text size has a named choice", async ({ page }) => {
  await page.goto("/?scale=1.75");
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByRole("tab", { name: "Reading" }).click();
  const size = page.getByRole("combobox", { name: "Text size" });
  await expect(size).toHaveValue("1.75");
  const label = await size.evaluate(
    (node: HTMLSelectElement) => node.selectedOptions[0]?.textContent ?? "",
  );
  expect(label).toContain("175%");
  await page.screenshot({ path: "test-results/ui-polish-text-175.png" });
});

test("back-to-back keyboard settings changes both persist", async ({
  page,
}) => {
  await page.goto("/?multiAccount=1");
  await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__POSTAL_SNAP_TEST__?.savedSettings.length ?? 0,
      ),
    )
    .toBeGreaterThan(0);

  const before = await page.evaluate(
    () => window.__POSTAL_SNAP_TEST__?.savedSettings.length ?? 0,
  );
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("postal:menu-action", { detail: "text-larger" }),
    );
    window.dispatchEvent(
      new CustomEvent("postal:menu-action", {
        detail: "reading-pane-bottom",
      }),
    );
  });

  await expect
    .poll(() =>
      page.evaluate(
        () => window.__POSTAL_SNAP_TEST__?.savedSettings.length ?? 0,
      ),
    )
    .toBeGreaterThan(before);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        textSize: document.documentElement.style.fontSize,
        paneBottom: document
          .querySelector(".mail-shell")
          ?.classList.contains("pane-bottom"),
      })),
    )
    .toEqual({ textSize: "115%", paneBottom: true });
  const saved = await page.evaluate(() => {
    const settings = window.__POSTAL_SNAP_TEST__?.savedSettings ?? [];
    return settings[settings.length - 1] as
      { textScale?: number; readingPane?: string } | undefined;
  });
  expect(saved).toMatchObject({ textScale: 1.15, readingPane: "bottom" });
  await page.screenshot({
    path: "test-results/ui-polish-settings-race-fixed.png",
  });
});

// Failure mode: the folder tree re-sorted by raw IMAP name, so "Archive" and
// "Deleted Messages" appeared above the Inbox.
test("mailbox sidebar keeps Inbox first in role order", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Mailboxes" });
  const labels = await nav
    .locator("[data-mailbox-id] > button.folder > span")
    .allTextContents();
  expect(labels.slice(0, 3)).toEqual(["Inbox", "Archive", "Trash"]);
  await nav.screenshot({ path: "test-results/ui-polish-folder-order.png" });
});

// Failure mode: the selected row painted its dot for read mail too, so an
// opened message still looked unread.
test("selected read message shows no unread dot", async ({ page }) => {
  await page.goto("/");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await row.click();
  await expect(row).toHaveClass(/\bread\b/);
  await expect(row.locator(".unread-dot")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await row.screenshot({ path: "test-results/ui-polish-read-selected.png" });
});
