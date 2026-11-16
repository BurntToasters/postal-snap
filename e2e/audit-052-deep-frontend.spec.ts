import { expect, test } from "@playwright/test";
import { attachArtifactsAfterEach, emitTauriEvent, ipcCalls } from "./ipc";
import { installMockIpc } from "./mock-ipc";
import { revealMenuItem } from "./menu-reveal";

test.afterEach(attachArtifactsAfterEach);
test.beforeEach(async ({ page }) => installMockIpc(page));

test("C1 Redirect leaves To blank instead of prefilling original sender", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await revealMenuItem(page, "Reply options");
  const trigger = page.locator(".popup-submenu-trigger", {
    hasText: "Reply options",
  });
  await trigger.focus();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("menuitem", { name: "Redirect" }).click();

  const dialog = page.getByRole("dialog", { name: /Redirect/i });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "To" })).toHaveValue("");
});

test("C2 Scheduled outbox overdue item does not loop endlessly when staying scheduled", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as {
      handlers: Record<string, (args: Record<string, unknown>) => unknown>;
    };
    const state = window.__POSTAL_SNAP_TEST__ as {
      scheduledAttemptCount?: number;
    };
    state.scheduledAttemptCount = 0;
    mock.handlers.list_outbox = () => [
      {
        id: "sched-loop-1",
        accountId: "account-1",
        recipients: "pat@example.com",
        subject: "Overdue held send",
        preview: "",
        attachmentCount: 0,
        detail: "Deferred while update installs.",
        createdAt: "2026-08-18T12:00:00Z",
        state: "scheduled",
        sendAt: new Date(Date.now() - 60_000).toISOString(),
        isRedirect: false,
      },
    ];
    mock.handlers.send_scheduled_outbox = async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      state.scheduledAttemptCount = (state.scheduledAttemptCount ?? 0) + 1;
      return {
        id: "sched-loop-1",
        state: "scheduled",
        detail: "Deferred while update installs.",
      };
    };
  });

  await page.goto("/");
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window.__POSTAL_SNAP_TEST__ as {
                scheduledAttemptCount?: number;
              }
            ).scheduledAttemptCount ?? 0,
        ),
      { timeout: 3000 },
    )
    .toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(450);
  const attempts = await page.evaluate(
    () =>
      (
        window.__POSTAL_SNAP_TEST__ as {
          scheduledAttemptCount?: number;
        }
      ).scheduledAttemptCount ?? 0,
  );
  expect(attempts).toBeLessThanOrEqual(2);
});

test("C3 Close-confirm blur autosave still closes, and failed send clears sticky pendingClose", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as {
      handlers: Record<string, (args: Record<string, unknown>) => unknown>;
    };
    const baseSave = mock.handlers.save_draft;
    mock.handlers.save_draft = async (args) => {
      if (location.search.includes("blurRace")) {
        await new Promise((resolve) => setTimeout(resolve, 160));
      }
      return baseSave(args);
    };
    mock.handlers.show_native_confirm = async () => {
      if (location.search.includes("blurRace")) {
        window.dispatchEvent(new Event("blur"));
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return true;
    };
    let sendCount = 0;
    const baseSend = mock.handlers.send_message;
    mock.handlers.send_message = async (args) => {
      if (location.search.includes("failSendOnce")) {
        sendCount += 1;
        if (sendCount === 1) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          throw {
            code: "operationFailed",
            message: "SMTP failed transiently",
            retryable: true,
          };
        }
      }
      return baseSend(args);
    };
  });

  await page.goto("/?blurRace=1");
  await page.getByRole("button", { name: "Compose" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await composer
    .getByRole("textbox", { name: "Subject" })
    .fill("Close blur race");
  await composer
    .getByRole("textbox", { name: "Message body" })
    .pressSequentially("Unsaved text");
  await composer.getByRole("button", { name: "Close" }).click();
  await expect(composer).toHaveCount(0, { timeout: 3000 });

  await page.goto("/?failSendOnce=1");
  await page.getByRole("button", { name: "Compose" }).click();
  const retryComposer = page.getByRole("dialog", { name: "New message" });
  await retryComposer
    .getByRole("combobox", { name: "To" })
    .fill("pat@example.com");
  await retryComposer
    .getByRole("textbox", { name: "Subject" })
    .fill("Sticky close test");
  await retryComposer
    .getByRole("textbox", { name: "Message body" })
    .pressSequentially("First try");
  await retryComposer
    .getByRole("button", { name: "Send", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alert")).toContainText("SMTP", {
    timeout: 3000,
  });
  await retryComposer
    .getByRole("button", { name: "Save draft", exact: true })
    .click();
  await page.waitForTimeout(150);
  await expect(retryComposer).toBeVisible();
});

test("C4 Removing duplicated inline image cleans every copy without RangeError or corrupting trailing text", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/?pickImage=1");
  await page.getByRole("button", { name: "Compose" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await composer.getByRole("button", { name: "Picture", exact: true }).click();
  const editor = composer.locator(".ProseMirror");
  await expect(editor.locator("img")).toHaveCount(1);

  await editor.evaluate((el) => {
    const firstImg = el.querySelector("img");
    if (firstImg) {
      const clone = firstImg.cloneNode(true);
      firstImg.after(clone);
      el.appendChild(document.createTextNode(" keep-this-text"));
    }
  });
  await expect(editor.locator("img")).toHaveCount(2);

  await composer
    .getByRole("button", { name: /Remove .*family-photo\.jpg/i })
    .click();
  expect(pageErrors).toEqual([]);
  await expect(editor.locator("img")).toHaveCount(0);
  await expect(editor).toContainText("keep-this-text");
});

test("C5 Background update preserves Settings update listener and settles mid-download status", async ({
  page,
}) => {
  page.on("dialog", (dialog) => void dialog.dismiss());
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as {
      handlers: Record<string, (args: Record<string, unknown>) => unknown>;
    };
    const state = window.__POSTAL_SNAP_TEST__ as {
      updateCalls: Array<{ command: string; args: Record<string, unknown> }>;
    };
    const baseDownload = mock.handlers["plugin:updater|download"];
    mock.handlers["plugin:updater|download"] = async (args) => {
      if (location.search.includes("slowFail")) {
        state.updateCalls.push({ command: "download", args: { ...args } });
        await new Promise((resolve) => setTimeout(resolve, 260));
        throw "network lost";
      }
      return baseDownload(args);
    };
  });

  await page.goto("/?updateLater=1&downloadSlow=1");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Updates", exact: true }).click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window.__POSTAL_SNAP_TEST__ as {
                updateCalls: Array<{ command: string }>;
              }
            ).updateCalls.filter((c) => c.command === "mark_update_checked")
              .length,
        ),
      { timeout: 3000 },
    )
    .toBeGreaterThanOrEqual(1);
  await emitTauriEvent(page, "update-check-due", null);
  await expect(
    page.getByRole("button", { name: /Downloading 9\.9\.9/i }),
  ).toBeVisible({ timeout: 2500 });
  await expect(
    page.getByRole("button", { name: "Restart Postal Snap", exact: true }),
  ).toBeVisible({ timeout: 4000 });

  await page.goto("/?update=1&slowFail=1");
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window.__POSTAL_SNAP_TEST__ as {
                updateCalls: Array<{ command: string }>;
              }
            ).updateCalls.filter((c) => c.command === "download").length,
        ),
      { timeout: 3000 },
    )
    .toBeGreaterThanOrEqual(1);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Updates", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Check for updates", exact: true }),
  ).toBeEnabled({ timeout: 3500 });
});

test("C6 Mailbox switches clear search/selection and searchAccount keeps loading indicator", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as {
      handlers: Record<string, (args: Record<string, unknown>) => unknown>;
    };
    const baseSearchCached = mock.handlers.search_cached_messages;
    mock.handlers.search_cached_messages = async (args) => {
      if (location.search.includes("slowSearch")) {
        await new Promise<void>((resolve) => {
          (
            window as unknown as { __resolveSlowSearch?: () => void }
          ).__resolveSlowSearch = resolve;
        });
      }
      return baseSearchCached(args);
    };
  });

  await page.goto("/?unreadArchive=1");
  const searchBox = page.getByRole("searchbox");
  await searchBox.fill("Weekend");
  await searchBox.press("Enter");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("option", { name: /Current mailbox/i }).click();

  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await page.getByRole("menuitem", { name: "Next unread mailbox" }).click();

  await expect(searchBox).toHaveValue("");
  await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: /Select message/i }),
  ).toHaveCount(0);

  await page.goto("/?slowSearch=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await revealMenuItem(page, "Messages from this sender");
  await page
    .getByRole("menuitem", { name: "Messages from this sender" })
    .click();
  await expect(
    page.locator(".message-list-items[aria-busy='true']"),
  ).toBeVisible();
  await page.evaluate(() => {
    (
      window as unknown as { __resolveSlowSearch?: () => void }
    ).__resolveSlowSearch?.();
  });
});

test("C7 Removing selected account resets account view & dirty state; listFilterRules does not resurrect deleted rules", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as {
      handlers: Record<string, (args: Record<string, unknown>) => unknown>;
    };
    const state = window.__POSTAL_SNAP_TEST__ as {
      rules: Array<Record<string, unknown>>;
    };
    state.rules = [
      {
        id: "rule-temp",
        accountId: "account-1",
        name: "Temp rule",
        field: "from",
        contains: "temp@example.com",
        action: "move_archive",
        targetMailbox: "Archive",
        enabled: true,
        matchMode: "all",
        conditions: [{ field: "from", value: "temp@example.com" }],
        actions: [{ kind: "move_archive", targetMailbox: "Archive" }],
      },
    ];
    const baseListAccounts = mock.handlers.list_accounts;
    const baseRemoveAccount = mock.handlers.remove_account;
    const removedAccounts = new Set<string>();
    let cachedAccounts: Array<{ id: string }> = [];
    mock.handlers.remove_account = (args) => {
      removedAccounts.add(String(args.accountId));
      return baseRemoveAccount(args);
    };
    mock.handlers.list_accounts = (args) => {
      const listed = baseListAccounts(args) as Array<{ id: string }>;
      if (listed.length > 0) cachedAccounts = listed;
      return (listed.length > 0 ? listed : cachedAccounts).filter(
        (a) => !removedAccounts.has(a.id),
      );
    };
    let listCalls = 0;
    const baseListRules = mock.handlers.list_filter_rules;
    mock.handlers.list_filter_rules = async (args) => {
      listCalls += 1;
      const snap = [...state.rules];
      if (location.search.includes("slowRuleLoad") && listCalls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return snap.length ? snap : baseListRules(args);
    };
  });

  await page.goto("/?multiAccount=1");
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  await page.getByRole("button", { name: /^Manage Sam\b/ }).click();
  await page.getByRole("button", { name: "Identity", exact: true }).click();
  await page.getByLabel("Name on mail you send").fill("Sam Edited");
  await page.getByRole("button", { name: "Connection", exact: true }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();

  await expect(
    page.getByRole("button", { name: /← Back to accounts|Back to accounts/i }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /^Manage Work\b/ }),
  ).toBeVisible();

  let promptCount = 0;
  page.removeAllListeners("dialog");
  page.on("dialog", async (dialog) => {
    promptCount += 1;
    await dialog.accept();
  });
  await page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  expect(promptCount).toBe(0);
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);

  await page.goto("/?slowRuleLoad=1");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  await page.getByRole("button", { name: /^Manage Sam\b/ }).click();
  await page.getByRole("button", { name: "Rules", exact: true }).click();
  await page.waitForTimeout(300);
  await expect(page.getByText("Temp rule")).toBeVisible();
  page.removeAllListeners("dialog");
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator("li", { hasText: "Temp rule" })
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await expect(page.getByText("Temp rule")).toHaveCount(0);
  await page.waitForTimeout(100);
  await expect(page.getByText("Temp rule")).toHaveCount(0);
});

test("C8 Plain-text compose disables inline Picture insertion", async ({
  page,
}) => {
  await page.goto("/?defaultPlain=1&pickImage=1");
  await page.getByRole("button", { name: "Compose" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await expect(composer).toBeVisible();
  await expect(
    composer.getByRole("button", { name: "Attach", exact: true }),
  ).toBeVisible();
  const pictureBtn = composer.getByRole("button", {
    name: "Picture",
    exact: true,
  });
  await expect(pictureBtn).toBeDisabled();
});

test("C9 Expanded conversation header and ArrowLeft collapse even when newest message is selected", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  const header = page.getByRole("treeitem", { name: /Weekend plans/i }).first();
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");

  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");

  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await header.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(header).toHaveAttribute("aria-expanded", "false");
});

test("C10 All-day calendar invite formats accurately across DST transitions", async ({
  browser,
}) => {
  const context = await browser.newContext({
    timezoneId: "America/Los_Angeles",
  });
  const page = await context.newPage();
  await installMockIpc(page);
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as {
      handlers: Record<string, (args: Record<string, unknown>) => unknown>;
    };
    const baseGet = mock.handlers.get_message;
    mock.handlers.get_message = (args) => {
      const base = baseGet(args) as Record<string, unknown>;
      if (args.messageId === 10) {
        return {
          ...base,
          invite: {
            method: "REQUEST",
            status: "CONFIRMED",
            summary: "DST Fall Back Day",
            start: { iso: "2026-11-01", allDay: true, utc: false, tzid: null },
            end: { iso: "2026-11-02", allDay: true, utc: false, tzid: null },
            location: null,
            organizerName: "Sam",
            organizerEmail: "sam@example.com",
          },
        };
      }
      return {
        ...base,
        invite: {
          method: "REQUEST",
          status: "CONFIRMED",
          summary: "DST Spring Forward Range",
          start: { iso: "2026-03-07", allDay: true, utc: false, tzid: null },
          end: { iso: "2026-03-09", allDay: true, utc: false, tzid: null },
          location: null,
          organizerName: "Sam",
          organizerEmail: "sam@example.com",
        },
      };
    };
  });

  await page.goto("/?threadGap=1");
  await page
    .getByRole("treeitem", { name: /Weekend plans/i })
    .first()
    .click();
  const card = page.locator(".invite-card");
  await expect(card).toContainText("November 1, 2026 (All day)");
  await expect(card).not.toContainText("November 1, 2026 –");

  await page.getByRole("treeitem", { name: /Library hours/i }).click();
  await expect(card).toContainText("March 7, 2026");
  await expect(card).toContainText("March 8, 2026");
  await context.close();
});

test("C11 blockSender aborts moving a newly selected message if selection changes during confirm", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as {
      handlers: Record<string, (args: Record<string, unknown>) => unknown>;
    };
    let resolveConfirm: ((value: boolean) => void) | undefined;
    (
      window as unknown as {
        __resolveBlockConfirm?: (v: boolean) => void;
      }
    ).__resolveBlockConfirm = (v: boolean) => resolveConfirm?.(v);
    mock.handlers.show_native_confirm = () =>
      new Promise<boolean>((resolve) => {
        resolveConfirm = resolve;
      });
  });

  await page.goto("/?threadGap=1");
  await page
    .getByRole("treeitem", { name: /Weekend plans/i })
    .first()
    .click();
  await page.getByRole("button", { name: "More actions" }).click();
  await revealMenuItem(page, "Block sender");
  await page.getByRole("menuitem", { name: "Block sender" }).click();

  await page.getByRole("treeitem", { name: /Library hours/i }).click();
  await expect(
    page.getByRole("heading", { name: "Library hours" }),
  ).toBeVisible();
  await page.evaluate(() => {
    (
      window as unknown as { __resolveBlockConfirm?: (v: boolean) => void }
    ).__resolveBlockConfirm?.(true);
  });
  await page.waitForTimeout(100);
  const calls = await ipcCalls(page);
  expect(
    calls.filter(
      (c) =>
        c.command === "move_message" ||
        c.command === "move_messages_to_mailbox",
    ),
  ).toHaveLength(0);
});

test("C12 Reader does not show Retry loading images before consent on CID mail and refreshes after downloadFull", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as {
      handlers: Record<string, (args: Record<string, unknown>) => unknown>;
    };
    const baseGet = mock.handlers.get_message;
    let downloaded = false;
    mock.handlers.download_full_message = (args) => {
      downloaded = true;
      const base = baseGet(args) as Record<string, unknown>;
      return {
        ...base,
        bodyPartial: false,
        htmlBody:
          '<p>Full body updated</p><img src="cid:cid-logo@test"><img src="https://img.example.test/hero.png">',
        remoteImagesBlocked: true,
        attachments: [
          {
            id: "cid-1",
            filename: "logo.png",
            contentType: "image/png",
            size: 120,
            contentId: "cid-logo@test",
            inline: true,
          },
        ],
      };
    };
    mock.handlers.get_message = (args) => {
      const base = baseGet(args) as Record<string, unknown>;
      return {
        ...base,
        bodyPartial: !downloaded,
        htmlBody: downloaded
          ? '<p>Full body updated</p><img src="cid:cid-logo@test"><img src="https://img.example.test/hero.png">'
          : '<p>Partial preview</p><img src="cid:cid-logo@test"><img src="https://img.example.test/hero.png">',
        remoteImagesBlocked: true,
        attachments: [
          {
            id: "cid-1",
            filename: "logo.png",
            contentType: "image/png",
            size: 120,
            contentId: "cid-logo@test",
            inline: true,
          },
        ],
      };
    };
  });

  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("button", { name: "Load images", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry loading images", exact: true }),
  ).toHaveCount(0);

  await page
    .getByRole("button", { name: "Download full message", exact: true })
    .click();
  await expect(
    page.frameLocator(".message-body iframe").locator("body"),
  ).toContainText("Full body updated");
});

test("C13 Reader Find resets across messages and excludes collapsed quoted mail", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as {
      handlers: Record<string, (args: Record<string, unknown>) => unknown>;
    };
    const baseGet = mock.handlers.get_message;
    mock.handlers.get_message = (args) => {
      const base = baseGet(args) as Record<string, unknown>;
      if (args.messageId === 10) {
        return {
          ...base,
          htmlBody:
            '<p>needle one needle two needle three</p><blockquote class="gmail_quote">This quoted block is definitely longer than forty characters and mentions needle four and needle five.</blockquote>',
          textBody: "needle one needle two needle three",
        };
      }
      return {
        ...base,
        htmlBody: "<p>needle alpha needle beta</p>",
        textBody: "needle alpha needle beta",
      };
    };
  });

  await page.goto("/?threadGap=1");
  await page
    .getByRole("treeitem", { name: /Weekend plans/i })
    .first()
    .click();
  await page.keyboard.press("Alt+Meta+f");
  const find = page.getByRole("textbox", { name: "Find in message" });
  await find.fill("needle");
  await find.press("Enter");
  await expect(page.locator(".message-find-status")).toHaveText("1 of 3");
  await find.press("Enter");
  await expect(page.locator(".message-find-status")).toHaveText("2 of 3");

  await page.getByRole("treeitem", { name: /Library hours/i }).click();
  await expect(page.locator(".message-find-status")).toHaveCount(0);
  await find.press("Enter");
  await expect(page.locator(".message-find-status")).toHaveText("1 of 2");
});

test("C14 Failed save_settings reverts pendingSort, pendingFilter, and pendingCollapsed", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as {
      handlers: Record<string, (args: Record<string, unknown>) => unknown>;
    };
    mock.handlers.save_settings = async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      throw "Settings cannot be saved right now.";
    };
  });

  await page.goto("/?nestedFolders=1");
  await page.getByRole("radio", { name: "Unread" }).click();
  await expect(page.getByRole("radio", { name: "All" })).toBeChecked();

  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await revealMenuItem(page, "Sort by");
  await page.getByRole("menuitem", { name: "Sort by" }).hover();
  await page.getByRole("menuitemradio", { name: "From" }).click();
  await page.waitForTimeout(150);
  await expect
    .poll(async () => {
      await page.getByRole("button", { name: "More mailbox actions" }).click();
      await revealMenuItem(page, "Sort by");
      await page.getByRole("menuitem", { name: "Sort by" }).hover();
      const checked = await page
        .getByRole("menuitemradio", { name: "Date" })
        .getAttribute("aria-checked");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      return checked;
    })
    .toBe("true");

  const projectsRow = page.locator(".folder-tree-row", {
    hasText: "Projects",
  });
  const toggleBtn = projectsRow
    .getByRole("button", { name: /Collapse|Expand/i })
    .first();
  await toggleBtn.click();
  await expect(toggleBtn).toHaveAttribute("aria-expanded", "true");
});

test("C15 setFlagColorFor ignores stale failure rollback after newer change or folder switch", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as {
      handlers: Record<string, (args: Record<string, unknown>) => unknown>;
    };
    let calls = 0;
    mock.handlers.set_messages_flag_color = async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        throw "Transient server error";
      }
      return null;
    };
  });

  await page.goto("/");
  const row = page.getByRole("option", { name: /Weekend plans/i }).first();
  await row.click({ button: "right" });
  await revealMenuItem(page, "Flag color");
  await page.getByRole("menuitem", { name: "Flag color" }).click();
  await page.getByRole("menuitem", { name: "Red" }).click();

  await row.click({ button: "right" });
  await revealMenuItem(page, "Flag color");
  await page.getByRole("menuitem", { name: "Flag color" }).click();
  await page.getByRole("menuitem", { name: "Green" }).click();

  await page.waitForTimeout(260);
  await expect(row).toContainText(/Green|Weekend plans/i);
  await expect(row.locator('[data-flag-color="3"]')).toHaveCount(1);
});

test("C16 Preview Download saves exact previewed attachmentId when filenames collide", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as {
      handlers: Record<string, (args: Record<string, unknown>) => unknown>;
    };
    const baseGet = mock.handlers.get_message;
    mock.handlers.get_message = (args) => {
      const base = baseGet(args) as Record<string, unknown>;
      return {
        ...base,
        hasAttachments: true,
        attachmentCount: 2,
        attachments: [
          {
            id: "dup-1",
            filename: "report.pdf",
            contentType: "text/plain",
            size: 120,
            contentId: null,
            inline: false,
          },
          {
            id: "dup-2",
            filename: "report.pdf",
            contentType: "text/plain",
            size: 240,
            contentId: null,
            inline: false,
          },
        ],
      };
    };
    mock.handlers.preview_attachment = (args) => ({
      filename: "report.pdf",
      contentType: "text/plain",
      size: args.attachmentId === "dup-2" ? 240 : 120,
      text: `Content for ${String(args.attachmentId)}`,
      imageDataUrl: null,
    });
  });

  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page
    .getByRole("button", { name: /Preview:\s*report\.pdf/i })
    .nth(1)
    .click();
  const dialog = page.getByRole("dialog", { name: /report\.pdf/i });
  await expect(dialog).toContainText("Content for dup-2");
  await dialog
    .getByRole("button", { name: "Download file", exact: true })
    .click();
  const saved = (await ipcCalls(page)).filter(
    (call) => call.command === "save_attachment",
  );
  expect(saved).toHaveLength(1);
  expect((saved[0].args as { attachmentId?: string }).attachmentId).toBe(
    "dup-2",
  );
});

test("C17 discardQueued skips scheduled items while sendScheduledOutbox is in flight", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as {
      handlers: Record<string, (args: Record<string, unknown>) => unknown>;
    };
    let inFlightHeld: (() => void) | undefined;
    let notifySendStarted: (() => void) | undefined;
    let scheduledStartPromise: Promise<void> | undefined;
    const ensureSendStarted = () => {
      if (!scheduledStartPromise) {
        scheduledStartPromise = new Promise<void>((resolve) => {
          notifySendStarted = resolve;
        });
      }
      return scheduledStartPromise;
    };
    let sendAtIso: string | undefined;
    (
      window as unknown as { __releaseScheduledSend?: () => void }
    ).__releaseScheduledSend = () => inFlightHeld?.();
    mock.handlers.list_outbox = () => {
      if (!sendAtIso) {
        sendAtIso = new Date(Date.now() + 900).toISOString();
      }
      return [
        {
          id: "sched-race-1",
          accountId: "account-1",
          recipients: "pat@example.com",
          subject: "Due now race",
          preview: "",
          attachmentCount: 0,
          detail: "Held for review.",
          createdAt: "2026-08-18T12:00:00Z",
          state: "scheduled",
          sendAt: sendAtIso,
          isRedirect: false,
        },
      ];
    };
    mock.handlers.send_scheduled_outbox = () => {
      ensureSendStarted();
      notifySendStarted?.();
      return new Promise((resolve) => {
        inFlightHeld = () =>
          resolve({ id: "sched-race-1", state: "sent", detail: null });
      });
    };
    mock.handlers.show_native_confirm = async () => {
      await ensureSendStarted();
      return true;
    };
  });

  await page.goto("/?localMail=1");
  await page.getByRole("button", { name: /^Outbox/ }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await ipcCalls(page)).filter(
          (c) => c.command === "send_scheduled_outbox",
        ).length,
    )
    .toBe(1);
  await page.waitForTimeout(150);
  const calls = await ipcCalls(page);
  expect(calls.filter((c) => c.command === "restore_outbox")).toHaveLength(0);
});

test("C18 Custom schedule submit validates invalid date without throwing RangeError", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await page.getByRole("button", { name: "Compose" }).click();
  const composer = page.getByRole("dialog", { name: "New message" });
  await composer.getByRole("combobox", { name: "To" }).fill("pat@example.com");
  await composer
    .getByRole("textbox", { name: "Subject" })
    .fill("Schedule validation");
  await composer.getByRole("button", { name: "Send options" }).click();
  await page.getByRole("menuitem", { name: /Pick a date and time/i }).click();

  const form = page.locator("form.schedule-form");
  await expect(form).toBeVisible();
  await form.evaluate((el) => {
    const input = el.querySelector("input");
    if (input) {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "invalid-date");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(pageErrors).toEqual([]);
  await expect(page.getByRole("alert")).toContainText(
    "Pick a future date and time within the next year.",
  );
});

test("C19 Notifications toggle serializes, Settings search Shortcuts focuses panel, and openFoundMessage handles oversize and counts", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as {
      handlers: Record<string, (args: Record<string, unknown>) => unknown>;
    };
    let notifyCall = 0;
    mock.handlers.set_account_notifications = async () => {
      notifyCall += 1;
      if (notifyCall === 1) {
        await new Promise((resolve) => setTimeout(resolve, 160));
        throw "First toggle failed";
      }
      return null;
    };
    const baseGet = mock.handlers.get_message;
    mock.handlers.get_message = (args) => {
      if (args.messageId === 13) {
        throw { code: "limitExceeded", message: "Message too large to open." };
      }
      if (args.messageId === 12) {
        return {
          ...(baseGet({ ...args, messageId: 10 }) as Record<string, unknown>),
          id: 12,
          mailboxId: 2,
          isRead: false,
          subject: "Archive notice",
        };
      }
      return baseGet(args);
    };
  });

  await page.goto("/?unreadArchive=1");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Search settings").fill("Shortcuts");
  await page
    .getByRole("button", { name: /Shortcuts/i })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Keyboard Shortcuts" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(document.activeElement?.closest("#settings-shortcuts")),
      ),
    )
    .toBe(true);

  await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  const samSwitch = page.getByRole("checkbox", {
    name: /Notify for new mail: Sam/i,
  });
  await samSwitch.click();
  await samSwitch.click();
  await page.waitForTimeout(220);
  await expect(samSwitch).toBeChecked();

  await page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("button", { name: "Close settings", exact: true })
    .click();

  await emitTauriEvent(page, "notification-open", {
    accountId: "account-1",
    messageId: 12,
  });
  await expect(
    page.getByRole("heading", { name: "Archive notice" }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (await ipcCalls(page)).filter((c) => c.command === "list_mailboxes")
          .length,
    )
    .toBeGreaterThanOrEqual(2);

  await emitTauriEvent(page, "notification-open", {
    accountId: "account-1",
    messageId: 13,
  });
  await expect(
    page.getByRole("heading", { name: "Archive notice" }),
  ).toBeVisible();
});
