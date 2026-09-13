import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import type {
  AccountSetupRequest,
  AppSettings,
  ComposeDraft,
  FilterRule,
  SearchQuery,
} from "../types";

const mockedInvoke = vi.mocked(invoke);
const mockedListen = vi.mocked(listen);

const settings = (theme: AppSettings["theme"]): AppSettings => ({
  schemaVersion: 2,
  readingPane: "right",
  textScale: 1,
  privateNotifications: false,
  theme,
  density: "comfortable",
  cachePolicy: { mode: "recent", days: 90, maxBytes: 1_073_741_824 },
  lastAccountId: null,
  lastMailboxId: null,
  folderPaneWidth: 248,
  messagePaneWidth: 390,
  readerPaneHeight: 360,
  windowEffects: false,
  sidebarVisible: true,
  undoSendSeconds: 10,
  blockAdvertisingAndTracking: true,
  blockReportedThreats: true,
  groupThreads: true,
  notifyNewMail: true,
  setupCompleted: true,
  setupStep: null,
});

describe("settings IPC serialization", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedListen.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  it("runs settings mutations in invocation order", async () => {
    const calls: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mockedInvoke.mockImplementation(async (command) => {
      calls.push(String(command));
      if (command === "save_settings" && calls.length === 1) await firstBlocked;
      return command === "save_settings" ? settings("dark") : undefined;
    });

    const first = api.saveSettings(settings("dark"));
    const second = api.saveSettings(settings("light"));
    await vi.waitFor(() => expect(calls).toEqual(["save_settings"]));
    releaseFirst();
    await Promise.all([first, second]);

    expect(calls).toEqual(["save_settings", "save_settings"]);
  });

  it("does not let a save queued behind import overwrite imported preferences", async () => {
    const calls: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const imported = settings("light");
    mockedInvoke.mockImplementation(async (command) => {
      calls.push(String(command));
      if (command === "save_settings" && calls.length === 1) await firstBlocked;
      if (command === "import_settings") return imported;
      if (command === "get_settings") return imported;
      return settings("dark");
    });

    const firstSave = api.saveSettings(settings("dark"));
    await vi.waitFor(() => expect(calls).toEqual(["save_settings"]));
    const importPromise = api.importSettings();
    const saveAfterImportRequest = api.saveSettings(settings("dark"));
    releaseFirst();
    await Promise.all([firstSave, importPromise, saveAfterImportRequest]);

    expect(calls).toEqual(["save_settings", "import_settings", "get_settings"]);
  });

  it("keeps a pending save when the import dialog is canceled", async () => {
    const calls: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mockedInvoke.mockImplementation(async (command) => {
      calls.push(String(command));
      if (command === "save_settings" && calls.length === 1) await firstBlocked;
      if (command === "import_settings") return null;
      return settings("dark");
    });

    const firstSave = api.saveSettings(settings("dark"));
    await vi.waitFor(() => expect(calls).toEqual(["save_settings"]));
    const importPromise = api.importSettings();
    const pendingSave = api.saveSettings(settings("light"));
    releaseFirst();
    await Promise.all([firstSave, importPromise, pendingSave]);

    expect(calls).toEqual([
      "save_settings",
      "import_settings",
      "save_settings",
    ]);
  });

  it("dispatches multi-account management commands", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    await api.updateAccountDisplayName("acc-1", "Work Mail");
    expect(mockedInvoke).toHaveBeenCalledWith("update_account_display_name", {
      accountId: "acc-1",
      displayName: "Work Mail",
    });

    mockedInvoke.mockResolvedValue([
      { accountId: "acc-1", unreadCount: 2, totalCount: 10 },
    ]);
    const counts = await api.getAccountInboxCounts();
    expect(counts).toEqual([
      { accountId: "acc-1", unreadCount: 2, totalCount: 10 },
    ]);
    expect(mockedInvoke).toHaveBeenCalledWith("get_account_inbox_counts", {});

    mockedInvoke.mockResolvedValue([]);
    const mailboxes = await api.listAllMailboxes();
    expect(mailboxes).toEqual([]);
    expect(mockedInvoke).toHaveBeenCalledWith("list_all_mailboxes", {});

    mockedInvoke.mockResolvedValue(["acc-1", "acc-2"]);
    const synced = await api.syncAllAccounts();
    expect(synced).toEqual(["acc-1", "acc-2"]);
    expect(mockedInvoke).toHaveBeenCalledWith("sync_all_accounts", {});
  });

  it("omits confirmToken unless turning reported threats off", async () => {
    mockedInvoke.mockResolvedValue(settings("dark"));
    await api.saveSettings(settings("dark"));
    expect(mockedInvoke).toHaveBeenCalledWith("save_settings", {
      settings: settings("dark"),
    });

    mockedInvoke.mockClear();
    mockedInvoke.mockResolvedValue({
      ...settings("dark"),
      blockReportedThreats: false,
    });
    await api.saveSettings(
      { ...settings("dark"), blockReportedThreats: false },
      "CONFIRM",
    );
    expect(mockedInvoke).toHaveBeenCalledWith("save_settings", {
      settings: { ...settings("dark"), blockReportedThreats: false },
      confirmToken: "CONFIRM",
    });
  });

  it("maps every mail operation to its native command", async () => {
    mockedInvoke.mockResolvedValue(undefined);
    const request: AccountSetupRequest = {
      provider: "icloud",
      email: "sam@example.test",
      displayName: "Sam",
      password: "app-password",
    };
    const draft: ComposeDraft = {
      accountId: "acc",
      to: ["to@example.test"],
      cc: [],
      bcc: [],
      subject: "Subject",
      htmlBody: "<p>Body</p>",
      textBody: "Body",
      attachments: [],
    };
    const query: SearchQuery = {
      accountId: "acc",
      mailboxId: 1,
      text: "needle",
      allFolders: false,
      limit: 25,
    };
    const rule: FilterRule = {
      id: "rule",
      accountId: "acc",
      name: "Archive receipts",
      field: "subject",
      contains: "receipt",
      action: "move_archive",
      enabled: true,
    };
    const operations: Array<[string, () => Promise<unknown>]> = [
      ["list_accounts", () => api.listAccounts()],
      ["test_account", () => api.testAccount(request)],
      ["update_account_password", () => api.updateAccountPassword("acc", "pw")],
      ["add_account", () => api.addAccount(request)],
      ["remove_account", () => api.removeAccount("acc")],
      ["erase_all_data", () => api.eraseAllData()],
      [
        "update_account_display_name",
        () => api.updateAccountDisplayName("acc", "Name"),
      ],
      [
        "update_account_signature",
        () => api.updateAccountSignature("acc", "Sig"),
      ],
      ["list_mailboxes", () => api.listMailboxes("acc")],
      ["sync_account", () => api.syncAccount("acc")],
      ["list_messages", () => api.listMessages("acc", 1)],
      ["get_message", () => api.getMessage("acc", 10)],
      ["set_message_flags", () => api.setMessageFlags("acc", 10, true, false)],
      ["move_message", () => api.moveMessage("acc", 10, "archive")],
      ["move_message_to_mailbox", () => api.moveMessageToMailbox("acc", 10, 2)],
      [
        "set_messages_flags",
        () => api.setMessagesFlags("acc", [10], true, true),
      ],
      [
        "move_messages_to_mailbox",
        () => api.moveMessagesToMailbox("acc", [10], 2),
      ],
      ["mark_mailbox_read", () => api.markMailboxRead("acc", 1)],
      ["suggest_recipients", () => api.suggestRecipients("acc", "ja", 8)],
      ["create_folder", () => api.createFolder("acc", "Receipts")],
      ["rename_folder", () => api.renameFolder("acc", 2, "Archive")],
      ["delete_folder", () => api.deleteFolder("acc", 2)],
      ["empty_trash", () => api.emptyTrash("acc")],
      ["empty_junk", () => api.emptyJunk("acc")],
      ["search_cached_messages", () => api.searchCached(query)],
      ["search_server_messages", () => api.searchServer(query)],
      ["save_draft", () => api.saveDraft(draft)],
      ["list_drafts", () => api.listDrafts("acc")],
      ["get_draft", () => api.getDraft("draft", "acc")],
      ["delete_draft", () => api.deleteDraft("draft", "acc")],
      ["send_message", () => api.sendMessage(draft)],
      ["list_outbox", () => api.listOutbox("acc")],
      ["get_outbox", () => api.getOutbox("outbox", "acc")],
      ["restore_outbox", () => api.restoreOutbox("outbox", "acc")],
      ["retry_outbox", () => api.retryOutbox("outbox", "acc")],
      ["retry_sent_copy", () => api.retrySentCopy("outbox", "acc")],
      ["send_scheduled_outbox", () => api.sendScheduledOutbox("outbox", "acc")],
      [
        "snooze_message",
        () => api.snoozeMessage("acc", 10, "2026-09-15T10:00:00Z"),
      ],
      ["unsnooze_message", () => api.unsnoozeMessage("acc", 10)],
      ["list_snoozed", () => api.listSnoozed("acc")],
      ["list_filter_rules", () => api.listFilterRules("acc")],
      ["create_filter_rule", () => api.createFilterRule(rule)],
      ["update_filter_rule", () => api.updateFilterRule(rule)],
      ["delete_filter_rule", () => api.deleteFilterRule("acc", "rule")],
      ["delete_outbox", () => api.deleteOutbox("outbox", "acc")],
      [
        "save_attachment",
        () => api.saveAttachment("acc", 10, "attachment", "file.txt"),
      ],
      [
        "preview_attachment",
        () => api.previewAttachment("acc", 10, "attachment"),
      ],
      [
        "prepare_forward_attachments",
        () => api.prepareForwardAttachments("acc", 10),
      ],
      ["choose_attachments", () => api.chooseAttachments("acc", false)],
      [
        "fetch_remote_image",
        () => api.fetchRemoteImage("https://example.test/image.png"),
      ],
      [
        "inspect_external_url",
        () => api.inspectExternalUrl("https://example.test"),
      ],
      [
        "open_external_url",
        () => api.openExternalUrl("https://example.test", true),
      ],
      ["open_help_url", () => api.openHelpUrl()],
      [
        "read_message_inline_image",
        () => api.readMessageInlineImage("acc", 10, "attachment"),
      ],
      ["read_compose_image", () => api.readComposeImage("acc", "token")],
      [
        "release_compose_attachments",
        () => api.releaseComposeAttachments("acc", ["token"]),
      ],
      ["get_settings", () => api.getSettings()],
      ["set_mail_shortcut_guard", () => api.setMailShortcutGuard(true)],
      ["export_settings", () => api.exportSettings()],
      ["import_settings", () => api.importSettings()],
      ["get_startup_notice", () => api.getStartupNotice()],
      ["get_startup_error", () => api.getStartupError()],
      ["get_cache_usage", () => api.cacheUsage()],
      ["clear_downloaded_mail", () => api.clearCache()],
      ["get_distribution_channel", () => api.distribution()],
      ["discover_account_aliases", () => api.discoverAccountAliases("acc")],
      [
        "update_account_aliases",
        () => api.updateAccountAliases("acc", ["alias@example.test"]),
      ],
      ["show_native_confirm", () => api.showNativeConfirm("Title", "Message")],
      ["show_native_message", () => api.showNativeMessage("Title", "Message")],
      ["relaunch_app", () => api.relaunch()],
    ];

    for (const [command, operation] of operations) {
      mockedInvoke.mockClear();
      await operation();
      expect(mockedInvoke).toHaveBeenCalledWith(command, expect.any(Object));
    }
  });

  it("forwards every native event payload", async () => {
    const payloads = {
      "sync-state": { accountId: "acc", phase: "idle" },
      "folder-counts-changed": { accountId: "acc" },
      "message-changed": { accountId: "acc", messageId: 1, kind: "flags" },
      "draft-sync-changed": { accountId: "acc", draftId: "draft" },
      "outbox-changed": { accountId: "acc", outboxId: "outbox" },
      "menu-action": "compose",
      "app-warning": "warning",
    } as const;
    mockedListen.mockImplementation(((
      event: keyof typeof payloads,
      handler: (event: { payload: unknown }) => void,
    ) => {
      handler({ payload: payloads[event] });
      return Promise.resolve(vi.fn());
    }) as unknown as typeof listen);
    const handlers = Array.from({ length: 7 }, () => vi.fn());
    await api.onSyncState(handlers[0]);
    await api.onFolderCountsChanged(handlers[1]);
    await api.onMessageChanged(handlers[2]);
    await api.onDraftSyncChanged(handlers[3]);
    await api.onOutboxChanged(handlers[4]);
    await api.onMenuAction(handlers[5]);
    await api.onAppWarning(handlers[6]);

    expect(mockedListen.mock.calls.map((call) => call[0])).toEqual(
      Object.keys(payloads),
    );
    expect(handlers.map((handler) => handler.mock.calls[0][0])).toEqual(
      Object.values(payloads),
    );
  });

  it("uses safe browser fallbacks without invoking native services", async () => {
    delete (
      window as typeof window & {
        __TAURI_INTERNALS__?: unknown;
      }
    ).__TAURI_INTERNALS__;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);

    await expect(api.setMailShortcutGuard(true)).resolves.toBeUndefined();
    const unlisten = await api.onSyncState(vi.fn());
    unlisten();
    await expect(api.showNativeConfirm("Title", "Message")).resolves.toBe(true);
    await expect(
      api.showNativeMessage("Title", "Message"),
    ).resolves.toBeUndefined();
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    await expect(api.relaunch()).resolves.toBeUndefined();
    expect(reload).toHaveBeenCalled();
    await expect(api.listAccounts()).rejects.toThrow(
      /native service is unavailable/i,
    );
    expect(confirm).toHaveBeenCalledWith("Title\n\nMessage");
    expect(alert).toHaveBeenCalledWith("Title\n\nMessage");
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("keeps later settings writes after an earlier save fails", async () => {
    mockedInvoke
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(settings("light"));
    await expect(api.saveSettings(settings("dark"))).rejects.toThrow(
      /could not finish/i,
    );
    await expect(api.saveSettings(settings("light"))).resolves.toEqual(
      settings("light"),
    );
    expect(mockedInvoke).toHaveBeenCalledTimes(2);
  });
});
