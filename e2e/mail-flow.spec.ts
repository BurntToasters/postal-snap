import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function installMockIpc(page: Page) {
  await page.addInitScript(() => {
    const account = {
      id: "account-1",
      provider: "icloud",
      email: "sam@icloud.com",
      displayName: "Sam",
      syncState: "idle",
      error: null,
    };
    const mailboxes = [
      {
        id: 1,
        accountId: account.id,
        name: "INBOX",
        displayName: "Inbox",
        role: "inbox",
        unreadCount: 1,
        totalCount: 1,
      },
      {
        id: 2,
        accountId: account.id,
        name: "Archive",
        displayName: "Archive",
        role: "archive",
        unreadCount: 0,
        totalCount: 0,
      },
    ];
    const summary = {
      id: 10,
      accountId: account.id,
      mailboxId: 1,
      uid: 44,
      messageId: "<weekend@example.com>",
      subject: "Weekend plans",
      senderName: "Jane",
      senderAddress: "jane@example.com",
      recipients: "sam@icloud.com",
      receivedAt: "2026-08-18T12:00:00Z",
      preview: "Are we still meeting on Saturday?",
      isRead: false,
      isStarred: false,
      hasAttachments: false,
      size: 512,
    };
    const olderSummary = {
      ...summary,
      id: 9,
      uid: 43,
      messageId: "<older@example.com>",
      subject: "Older family note",
      receivedAt: "2026-08-17T12:00:00Z",
    };
    const state = {
      added: false,
      sentDraft: undefined as unknown,
      setupRequest: undefined as unknown,
      remoteFetches: 0,
      inlineReads: 0,
      retried: false,
      moved: false,
      callbacks: new Map<number, (...args: unknown[]) => void>(),
      nextCallback: 1,
    };
    Object.defineProperty(window, "__POSTAL_SNAP_TEST__", { value: state });
    Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
      value: { unregisterListener: () => undefined },
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        transformCallback(callback: (...args: unknown[]) => void) {
          const id = state.nextCallback++;
          state.callbacks.set(id, callback);
          return id;
        },
        unregisterCallback(id: number) {
          state.callbacks.delete(id);
        },
        convertFileSrc(path: string) {
          return path;
        },
        async invoke(command: string, args: Record<string, unknown> = {}) {
          switch (command) {
            case "plugin:event|listen":
              return state.nextCallback++;
            case "plugin:event|unlisten":
              return undefined;
            case "plugin:deep-link|get_current":
              return [];
            case "plugin:notification|is_permission_granted":
              return true;
            case "list_accounts":
              return location.search.includes("firstRun") && !state.added
                ? []
                : [account];
            case "test_account":
              state.setupRequest = args.request;
              return undefined;
            case "add_account":
              if (location.search.includes("setupFail")) {
                throw {
                  code: "authenticationFailed",
                  message:
                    "Sign-in failed. Check the email address and password.",
                  retryable: true,
                };
              }
              state.added = true;
              state.setupRequest = args.request;
              return account;
            case "list_mailboxes":
              return mailboxes;
            case "list_drafts":
              return location.search.includes("localMail")
                ? [
                    {
                      id: "draft-1",
                      accountId: account.id,
                      recipients: "pat@example.com",
                      subject: "Family update",
                      updatedAt: "2026-08-18T10:00:00Z",
                      syncState: location.search.includes("conflict")
                        ? "conflict"
                        : "synced",
                      syncDetail: location.search.includes("conflict")
                        ? "A server edit was preserved as this recovered copy."
                        : null,
                    },
                  ]
                : [];
            case "get_draft":
              return {
                id: "draft-1",
                accountId: account.id,
                to: ["pat@example.com"],
                cc: [],
                bcc: [],
                subject: "Family update",
                htmlBody: "<p>Draft message</p>",
                textBody: "Draft message",
                attachments: location.search.includes("draftInline")
                  ? [
                      {
                        token: "managed-inline",
                        filename: "photo.png",
                        contentType: "image/png",
                        inline: true,
                        contentId: "draft-photo@example.test",
                      },
                    ]
                  : [],
              };
            case "list_outbox":
              return location.search.includes("localMail")
                ? [
                    {
                      id: "outbox-1",
                      accountId: account.id,
                      recipients: "lee@example.com",
                      subject: "Could not confirm",
                      state: location.search.includes("sentCopy")
                        ? "sent_copy_pending"
                        : location.search.includes("queued")
                          ? "queued"
                          : "needs_attention",
                      detail: location.search.includes("sentCopy")
                        ? "Message sent. Its Sent-folder copy is waiting for a safe retry."
                        : location.search.includes("queued")
                          ? "Waiting for a secure mail connection."
                          : "Delivery could not be confirmed.",
                      createdAt: "2026-08-18T11:00:00Z",
                    },
                  ]
                : [];
            case "get_outbox":
              return {
                accountId: account.id,
                to: ["lee@example.com"],
                cc: [],
                bcc: [],
                subject: "Could not confirm",
                htmlBody: "<p>Please review</p>",
                textBody: "Please review",
                attachments: [],
              };
            case "retry_outbox":
              state.retried = true;
              return { id: "outbox-1", state: "sent", detail: null };
            case "retry_sent_copy":
              return { id: "outbox-1", state: "sent", detail: null };
            case "delete_outbox":
            case "delete_draft":
              return undefined;
            case "list_messages":
              if (state.moved)
                return { items: [], nextCursor: null, hasMore: false };
              if (location.search.includes("pagination")) {
                return args.cursor
                  ? { items: [olderSummary], nextCursor: null, hasMore: false }
                  : {
                      items: [summary],
                      nextCursor: {
                        receivedAt: summary.receivedAt,
                        uid: summary.uid,
                      },
                      hasMore: true,
                    };
              }
              return { items: [summary], nextCursor: null, hasMore: false };
            case "get_message":
              return {
                ...summary,
                to: ["sam@icloud.com"],
                cc: [],
                replyTo: null,
                textBody: "Are we still meeting on Saturday?",
                htmlBody: location.search.includes("remote")
                  ? '<p>Are we still meeting?</p><img src="https://images.example.test/pixel.png">'
                  : location.search.includes("inline")
                    ? '<p>Photo:</p><img src="cid:family-photo@example.test">'
                    : "<p>Are we still meeting on Saturday?</p>",
                remoteImagesBlocked: false,
                attachments: location.search.includes("inline")
                  ? [
                      {
                        id: "inline-1",
                        filename: "family.png",
                        contentType: "image/png",
                        size: 128,
                        contentId: "<family-photo@example.test>",
                        inline: true,
                      },
                    ]
                  : [],
              };
            case "set_message_flags":
              if (typeof args.isRead === "boolean") {
                const wasRead = summary.isRead;
                summary.isRead = args.isRead;
                if (wasRead !== summary.isRead)
                  mailboxes[0].unreadCount = Math.max(
                    0,
                    mailboxes[0].unreadCount + (summary.isRead ? -1 : 1),
                  );
              }
              if (typeof args.isStarred === "boolean")
                summary.isStarred = args.isStarred;
              return undefined;
            case "move_message":
              state.moved = true;
              mailboxes[0].totalCount = 0;
              mailboxes[0].unreadCount = 0;
              mailboxes[1].totalCount = 1;
              mailboxes[1].unreadCount = summary.isRead ? 0 : 1;
              return undefined;
            case "sync_account":
            case "release_compose_attachments":
              return undefined;
            case "save_draft":
              return { id: "draft-1", syncState: "localPending" };
            case "send_message":
              state.sentDraft = args.draft;
              return { id: "outbox-1", state: "sent", detail: null };
            case "choose_attachments":
              return [];
            case "prepare_forward_attachments":
              return location.search.includes("forwardAttachment")
                ? [
                    {
                      token: "forwarded-token",
                      filename: "family-plan.pdf",
                      contentType: "application/pdf",
                      inline: false,
                      contentId: null,
                    },
                  ]
                : [];
            case "read_compose_image":
              return "data:image/png;base64,iVBORw0KGgo=";
            case "get_settings":
              return {
                schemaVersion: 2,
                readingPane: "right",
                textScale: 1,
                privateNotifications: false,
                theme: "system",
                density: "comfortable",
                cachePolicy: {
                  mode: "recent",
                  days: 90,
                  maxBytes: 1_073_741_824,
                },
                lastAccountId: null,
                lastMailboxId: null,
                folderPaneWidth: 248,
                messagePaneWidth: 390,
                readerPaneHeight: 360,
              };
            case "save_settings":
              return args.settings;
            case "get_startup_notice":
              return null;
            case "get_cache_usage":
              return { bytes: 0, maxBytes: 1_073_741_824, messageCount: 0 };
            case "get_distribution_channel":
              return { kind: "direct", updatesManagedBy: "postalSnap" };
            case "fetch_remote_image":
              state.remoteFetches += 1;
              return "data:image/png;base64,iVBORw0KGgo=";
            case "read_message_inline_image":
              state.inlineReads += 1;
              return "data:image/png;base64,iVBORw0KGgo=";
            default:
              return undefined;
          }
        },
      },
    });
  });
}

test.beforeEach(async ({ page }) => installMockIpc(page));

test("completes guided iCloud first run", async ({ page }) => {
  await page.goto("/?firstRun=1");
  await page.getByRole("button", { name: /iCloud Mail/i }).click();
  await expect(page.locator(".server-summary")).toContainText(
    "imap.mail.me.com",
  );
  await page.getByLabel("Your name").fill("Sam");
  await page.getByLabel("Email address").fill("sam@icloud.com");
  await page.getByLabel("App-specific password").fill("app-password");
  await page.getByRole("button", { name: "Connect securely" }).click();

  await expect(page.getByRole("button", { name: "Write" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Mailboxes" }),
  ).toContainText("Inbox");
});

test("completes secure manual first run", async ({ page }) => {
  await page.goto("/?firstRun=1");
  await page.getByRole("button", { name: /Other email/i }).click();
  await expect(page.getByText("imap.mail.me.com")).toHaveCount(0);
  await page.getByLabel("Your name").fill("Sam");
  await page.getByLabel("Email address").fill("sam@example.com");
  await page.getByLabel("Email password").fill("secret");
  const incoming = page.getByRole("group", { name: "Incoming IMAP" });
  const outgoing = page.getByRole("group", { name: "Outgoing SMTP" });
  await incoming.getByLabel("Server").fill("imap.example.com");
  await outgoing.getByLabel("Server").fill("smtp.example.com");
  await page.getByRole("button", { name: "Connect securely" }).click();

  await expect(page.getByRole("button", { name: "Write" })).toBeVisible();
  const setup = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __POSTAL_SNAP_TEST__: {
            setupRequest?: {
              provider: string;
              imap?: { host: string };
              smtp?: { host: string };
            };
          };
        }
      ).__POSTAL_SNAP_TEST__.setupRequest,
  );
  expect(setup).toMatchObject({
    provider: "manual",
    imap: { host: "imap.example.com" },
    smtp: { host: "smtp.example.com" },
  });
});

test("explains how to recover from a failed iCloud sign-in", async ({
  page,
}) => {
  await page.goto("/?firstRun=1&setupFail=1");
  await page.getByRole("button", { name: /iCloud Mail/i }).click();
  await page.getByLabel("Your name").fill("Sam");
  await page.getByLabel("Email address").fill("sam@icloud.com");
  await page.getByLabel("App-specific password").fill("wrong-password");
  await page.getByRole("button", { name: "Connect securely" }).click();
  await expect(
    page.getByText(/regular Apple Account password will not work/i),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Write" })).toHaveCount(0);
});

test("reads, replies, and sends through typed IPC", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "To" })).toHaveValue(
    "jane@example.com",
  );
  await page.getByLabel("Message body").pressSequentially("Yes, see you then.");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  const sent = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __POSTAL_SNAP_TEST__: { sentDraft?: { to: string[] } };
        }
      ).__POSTAL_SNAP_TEST__.sentDraft,
  );
  expect(sent?.to).toEqual(["jane@example.com"]);
});

test("updates unread and folder state immediately after mutations", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(page.getByRole("button", { name: /^Inbox/ })).not.toContainText(
    "1",
  );

  await page.getByRole("button", { name: "Mark unread" }).click();
  await expect(page.getByRole("button", { name: /^Inbox/ })).toContainText("1");

  await page
    .locator(".reader-actions")
    .getByRole("button", { name: "Archive" })
    .click();
  await expect(page.getByRole("button", { name: /^Archive/ })).toContainText(
    "1",
  );
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toHaveCount(0);
});

test("switches reading layouts and opens hidden messages accessibly", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Reading" }).click();
  await page.getByLabel("Reading pane", { exact: true }).selectOption("bottom");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator("main.mail-shell")).toHaveClass(/pane-bottom/);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Reading" }).click();
  await page.getByLabel("Reading pane", { exact: true }).selectOption("hidden");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("button", { name: "Close message" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Close message" }),
  ).toBeHidden();
});

test("opens local drafts and makes uncertain sends explicit", async ({
  page,
}) => {
  await page.goto("/?localMail=1");
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await expect(page.getByRole("heading", { name: "Drafts" })).toBeVisible();
  await page.getByRole("button", { name: /Family update/i }).click();
  await expect(page.getByRole("textbox", { name: "To" })).toHaveValue(
    "pat@example.com",
  );
  await page
    .locator(".composer-window")
    .getByRole("button", { name: "Save draft and close" })
    .click();

  await page.getByRole("button", { name: /^Outbox/ }).click();
  await expect(
    page.getByText("Delivery could not be confirmed."),
  ).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Retry sending" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __POSTAL_SNAP_TEST__: { retried: boolean };
            }
          ).__POSTAL_SNAP_TEST__.retried,
      ),
    )
    .toBe(true);
});

test("never fetches remote images before consent", async ({ page }) => {
  await page.goto("/?remote=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            __POSTAL_SNAP_TEST__: { remoteFetches: number };
          }
        ).__POSTAL_SNAP_TEST__.remoteFetches,
    ),
  ).toBe(0);
  await page.getByRole("button", { name: "Load images" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __POSTAL_SNAP_TEST__: { remoteFetches: number };
            }
          ).__POSTAL_SNAP_TEST__.remoteFetches,
      ),
    )
    .toBe(1);
});

test("renders received CID images without remote network access", async ({
  page,
}) => {
  await page.goto("/?inline=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.frameLocator('iframe[title="Message content"]').locator("img"),
  ).toHaveAttribute("src", /^data:image\/png;base64,/);
  const counts = await page.evaluate(() => {
    const state = (
      window as typeof window & {
        __POSTAL_SNAP_TEST__: { inlineReads: number; remoteFetches: number };
      }
    ).__POSTAL_SNAP_TEST__;
    return { inline: state.inlineReads, remote: state.remoteFetches };
  });
  expect(counts).toEqual({ inline: 1, remote: 0 });
});

test("uses a mailbox drawer and back control in narrow windows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 720 });
  await page.goto("/");
  await page.getByRole("button", { name: "Show mailboxes" }).click();
  await expect(page.getByRole("button", { name: /^Inbox/ })).toBeVisible();
  await page.getByRole("button", { name: /^Inbox/ }).click();
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("button", { name: "Back to message list" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to message list" }).click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
});

test("loads older mail with cursor pagination", async ({ page }) => {
  await page.goto("/?pagination=1");
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Load older mail" }).click();
  await expect(
    page.getByRole("option", { name: /Older family note/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load older mail" }),
  ).toBeHidden();
});

test("validates recipients before sending", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Write" }).click();
  await page.getByRole("textbox", { name: "To" }).fill("not-an-address");
  await page.getByRole("textbox", { name: "Subject" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Check each recipient address",
  );
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
});

test("forwards normal attachments by default", async ({ page }) => {
  await page.goto("/?forwardAttachment=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "Forward", exact: true }).click();
  await expect(page.locator(".compose-attachments")).toContainText(
    "family-plan.pdf",
  );
});

test("shows recovered draft conflicts and sent-copy-only retry", async ({
  page,
}) => {
  await page.goto("/?localMail=1&conflict=1&sentCopy=1");
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await expect(page.getByText("Recovered conflict copy")).toBeVisible();
  await page.getByRole("button", { name: /^Outbox/ }).click();
  await expect(page.getByText("Sent — copy pending")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry sending" }),
  ).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Save Sent copy" }),
  ).toBeVisible();
});

test("reopens inline draft previews from managed storage", async ({ page }) => {
  await page.goto("/?localMail=1&draftInline=1");
  await page.getByRole("button", { name: /^Drafts/ }).click();
  await page.getByRole("button", { name: /Family update/i }).click();
  await expect(page.locator(".compose-attachments")).toContainText("photo.png");
});

test("replies from the Mail shortcut and shows a From address", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "r",
        ctrlKey: true,
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(page.getByRole("textbox", { name: "To" })).toHaveValue(
    "jane@example.com",
  );
  await expect(page.getByRole("textbox", { name: "From" })).toHaveValue(
    /Sam <sam@icloud.com>/,
  );
});

test("hides message previews in compact density", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByText("Are we still meeting on Saturday?"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "General" }).click();
  await page.getByLabel("Interface spacing").selectOption("compact");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
  await expect(
    page.getByText("Are we still meeting on Saturday?"),
  ).toBeHidden();
});

test("lists Mail-like shortcuts instead of using R for Get Mail", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Shortcuts" }).click();
  const getMail = page.locator(".shortcut-row").filter({ hasText: "Get Mail" });
  await expect(getMail.locator("kbd")).toContainText("M");
  await expect(getMail.locator("kbd")).not.toContainText("R");
  await expect(
    page
      .locator(".shortcut-row")
      .filter({ has: page.getByText("Reply", { exact: true }) })
      .locator("kbd"),
  ).toContainText("R");
});

test("mail shell has no detectable serious accessibility violations", async ({
  page,
}) => {
  await page.goto("/");
  const scan = await new AxeBuilder({ page }).analyze();
  expect(
    scan.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
});
