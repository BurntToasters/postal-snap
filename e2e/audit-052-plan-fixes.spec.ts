import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachArtifactsAfterEach, emitTauriEvent, ipcCalls } from "./ipc";
import { installMockIpc } from "./mock-ipc";
import { revealMenuItem } from "./menu-reveal";

test.afterEach(attachArtifactsAfterEach);

// Failure modes covered before implementing 0.5.2 plan fixes:
// FM1. Thread headers, context menus, and selection bar render Star/StarOff instead of Flag/FlagOff.
// FM2. Checked rows miss :focus-visible --focus-on-accent / --accent-contrast, and .message-folder wraps.
// FM3. .composer-from-select drops --popup-chevron on hover/focus-visible.
// FM4. MboxProgressNotice <progress> falls back to unstyled native box.
// FM5. .pane-bottom .message-stamp overflows or refuses wrapping at 200% text scale.
// FM6. SetupFlow ComfortStep shows windowEffects when windowFxSupported is false.
// FM7. Generic .eml hides View; EmlViewer ignores theme, 10MiB PDF cap, or preview races.
// FM8. Context-menu "Mark read" no-ops under markRead="manual" or stalls under markRead="after2s".
// FM9. Unflagging drops flagColor rollback or leaves stale color optimistically.
// FM10. RulesEditor drops paths or remounts rows on remove; Settings search omits notifyPerAccount.

test.beforeEach(async ({ page }) => installMockIpc(page));

async function openRules(page: Page, url = "/?nestedFolders=1") {
  await page.goto(url);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const sectionSelect = page.locator(".settings-section-select select");
  if (await sectionSelect.isVisible()) {
    await sectionSelect.selectOption("accounts");
  } else {
    await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  }
  await page.getByRole("button", { name: /^Manage Sam\b/ }).click();
  await page.getByRole("button", { name: "Rules", exact: true }).click();
}

test("FM1 Flag and FlagOff replace Star and StarOff across list, context menu, and selection bar", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  const weekendGroup = page
    .getByRole("treeitem", { name: /Weekend plans/i })
    .first();
  await weekendGroup.click();
  await weekendGroup.click({ button: "right" });
  const unflaggedMenu = page.locator(".context-menu");
  await expect(unflaggedMenu).toBeVisible();
  await expect(unflaggedMenu.locator("svg.lucide-flag").first()).toBeVisible();
  await expect(
    unflaggedMenu.locator("svg.lucide-star, svg.lucide-star-off"),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "More actions" }).click();
  await revealMenuItem(page, "Flag conversation");
  await page.getByRole("menuitem", { name: "Flag conversation" }).click();

  await expect(
    page.locator(".message-list svg.lucide-flag").first(),
  ).toBeVisible();
  await expect(page.locator(".message-list svg.lucide-star")).toHaveCount(0);

  await weekendGroup.click({ button: "right" });
  const menu = page.locator(".context-menu");
  await expect(menu).toBeVisible();
  await expect(menu.locator("svg.lucide-flag-off").first()).toBeVisible();
  await expect(
    menu.locator("svg.lucide-star, svg.lucide-star-off"),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("option", { name: /Library hours/i }).click();
  await page.getByRole("option", { name: /Older family note/i }).click();
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  const moreMenu = page.locator(".app-menu");
  await expect(moreMenu.locator("svg.lucide-flag").first()).toBeVisible();
  await expect(
    moreMenu.locator("svg.lucide-star, svg.lucide-star-off"),
  ).toHaveCount(0);
});

test("FM2 checked row focus/contrast matches selected and .message-folder truncates cleanly", async ({
  page,
}) => {
  await page.goto("/?scale=2");
  const firstRow = page.locator(".message-row").nth(0);
  await firstRow.click({ button: "right" });
  await revealMenuItem(page, "Flag");
  await page.getByRole("menuitem", { name: "Flag", exact: true }).click();

  await page.getByRole("button", { name: "Select", exact: true }).click();
  const rows = page.locator(".message-row");
  await rows.nth(0).focus();
  await page.keyboard.press("x");
  await expect(rows.nth(0)).toHaveClass(/checked/);

  const styles = await page.evaluate(() => {
    const row = document.querySelector(".message-row.checked:focus-visible");
    if (!row) return null;
    const svg = row.querySelector(".message-subject svg");
    const rowStyle = getComputedStyle(row);
    const svgStyle = svg ? getComputedStyle(svg) : null;
    const probe = document.createElement("div");
    probe.style.outlineColor = "var(--focus-on-accent)";
    probe.style.color = "var(--accent-contrast)";
    document.body.append(probe);
    const probeStyle = getComputedStyle(probe);
    const expectedOutline = probeStyle.outlineColor;
    const expectedContrast = probeStyle.color;
    probe.remove();
    return {
      outlineColor: rowStyle.outlineColor,
      expectedOutline,
      svgColor: svgStyle?.color ?? null,
      expectedContrast,
    };
  });
  expect(styles).not.toBeNull();
  expect(styles?.outlineColor).toBe(styles?.expectedOutline);
  expect(styles?.svgColor).toBe(styles?.expectedContrast);

  // Search across all mailboxes so rows render .message-folder at 200% scale.
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("searchbox").fill("elsewhere");
  await page.getByRole("searchbox").press("Enter");
  await page.getByRole("button", { name: "Search all mailboxes" }).click();
  const folder = page.locator(".message-folder").first();
  await expect(folder).toBeVisible();
  const folderCss = await folder.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      whiteSpace: cs.whiteSpace,
      textOverflow: cs.textOverflow,
      overflowX: cs.overflowX,
    };
  });
  expect(folderCss.whiteSpace).toBe("nowrap");
  expect(folderCss.textOverflow).toBe("ellipsis");
  expect(folderCss.overflowX).toBe("hidden");
});

test("FM3 composer-from-select keeps popup chevron on hover and focus-visible", async ({
  page,
}) => {
  await page.goto("/?fromAlias=1");
  await page.getByRole("button", { name: "Compose" }).click();
  const select = page.locator("select.composer-from-select");
  await expect(select).toBeVisible();

  await select.hover();
  const hoverBg = await select.evaluate(
    (el) => getComputedStyle(el).backgroundImage,
  );
  expect(hoverBg).not.toBe("none");

  // Keyboard Tab into select for :focus-visible.
  await page.locator(".composer-window").press("Tab");
  for (let i = 0; i < 8; i += 1) {
    if (await select.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  const focusBg = await select.evaluate(
    (el) => getComputedStyle(el).backgroundImage,
  );
  expect(focusBg).not.toBe("none");
});

test("FM4 mbox progress toast styles native progress element", async ({
  page,
}) => {
  await page.goto("/?folderTotal=40");
  await page.getByRole("button", { name: /^Inbox/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Export mailbox/ }).click();
  const bar = page.locator(".notice-stack .toast progress");
  await expect(bar).toBeVisible();
  const metrics = await bar.evaluate((el) => {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      height: rect.height,
      radius: cs.borderTopLeftRadius,
    };
  });
  expect(metrics.height).toBeLessThanOrEqual(12);
  expect(metrics.radius).not.toBe("0px");
});

test("FM5 bottom pane message-stamp wraps cleanly at 200% text scale", async ({
  page,
}) => {
  await page.goto("/?pane=bottom&scale=2");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  const stamp = page.locator(".pane-bottom .message-header .message-stamp");
  await expect(stamp).toBeVisible();
  const box = await stamp.evaluate((el) => {
    const header = el.closest(".message-header");
    const stampRect = el.getBoundingClientRect();
    const headerRect = header?.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      flexWrap: cs.flexWrap,
      whiteSpace: cs.whiteSpace,
      rightOverflow: headerRect ? stampRect.right - headerRect.right : 0,
    };
  });
  expect(box.flexWrap).toBe("wrap");
  expect(box.rightOverflow).toBeLessThanOrEqual(1);
});

test("FM6 SetupFlow ComfortStep hides windowEffects when windowFxSupported is false", async ({
  page,
}) => {
  await page.goto("/?firstRun=1&noWindowFx=1");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Translucent window background")).toHaveCount(0);

  await page.goto("/?firstRun=1");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Translucent window background")).toHaveCount(1);
});

test("FM7 generic octet-stream .eml shows View and EmlViewer follows theme, 10MiB PDF cap, and preview concurrency", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as {
      handlers: Record<string, (args: Record<string, unknown>) => unknown>;
    };
    const baseGet = mock.handlers.get_message;
    const baseOpened = mock.handlers.get_opened_message;
    const basePreviewOpened = mock.handlers.preview_opened_attachment;
    mock.handlers.get_message = (args) => {
      const detail = baseGet(args) as Record<string, unknown>;
      if (location.search.includes("genericEml")) {
        return {
          ...detail,
          hasAttachments: true,
          attachmentCount: 1,
          attachments: [
            {
              id: "mail-rfc",
              filename: "Forwarded.eml",
              contentType: "application/octet-stream",
              size: 900,
              contentId: null,
              inline: false,
            },
          ],
        };
      }
      return detail;
    };
    mock.handlers.get_opened_message = (args) => {
      const opened = baseOpened(args) as {
        token: string;
        message: Record<string, unknown>;
      };
      if (location.search.includes("oversizeEmlPdf")) {
        return {
          ...opened,
          message: {
            ...opened.message,
            attachments: [
              {
                id: "pdf-big",
                filename: "TooLarge.pdf",
                contentType: "application/pdf",
                size: 11 * 1024 * 1024,
                contentId: null,
                inline: false,
              },
              {
                id: "pdf-1",
                filename: "Small.pdf",
                contentType: "application/pdf",
                size: 2048,
                contentId: null,
                inline: false,
              },
              {
                id: "txt-1",
                filename: "Notes.txt",
                contentType: "text/plain",
                size: 64,
                contentId: null,
                inline: false,
              },
            ],
          },
        };
      }
      return opened;
    };
    mock.handlers.preview_opened_attachment = async (args) => {
      if (
        args.attachmentId === "pdf-1" &&
        location.search.includes("racePreview")
      ) {
        await new Promise((r) => setTimeout(r, 120));
        return basePreviewOpened(args);
      }
      if (args.attachmentId === "txt-1") {
        return {
          filename: "Notes.txt",
          contentType: "text/plain",
          size: 64,
          text: "Second file",
          imageDataUrl: null,
          pages: null,
          pageCount: null,
          pagesTruncated: false,
        };
      }
      return basePreviewOpened(args);
    };
  });

  await page.goto("/?genericEml=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("button", { name: "View Forwarded.eml" }),
  ).toBeVisible();

  await page.goto(
    "/?emlSeeded=1&emlHtml=1&theme=dark&oversizeEmlPdf=1&racePreview=1",
  );
  await emitTauriEvent(page, "eml-opened", { token: "opened-eml-1" });
  const viewer = page.getByRole("dialog", { name: "Lease renewal" });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator(".eml-message-body")).toHaveAttribute(
    "data-follows-theme",
    "true",
  );
  await expect(
    viewer.getByRole("button", { name: "Preview: TooLarge.pdf" }),
  ).toHaveCount(0);

  // Trigger rapid preview clicks: slower first response must not clobber or stay active.
  await viewer.getByRole("button", { name: "Preview: Small.pdf" }).click();
  await viewer.getByRole("button", { name: "Preview: Notes.txt" }).click();
  const previewModal = page.locator(
    ".attachment-preview-dialog:not(.eml-viewer)",
  );
  await expect(previewModal).toBeVisible();
  await page.waitForTimeout(160);
  const heading = await previewModal.locator("header h2").textContent();
  expect(heading).toBe("Notes.txt");
});

test("FM8 context-menu Mark read works under markRead=manual and after2s", async ({
  page,
}) => {
  for (const mode of ["manual", "after2s"] as const) {
    await page.addInitScript((markReadMode) => {
      const mock = window.__POSTAL_SNAP_MOCK__ as {
        handlers: Record<string, (args: Record<string, unknown>) => unknown>;
      };
      const baseSettings = mock.handlers.get_settings;
      mock.handlers.get_settings = (args) => ({
        ...(baseSettings(args) as Record<string, unknown>),
        markRead: markReadMode,
      });
    }, mode);
    await page.goto(`/?testMode=${mode}`);
    const row = page.getByRole("option", { name: /Weekend plans/i });
    await row.click({ button: "right" });
    await revealMenuItem(page, "Mark read");
    await page
      .getByRole("menuitem", { name: "Mark read", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await ipcCalls(page)).some(
            (call) =>
              call.command === "set_message_flags" &&
              (call.args as { isRead?: boolean }).isRead === true,
          ),
        { timeout: 600 },
      )
      .toBe(true);
  }
});

test("FM9 unflagging clears flagColor optimistically and rolls back flagColor on error", async ({
  page,
}) => {
  await page.goto("/");
  const row = page.getByRole("option", { name: /Weekend plans/i });
  await row.click();
  await row.click({ button: "right" });
  const trigger = page.locator(".popup-submenu-trigger", {
    hasText: "Flag color",
  });
  await trigger.focus();
  await page.keyboard.press("ArrowRight");
  await page
    .locator(".popup-submenu-panel")
    .getByRole("menuitem", { name: "Orange", exact: true })
    .click();
  await expect(row.locator(".star-mark")).toHaveAttribute(
    "data-flag-color",
    "1",
  );

  // Inject failure on next set_message_flags (with brief delay to check optimistic clear).
  await page.evaluate(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as unknown as {
      handlers: Record<string, (args: Record<string, unknown>) => unknown>;
      mockError: (code: string, message: string) => unknown;
    };
    mock.handlers.set_message_flags = async () => {
      await new Promise((r) => setTimeout(r, 80));
      throw mock.mockError("operationFailed", "Could not update flag.");
    };
  });

  await page
    .locator(".reader-actions")
    .getByRole("button", { name: "Unflag", exact: true })
    .click();
  // Rolled back after failure must restore BOTH isStarred and Orange flagColor (1).
  await expect(row.locator(".star-mark")).toBeVisible();
  await expect(row.locator(".star-mark")).toHaveAttribute(
    "data-flag-color",
    "1",
  );

  // Thread conversation rollback via starLoadedConversation also preserves Orange (1).
  await page.goto("/?threadGap=1");
  const groupRow = page
    .getByRole("treeitem", { name: /Weekend plans/i })
    .first();
  await groupRow.click();

  const pickOrange = async (target: Locator) => {
    await target.click({ button: "right" });
    const colorTrigger = page.locator(".popup-submenu-trigger", {
      hasText: "Flag color",
    });
    await colorTrigger.focus();
    await page.keyboard.press("ArrowRight");
    await page
      .locator(".popup-submenu-panel")
      .getByRole("menuitem", { name: "Orange", exact: true })
      .click();
  };
  await pickOrange(page.getByRole("treeitem", { name: /Older family note/i }));
  await pickOrange(groupRow);
  await expect(groupRow.locator(".star-mark")).toHaveAttribute(
    "data-flag-color",
    "1",
  );
  await page.evaluate(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as unknown as {
      handlers: Record<string, (args: Record<string, unknown>) => unknown>;
      mockError: (code: string, message: string) => unknown;
    };
    mock.handlers.set_messages_flags = () => {
      throw mock.mockError("operationFailed", "Could not update flags.");
    };
  });
  await page.getByRole("button", { name: "More actions" }).click();
  await revealMenuItem(page, "Unflag conversation");
  await page
    .getByRole("menuitem", { name: "Unflag conversation", exact: true })
    .click();
  await expect(groupRow.locator(".star-mark")).toHaveAttribute(
    "data-flag-color",
    "1",
  );
});

test("FM10 RulesEditor uses folderPathLabel and stable keys, and Settings search finds Accounts", async ({
  page,
}) => {
  await openRules(page);
  const actionSelect = page.locator(".rule-row select").last();
  await actionSelect.selectOption("move_mailbox");
  const folderOptions = await page
    .locator('select[id^="rule-action-folder-"]')
    .locator("option")
    .allTextContents();
  expect(folderOptions).toContain("Projects / 2026");

  // Add a second condition, type into it, delete the first, and check the second DOM node survived.
  await page.getByRole("button", { name: "Add condition" }).click();
  const secondInput: Locator = page.getByLabel("Text to match 2", {
    exact: true,
  });
  await secondInput.fill("keep-this@example.test");
  await page.evaluate(() => {
    const inputs = document.querySelectorAll(".rule-condition-row input");
    (inputs[1] as HTMLInputElement & { __ruleMarker?: string }).__ruleMarker =
      "kept";
  });
  await page
    .locator(".rule-condition-row")
    .first()
    .getByRole("button", { name: "Remove" })
    .click();
  const survivingMarker = await page.evaluate(() => {
    const first = document.querySelector(".rule-condition-row input") as
      (HTMLInputElement & { __ruleMarker?: string }) | null;
    return {
      marker: first?.__ruleMarker ?? null,
      value: first?.value ?? null,
    };
  });
  expect(survivingMarker).toEqual({
    marker: "kept",
    value: "keep-this@example.test",
  });

  // Check Settings search locates Notifications -> Accounts (notifyPerAccount).
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("searchbox", { name: /Search settings/i })
    .fill("per account");
  await expect(
    page.locator(".settings-search-results").getByText("Accounts"),
  ).toBeVisible();
});
