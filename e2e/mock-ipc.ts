import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";

export async function installMockIpc(
  page: Page,
  distribution: "direct" | "store" = "direct",
) {
  const filename = distribution === "direct" ? "direct/default" : "store/store";
  const { permissions } = JSON.parse(
    readFileSync(`src-tauri/capabilities/${filename}.json`, "utf8"),
  ) as { permissions: string[] };
  await page.addInitScript((permissions: string[]) => {
    const params = new URLSearchParams(location.search);
    const account = {
      id: "account-1",
      provider: "icloud",
      email: "sam@icloud.com",
      displayName: "Sam",
      syncState: "idle",
      error: location.search.includes("authError")
        ? "Sign-in failed. Update the account password in Settings > Accounts."
        : null,
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
      {
        id: 3,
        accountId: account.id,
        name: "Deleted Messages",
        displayName: "Deleted Messages",
        role: "trash",
        unreadCount: 0,
        totalCount: 2,
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
      threadRoot: null as string | null,
    };
    const olderSummary = {
      ...summary,
      id: 9,
      uid: 43,
      messageId: "<older@example.com>",
      subject: "Older family note",
      receivedAt: "2026-08-17T12:00:00Z",
    };
    if (location.search.includes("threaded")) {
      summary.threadRoot = "<weekend@example.com>";
      olderSummary.threadRoot = "<weekend@example.com>";
    }
    const state = {
      windowCommands: [] as string[],
      snapBounds: [] as Array<Record<string, unknown>>,
      maximized: false,
      fullscreen: false,
      failWindowAction: false,
      savedSettings: [] as unknown[],
      added: false,
      discarded: false,
      snoozed: false,
      sentDraft: undefined as unknown,
      setupRequest: undefined as unknown,
      remoteFetches: 0,
      openedUrls: [] as string[],
      inlineReads: 0,
      retried: false,
      moved: false,
      exportedSettings: 0,
      importedSettings: 0,
      resetSettings: 0,
      rules: [] as Array<Record<string, unknown>>,
      callbacks: new Map<number, (...args: unknown[]) => void>(),
      eventListeners: new Map<string, Set<number>>(),
      nextCallback: 1,
    };
    Object.defineProperty(window, "__POSTAL_SNAP_TEST__", { value: state });
    Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
      value: { unregisterListener: () => undefined },
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
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
          if (command.startsWith("plugin:window|")) {
            const action = command.split("|")[1];
            if (action === "is_maximized") return state.maximized;
            if (action === "is_fullscreen") return state.fullscreen;
            const permission =
              action === "internal_toggle_maximize"
                ? "core:default"
                : `core:window:allow-${action.replaceAll("_", "-")}`;
            if (!permissions.includes(permission))
              throw new Error(`Window permission missing: ${permission}`);
            if (state.failWindowAction)
              throw new Error("Window operation failed");
            state.windowCommands.push(action);
            if (
              action === "toggle_maximize" ||
              action === "internal_toggle_maximize"
            )
              state.maximized = !state.maximized;
            if (action === "set_fullscreen")
              state.fullscreen = Boolean(args.fullscreen);
            return undefined;
          }
          switch (command) {
            case "set_snap_overlay_bounds":
              state.snapBounds.push({ ...args });
              return undefined;
            case "plugin:event|listen": {
              const event = String(args.event);
              const handler = Number(args.handler);
              const listeners = state.eventListeners.get(event) ?? new Set();
              listeners.add(handler);
              state.eventListeners.set(event, listeners);
              return handler;
            }
            case "plugin:event|unlisten": {
              const listeners = state.eventListeners.get(String(args.event));
              listeners?.delete(Number(args.eventId));
              return undefined;
            }
            case "plugin:event|emit": {
              const event = String(args.event);
              for (const handler of state.eventListeners.get(event) ?? []) {
                state.callbacks.get(handler)?.({
                  event,
                  id: handler,
                  payload: args.payload,
                });
              }
              return null;
            }
            case "plugin:process|restart":
              return undefined;
            case "plugin:deep-link|get_current":
              return [];
            case "plugin:notification|is_permission_granted":
              return true;
            case "list_accounts":
              if (location.search.includes("startupFail")) {
                throw {
                  code: "localStorageFailed",
                  message:
                    "Postal Snap could not access local mail data on your computer.",
                  retryable: true,
                };
              }
              return location.search.includes("firstRun") && !state.added
                ? []
                : [account];
            case "test_account":
              state.setupRequest = args.request;
              return undefined;
            case "update_account_password":
              state.setupRequest = args.password;
              account.error = null;
              return { ...account };
            case "update_account_signature":
              (account as { signature?: string }).signature = String(
                args.signature,
              );
              return { ...account };
            case "list_filter_rules":
              state.rules = state.rules ?? [];
              return state.rules;
            case "create_filter_rule": {
              const rule = args.rule as Record<string, unknown>;
              const created = {
                ...rule,
                id: `rule-${state.rules.length + 1}`,
              };
              state.rules.push(created);
              return created;
            }
            case "update_filter_rule": {
              const rule = args.rule as Record<string, unknown>;
              state.rules = state.rules.map((item) =>
                item.id === rule.id ? rule : item,
              );
              return rule;
            }
            case "delete_filter_rule":
              state.rules = state.rules.filter(
                (rule) => rule.id !== args.ruleId,
              );
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
              if (!location.search.includes("localMail") || state.discarded) {
                return [];
              }
              return [
                {
                  id: "outbox-1",
                  accountId: account.id,
                  recipients: "lee@example.com",
                  subject: "Could not confirm",
                  state: location.search.includes("sentCopy")
                    ? "sent_copy_pending"
                    : location.search.includes("queued")
                      ? "queued"
                      : location.search.includes("scheduled")
                        ? "scheduled"
                        : "needs_attention",
                  detail: location.search.includes("sentCopy")
                    ? "Message sent. Its Sent-folder copy is waiting for a safe retry."
                    : location.search.includes("queued")
                      ? "Waiting for a secure mail connection."
                      : location.search.includes("scheduled")
                        ? "Held for review. Undo anytime before it sends."
                        : "Delivery could not be confirmed.",
                  createdAt: "2026-08-18T11:00:00Z",
                  sendAt: location.search.includes("scheduled")
                    ? new Date(Date.now() + 60_000).toISOString()
                    : null,
                },
              ];
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
              state.discarded = true;
              return undefined;
            case "restore_outbox":
              state.discarded = true;
              return {
                accountId: "acc-1",
                to: ["sam@example.test"],
                cc: [],
                bcc: [],
                subject: "Queued",
                htmlBody: "<p>Queued</p>",
                textBody: "Queued",
                attachments: [],
              };
            case "set_mail_shortcut_guard":
              return undefined;
            case "snooze_message":
              state.snoozed = true;
              return undefined;
            case "unsnooze_message":
              return undefined;
            case "list_snoozed":
              return [];
            case "delete_draft":
              return undefined;
            case "search_cached_messages":
            case "search_server_messages": {
              const search = args.query as { allFolders?: boolean } | undefined;
              return [
                {
                  ...summary,
                  subject: search?.allFolders
                    ? "Across account"
                    : "Current mailbox",
                },
              ];
            }
            case "list_messages":
              if (state.moved || params.has("empty"))
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
              if (params.has("oversize")) {
                throw {
                  code: "limitExceeded",
                  message: "That item exceeds Postal Snap's safety limit.",
                  retryable: false,
                };
              }
              return {
                ...summary,
                to: ["sam@icloud.com"],
                cc: [],
                replyTo: null,
                textBody: "Are we still meeting on Saturday?",
                htmlBody: location.search.includes("threatLink")
                  ? '<p><a href="https://phish.example.test/login">Open site</a></p>'
                  : location.search.includes("webLink")
                    ? '<p><a href="https://library.example.test/hours">Open site</a></p>'
                    : location.search.includes("credentialLink")
                      ? '<p><a href="https://trusted.example@phish.example.test/login">Open site</a></p>'
                      : location.search.includes("remote")
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
                  : location.search.includes("previewable")
                    ? [
                        {
                          id: "attach-1",
                          filename: "family.png",
                          contentType: "image/png",
                          size: 128,
                          contentId: null,
                          inline: false,
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
            case "set_messages_flags": {
              const ids = (args.messageIds ?? []) as number[];
              if (args.isRead === true) summary.isRead = true;
              return { updated: ids.length, queued: 0, failed: 0 };
            }
            case "move_messages_to_mailbox":
              state.moved = true;
              return {
                updated: ((args.messageIds ?? []) as number[]).length,
                queued: 0,
                failed: 0,
              };
            case "mark_mailbox_read":
              summary.isRead = true;
              mailboxes[0].unreadCount = 0;
              return { updated: 1, queued: 0, failed: 0 };
            case "sync_account":
            case "release_compose_attachments":
              return undefined;
            case "create_folder": {
              const name = String(args.name);
              const id =
                Math.max(...mailboxes.map((mailbox) => mailbox.id)) + 1;
              mailboxes.push({
                id,
                accountId: account.id,
                name,
                displayName: name,
                role: "other",
                unreadCount: 0,
                totalCount: 0,
              });
              return undefined;
            }
            case "rename_folder": {
              const mailbox = mailboxes.find(
                (entry) => entry.id === Number(args.mailboxId),
              );
              if (mailbox) {
                mailbox.name = String(args.name);
                mailbox.displayName = String(args.name);
              }
              return undefined;
            }
            case "delete_folder": {
              const index = mailboxes.findIndex(
                (entry) => entry.id === Number(args.mailboxId),
              );
              if (index >= 0) mailboxes.splice(index, 1);
              return undefined;
            }
            case "empty_trash": {
              const trash = mailboxes.find((entry) => entry.role === "trash");
              if (trash) {
                trash.totalCount = 0;
                trash.unreadCount = 0;
              }
              return undefined;
            }
            case "empty_junk": {
              const junk = mailboxes.find((entry) => entry.role === "junk");
              if (junk) {
                junk.totalCount = 0;
                junk.unreadCount = 0;
              }
              return undefined;
            }
            case "save_draft":
              return { id: "draft-1", syncState: "localPending" };
            case "send_message":
              state.sentDraft = args.draft;
              return { id: "outbox-1", state: "sent", detail: null };
            case "choose_attachments":
              return [];
            case "preview_attachment":
              return {
                filename: "family.png",
                contentType: "image/png",
                size: 128,
                text: null,
                imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
              };
            case "suggest_recipients":
              return [
                {
                  address: "jane@example.com",
                  name: "Jane",
                  useCount: 3,
                },
              ];
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
                readingPane:
                  params.get("pane") ??
                  (location.search.includes("tallBottom") ? "bottom" : "right"),
                textScale: Number(params.get("scale") ?? 1),
                privateNotifications: false,
                theme: params.get("theme") ?? "system",
                density: params.get("density") ?? "comfortable",
                cachePolicy: {
                  mode: "recent",
                  days: 90,
                  maxBytes: 1_073_741_824,
                },
                lastAccountId: null,
                lastMailboxId: null,
                folderPaneWidth: params.has("oversized") ? 400 : 248,
                messagePaneWidth: params.has("oversized") ? 720 : 390,
                readerPaneHeight: location.search.includes("tallBottom")
                  ? 800
                  : 360,
                windowEffects: false,
                sidebarVisible: !params.has("hiddenSidebar"),
                undoSendSeconds: 10,
                blockAdvertisingAndTracking: true,
                blockReportedThreats: true,
                groupThreads: true,
                notifyNewMail: true,
                setupCompleted: location.search.includes("firstRun")
                  ? false
                  : true,
                setupStep: null,
              };
            case "supports_workspace_window_fx":
              return true;
            case "set_workspace_window_fx":
              return undefined;
            case "save_settings":
              state.savedSettings.push(args.settings);
              return args.settings;
            case "export_settings":
              state.exportedSettings += 1;
              return true;
            case "import_settings":
              state.importedSettings += 1;
              return {
                schemaVersion: 2,
                readingPane: "bottom",
                textScale: 1.15,
                privateNotifications: true,
                theme: "dark",
                density: "compact",
                cachePolicy: {
                  mode: "recent",
                  days: 90,
                  maxBytes: 1073741824,
                },
                lastAccountId: null,
                lastMailboxId: null,
                folderPaneWidth: 248,
                messagePaneWidth: 390,
                readerPaneHeight: 360,
                blockAdvertisingAndTracking: true,
                blockReportedThreats: true,
                groupThreads: true,
                notifyNewMail: true,
                setupCompleted: true,
                setupStep: null,
              };
            case "reset_settings":
              state.resetSettings += 1;
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
                  maxBytes: 1073741824,
                },
                lastAccountId: null,
                lastMailboxId: null,
                folderPaneWidth: 248,
                messagePaneWidth: 390,
                readerPaneHeight: 360,
                blockAdvertisingAndTracking: true,
                blockReportedThreats: true,
                groupThreads: true,
                notifyNewMail: true,
                setupCompleted: true,
                setupStep: null,
              };
            case "get_startup_notice":
              return null;
            case "get_startup_error":
              return location.search.includes("startupFail")
                ? "Postal Snap could not open saved accounts. Your mail data was not deleted. Restart Postal Snap to try again."
                : null;
            case "get_cache_usage":
              return { bytes: 0, maxBytes: 1_073_741_824, messageCount: 0 };
            case "get_distribution_channel":
              return { kind: "direct", updatesManagedBy: "postalSnap" };
            case "fetch_remote_image":
              state.remoteFetches += 1;
              if (location.search.includes("filterBlocked"))
                return { status: "blocked" };
              if (location.search.includes("threatBlocked"))
                return { status: "reportedThreat" };
              if (location.search.includes("imageFailed"))
                throw new Error("Image unavailable.");
              return {
                status: "loaded",
                dataUrl: "data:image/png;base64,iVBORw0KGgo=",
              };
            case "inspect_external_url": {
              const raw = String(args.url);
              let parsed: URL;
              try {
                parsed = new URL(raw);
              } catch {
                throw new Error("That link is not a valid web address.");
              }
              if (
                parsed.username ||
                parsed.password ||
                !/^https?:$/.test(parsed.protocol)
              ) {
                throw new Error(
                  "Postal Snap can only open ordinary web links.",
                );
              }
              return {
                url: parsed.href,
                hostname: parsed.hostname,
                reportedThreat: location.search.includes("threatLink"),
              };
            }
            case "open_external_url":
              state.openedUrls.push(String(args.url));
              return undefined;
            case "open_help_url":
              return undefined;
            case "read_message_inline_image":
              state.inlineReads += 1;
              return "data:image/png;base64,iVBORw0KGgo=";
            case "show_native_confirm":
              return window.confirm(
                `${String(args.title)}\n\n${String(args.message)}`,
              );
            case "show_native_message":
              window.alert(`${String(args.title)}\n\n${String(args.message)}`);
              return undefined;
            case "discover_account_aliases":
              (account as { aliases?: string[] }).aliases = [
                "alias1@icloud.com",
                "custom@mydomain.com",
              ];
              return { ...account };
            case "update_account_aliases":
              (account as { aliases?: string[] }).aliases =
                args.aliases as string[];
              return { ...account };
            case "relaunch_app":
              return undefined;
            default:
              return undefined;
          }
        },
      },
    });
  }, permissions);
}
