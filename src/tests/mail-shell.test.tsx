import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { seedBody } from "../components/composer/composerSeed";
import { MailShell } from "../components/MailShell";
import { ContextMenuHost } from "../components/ContextMenu";
import { CONTEXT_ACTION_EVENT } from "../contextMenu";
import { formatMessageDate } from "../format";
import { strings } from "../i18n";
import { defaultSettings, useAppStore } from "../store";
import { applyPendingUpdate } from "../update";
import type {
  MessageChangeEvent,
  MessageSummary,
  SyncProgress,
} from "../types";
import { mockSaveSettingsPassthrough } from "./helpers/api-mocks";
import {
  makeAccount,
  makeMailbox,
  makeMessage,
  messageDetail as toDetail,
} from "./helpers/fixtures";
import { resetStore } from "./helpers/store";

vi.mock("../api", () => ({
  api: {
    beginUndoSession: vi.fn().mockResolvedValue("b".repeat(32)),
    listMailboxes: vi.fn(),
    listDrafts: vi.fn(),
    listOutbox: vi.fn(),
    listSnoozed: vi.fn().mockResolvedValue([]),
    listAccounts: vi.fn(),
    syncAccount: vi.fn(),
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    moveFolder: vi.fn(),
    deleteFolder: vi.fn(),
    getDraft: vi.fn(),
    saveDraft: vi.fn(),
    deleteDraft: vi.fn(),
    snoozeMessage: vi.fn(),
    snoozeMessages: vi.fn(),
    saveConversationAttachments: vi.fn(),
    saveMessagesEml: vi.fn(),
    unsnoozeMessage: vi.fn(),
    retryOutbox: vi.fn(),
    retrySentCopy: vi.fn(),
    sendScheduledOutbox: vi.fn(),
    deleteTrashMessages: vi.fn(),
    emptyTrash: vi.fn(),
    emptyJunk: vi.fn(),
    deleteOutbox: vi.fn(),
    restoreOutbox: vi.fn(),
    getOutbox: vi.fn(),
    listMessages: vi.fn(),
    getMessage: vi.fn(),
    findCachedMessage: vi.fn().mockResolvedValue(null),
    setMessageFlags: vi.fn(),
    setMessagesFlags: vi.fn(),
    setMessagesPinned: vi.fn(),
    moveMessagesToMailbox: vi.fn(),
    moveMessageToMailbox: vi.fn(),
    copyMessagesToMailbox: vi.fn(),
    markMailboxRead: vi.fn(),
    moveMessage: vi.fn().mockRejectedValue(new Error("move unavailable")),
    listFilterRules: vi.fn().mockResolvedValue([]),
    createFilterRule: vi.fn(),
    muteConversation: vi.fn().mockResolvedValue([]),
    unmuteConversation: vi.fn().mockResolvedValue(undefined),
    searchCached: vi.fn(),
    listRecentSearches: vi.fn().mockResolvedValue([]),
    rememberSearch: vi.fn().mockResolvedValue([]),
    forgetRecentSearches: vi.fn().mockResolvedValue(undefined),
    searchServer: vi.fn(),
    saveSettings: vi.fn(),
    onFolderCountsChanged: vi.fn(),
    onMessageChanged: vi.fn(),
    onSyncProgress: vi.fn(),
    onFrameLink: vi.fn().mockResolvedValue(() => undefined),
    onDraftSyncChanged: vi.fn().mockResolvedValue(() => undefined),
    onOutboxChanged: vi.fn().mockResolvedValue(() => undefined),
    onOfflineOperationsDropped: vi.fn().mockResolvedValue(() => undefined),
    showNativeConfirm: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock("../update", () => ({
  applyPendingUpdate: vi.fn().mockResolvedValue(undefined),
  holdBackgroundUpdate: vi.fn(() => () => undefined),
}));

const account = makeAccount();

const inbox = makeMailbox();

const trash = makeMailbox({
  id: 3,
  name: "Trash",
  displayName: "Trash",
  role: "trash",
  unreadCount: 0,
  totalCount: 0,
});

const firstMessage: MessageSummary = makeMessage();

const secondMessage: MessageSummary = makeMessage({
  id: 2,
  uid: 2,
  messageId: "<second@example.test>",
  subject: "Second message",
  preview: "Second preview",
});

const messages = [firstMessage, secondMessage];

const mockedListMailboxes = vi.mocked(api.listMailboxes);
const mockedListDrafts = vi.mocked(api.listDrafts);
const mockedListOutbox = vi.mocked(api.listOutbox);
const mockedListSnoozed = vi.mocked(api.listSnoozed);
const mockedListAccounts = vi.mocked(api.listAccounts);
const mockedSyncAccount = vi.mocked(api.syncAccount);
const mockedCreateFolder = vi.mocked(api.createFolder);
const mockedRenameFolder = vi.mocked(api.renameFolder);
const mockedDeleteFolder = vi.mocked(api.deleteFolder);
const mockedGetDraft = vi.mocked(api.getDraft);
const mockedSaveDraft = vi.mocked(api.saveDraft);
const mockedUnsnoozeMessage = vi.mocked(api.unsnoozeMessage);
const mockedListMessages = vi.mocked(api.listMessages);
const mockedGetMessage = vi.mocked(api.getMessage);
const mockedSetMessageFlags = vi.mocked(api.setMessageFlags);
const mockedSetMessagesFlags = vi.mocked(api.setMessagesFlags);
const mockedMoveMessagesToMailbox = vi.mocked(api.moveMessagesToMailbox);
const mockedCopyMessagesToMailbox = vi.mocked(api.copyMessagesToMailbox);
const mockedMarkMailboxRead = vi.mocked(api.markMailboxRead);
const mockedSearchCached = vi.mocked(api.searchCached);
const mockedSearchServer = vi.mocked(api.searchServer);
const mockedSaveSettings = vi.mocked(api.saveSettings);
const mockedOnFolderCountsChanged = vi.mocked(api.onFolderCountsChanged);
const mockedOnMessageChanged = vi.mocked(api.onMessageChanged);

function detail(summary: MessageSummary) {
  return toDetail(summary);
}

function renderShell(onOpenSettings = vi.fn()) {
  return render(
    <>
      <ContextMenuHost />
      <MailShell onOpenSettings={onOpenSettings} />
    </>,
  );
}

function switchToAccount(accountId: string) {
  const account = useAppStore
    .getState()
    .accounts.find((item) => item.id === accountId);
  if (!account) throw new Error(`Missing account ${accountId}`);
  fireEvent.click(document.querySelector(".account-switcher-trigger")!);
  fireEvent.click(
    screen.getByRole("menuitemradio", {
      name: new RegExp(account.displayName || account.email, "i"),
    }),
  );
}

function messageDragTransfer() {
  const stored = new Map<string, string>();
  return {
    effectAllowed: "move",
    dropEffect: "none",
    types: ["application/x-postal-snap-messages"],
    setData(type: string, value: string) {
      stored.set(type, value);
    },
    getData(type: string) {
      return stored.get(type) ?? "";
    },
  };
}

describe("mail shell", () => {
  beforeEach(() => {
    document
      .querySelectorAll("iframe, .print-host")
      .forEach((node) => node.remove());
    vi.clearAllMocks();
    mockedSaveSettings.mockImplementation(async (next) => next);
    resetStore({
      accounts: [account],
      activeAccountId: account.id,
      mailboxes: [inbox, trash],
      activeMailboxId: inbox.id,
    });
    mockedListMailboxes.mockResolvedValue([inbox, trash]);
    mockedListDrafts.mockResolvedValue([]);
    mockedListOutbox.mockResolvedValue([]);
    mockedListSnoozed.mockResolvedValue([]);
    mockedListAccounts.mockResolvedValue([account]);
    mockedSyncAccount.mockResolvedValue(undefined);
    mockedCreateFolder.mockResolvedValue(undefined);
    mockedRenameFolder.mockResolvedValue(undefined);
    mockedDeleteFolder.mockResolvedValue(undefined);
    mockedGetDraft.mockRejectedValue(new Error("draft missing"));
    mockedListMessages.mockResolvedValue({
      items: messages,
      nextCursor: null,
      hasMore: false,
    });
    mockedGetMessage.mockImplementation(async (_accountId, messageId) => {
      const summary = messages.find((item) => item.id === messageId);
      if (!summary) throw new Error("message missing");
      return detail(summary);
    });
    mockedSetMessageFlags.mockResolvedValue(undefined);
    vi.mocked(api.moveMessage).mockRejectedValue(new Error("move unavailable"));
    vi.mocked(api.listFilterRules).mockResolvedValue([]);
    vi.mocked(api.createFilterRule).mockResolvedValue({
      id: "rule-1",
      accountId: "account-1",
      name: "Block sender",
      field: "from",
      contains: "jane@example.test",
      action: "move_junk",
      enabled: true,
    });
    vi.mocked(api.muteConversation).mockResolvedValue([]);
    vi.mocked(api.unmuteConversation).mockResolvedValue(undefined);
    mockSaveSettingsPassthrough();
    mockedOnFolderCountsChanged.mockResolvedValue(() => undefined);
    mockedOnMessageChanged.mockResolvedValue(() => undefined);
    vi.mocked(api.onSyncProgress).mockResolvedValue(() => undefined);
    mockedSearchCached.mockResolvedValue([]);
  });

  it("shows how much mail is downloading", async () => {
    let report: ((progress: SyncProgress) => void) | undefined;
    vi.mocked(api.onSyncProgress).mockImplementation(async (handler) => {
      report = handler;
      return () => undefined;
    });
    resetStore({
      activeMailboxId: inbox.id,
      sync: {
        "account-1": { accountId: "account-1", phase: "syncing" },
      },
    });
    renderShell();
    await screen.findByRole("option", { name: /First message/i });
    act(() => {
      report?.({
        accountId: "account-1",
        envelopesDone: 3,
        envelopesTotal: 10,
        bodiesDone: 0,
        bodiesTotal: 0,
        backfilling: true,
      });
    });
    expect(await screen.findByText("Downloading 3 of 10")).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "3");
  });

  it("hides the first line of each message when previews are off", async () => {
    resetStore({
      activeMailboxId: inbox.id,
      settings: { ...defaultSettings, showMessagePreviews: false },
      messages: [firstMessage],
    });
    mockedListMessages.mockResolvedValue({
      items: [firstMessage],
      nextCursor: null,
      hasMore: false,
    });
    renderShell();
    const row = await screen.findByRole("option", { name: /First message/i });
    expect(row).toHaveTextContent("First message");
    expect(row).not.toHaveTextContent("First preview");
  });

  it("lists the mailbox oldest first and can return to newest", async () => {
    const newer = makeMessage({
      id: 1,
      subject: "Newer note",
      receivedAt: "2026-08-18T12:00:00Z",
    });
    const older = makeMessage({
      id: 2,
      subject: "Older note",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockImplementation(async (...args: unknown[]) => ({
      items: args[5] === "dateOldest" ? [older, newer] : [newer, older],
      nextCursor: null,
      hasMore: false,
    }));
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("option", { name: /Newer note/i });
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Newer note");
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: strings.mail.sortOldest }),
    );

    await waitFor(() =>
      expect(screen.getAllByRole("option")[0]).toHaveTextContent("Older note"),
    );
    expect(mockedListMessages).toHaveBeenCalledWith(
      "account-1",
      inbox.id,
      undefined,
      100,
      undefined,
      "dateOldest",
    );
    expect(screen.getAllByRole("option")[1]).toHaveTextContent("Newer note");

    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: strings.mail.sortDate }),
    );
    await waitFor(() =>
      expect(screen.getAllByRole("option")[0]).toHaveTextContent("Newer note"),
    );
  });

  it("opens with the saved mailbox order and stores a new choice", async () => {
    const newer = makeMessage({
      id: 1,
      subject: "Newer note",
      receivedAt: "2026-08-18T12:00:00Z",
    });
    const older = makeMessage({
      id: 2,
      subject: "Older note",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockImplementation(async (...args: unknown[]) => ({
      items: args[5] === "dateOldest" ? [older, newer] : [newer, older],
      nextCursor: null,
      hasMore: false,
    }));
    resetStore({
      activeMailboxId: inbox.id,
      settings: {
        ...defaultSettings,
        mailboxSort: "dateOldest",
        mailboxFilter: "unread",
      },
    });
    renderShell();

    await waitFor(() =>
      expect(mockedListMessages).toHaveBeenCalledWith(
        "account-1",
        inbox.id,
        undefined,
        100,
        "unread",
        "dateOldest",
      ),
    );
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Older note");
    expect(screen.getByRole("radio", { name: "Unread" })).toBeChecked();

    fireEvent.click(screen.getByRole("radio", { name: "All" }));
    await waitFor(() =>
      expect(mockedSaveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          mailboxViews: [
            expect.objectContaining({
              accountId: "account-1",
              mailboxId: inbox.id,
              filter: "all",
            }),
          ],
        }),
      ),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: strings.mail.sortDate }),
    );
    await waitFor(() =>
      expect(mockedSaveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          mailboxViews: [
            expect.objectContaining({
              accountId: "account-1",
              mailboxId: inbox.id,
              sort: "date",
              filter: "all",
            }),
          ],
        }),
      ),
    );
  });

  it("lists subjects from Z to A and can return to A to Z", async () => {
    const alpha = makeMessage({ id: 1, subject: "Alpha note" });
    const zoo = makeMessage({ id: 2, subject: "Zoo note" });
    mockedListMessages.mockImplementation(async (...args: unknown[]) => ({
      items: args[5] === "subjectDesc" ? [zoo, alpha] : [alpha, zoo],
      nextCursor: null,
      hasMore: false,
    }));
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("option", { name: /Alpha note/i });
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: strings.mail.sortSubject }),
    );
    await waitFor(() =>
      expect(mockedListMessages).toHaveBeenCalledWith(
        "account-1",
        inbox.id,
        undefined,
        100,
        undefined,
        "subject",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", {
        name: strings.mail.sortDescending,
      }),
    );
    await waitFor(() =>
      expect(screen.getAllByRole("option")[0]).toHaveTextContent("Zoo note"),
    );
    expect(screen.getAllByRole("option")[1]).toHaveTextContent("Alpha note");
    expect(mockedListMessages).toHaveBeenCalledWith(
      "account-1",
      inbox.id,
      undefined,
      100,
      undefined,
      "subjectDesc",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: strings.mail.sortSubject }),
    );
    await waitFor(() =>
      expect(screen.getAllByRole("option")[0]).toHaveTextContent("Alpha note"),
    );
  });

  it("copies message text from the list without opening it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderShell();
    await screen.findByRole("option", { name: /First message/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "copy-message-text",
          target: { kind: "message", messageId: firstMessage.id },
        },
      }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(firstMessage.preview),
    );
    expect(
      screen.queryByRole("heading", { name: "First message" }),
    ).not.toBeInTheDocument();
  });

  it("copies a loaded conversation without opening it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const newer = makeMessage({
      id: 1,
      threadRoot: "<thread@example.test>",
      subject: "Newer note",
    });
    const older = makeMessage({
      id: 2,
      threadRoot: "<thread@example.test>",
      subject: "Older note",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    mockedGetMessage.mockImplementation(async (_accountId, id) => {
      const summary = id === older.id ? older : newer;
      return toDetail(summary, {
        textBody: `${summary.subject} body`,
        htmlBody: `<p>${summary.subject}</p><script>alert(1)</script>`,
      });
    });
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("treeitem", { name: /Newer note/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "copy-conversation-text",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );

    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const copied = String(writeText.mock.calls[0]?.[0]);
    expect(copied.indexOf("Older note")).toBeLessThan(
      copied.indexOf("Newer note"),
    );
    expect(copied).not.toContain("alert(1)");
    expect(
      screen.queryByRole("heading", { name: "Newer note" }),
    ).not.toBeInTheDocument();
  });

  it("blocks a sender by filing later mail to Junk", async () => {
    vi.mocked(api.showNativeConfirm).mockResolvedValueOnce(false);
    vi.mocked(api.moveMessage).mockResolvedValue(undefined);
    vi.mocked(api.createFilterRule).mockImplementation(async (rule) => ({
      ...rule,
      id: "rule-1",
    }));
    renderShell();
    fireEvent.click(
      await screen.findByRole("option", { name: /First message/i }),
    );
    expect(
      await screen.findByRole("heading", { name: "First message" }),
    ).toBeVisible();
    window.dispatchEvent(
      new CustomEvent("postal:menu-action", { detail: "block-sender" }),
    );
    await waitFor(() =>
      expect(api.showNativeConfirm).toHaveBeenCalledWith(
        strings.reader.blockSender,
        strings.reader.blockSenderQuestion,
      ),
    );
    expect(api.createFilterRule).not.toHaveBeenCalled();
    expect(api.moveMessage).not.toHaveBeenCalled();

    vi.mocked(api.showNativeConfirm).mockResolvedValueOnce(true);
    window.dispatchEvent(
      new CustomEvent("postal:menu-action", { detail: "block-sender" }),
    );
    await waitFor(() =>
      expect(api.createFilterRule).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "account-1",
          field: "from",
          contains: "jane@example.test",
          action: "move_junk",
          enabled: true,
        }),
      ),
    );
    expect(api.moveMessage).toHaveBeenCalledWith(
      "account-1",
      firstMessage.id,
      "junk",
      expect.any(String),
    );
  });

  it("mutes a conversation and files the open message", async () => {
    vi.mocked(api.showNativeConfirm).mockResolvedValueOnce(false);
    vi.mocked(api.muteConversation).mockResolvedValue([firstMessage.id]);
    renderShell();
    fireEvent.click(
      await screen.findByRole("option", { name: /First message/i }),
    );
    expect(
      await screen.findByRole("heading", { name: "First message" }),
    ).toBeVisible();
    window.dispatchEvent(
      new CustomEvent("postal:menu-action", { detail: "mute-conversation" }),
    );
    await waitFor(() =>
      expect(api.showNativeConfirm).toHaveBeenCalledWith(
        strings.reader.muteConversation,
        strings.reader.muteConversationQuestion,
      ),
    );
    expect(api.muteConversation).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "First message" }),
    ).toBeVisible();

    vi.mocked(api.showNativeConfirm).mockResolvedValueOnce(true);
    window.dispatchEvent(
      new CustomEvent("postal:menu-action", { detail: "mute-conversation" }),
    );
    await waitFor(() =>
      expect(api.muteConversation).toHaveBeenCalledWith(
        "account-1",
        firstMessage.id,
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "First message" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("unmutes a conversation without moving the message", async () => {
    mockedGetMessage.mockImplementation(async (_accountId, messageId) => {
      const summary = messages.find((item) => item.id === messageId);
      if (!summary) throw new Error("message missing");
      return { ...detail(summary), conversationMuted: true };
    });
    renderShell();
    fireEvent.click(
      await screen.findByRole("option", { name: /First message/i }),
    );
    expect(
      await screen.findByRole("heading", { name: "First message" }),
    ).toBeVisible();
    window.dispatchEvent(
      new CustomEvent("postal:menu-action", { detail: "mute-conversation" }),
    );
    await waitFor(() =>
      expect(api.unmuteConversation).toHaveBeenCalledWith(
        "account-1",
        firstMessage.id,
      ),
    );
    expect(api.muteConversation).not.toHaveBeenCalled();
    expect(api.showNativeConfirm).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "First message" }),
    ).toBeVisible();
  });

  it("does not add a second Junk rule for the same sender", async () => {
    vi.mocked(api.showNativeConfirm).mockResolvedValue(true);
    vi.mocked(api.moveMessage).mockResolvedValue(undefined);
    vi.mocked(api.listFilterRules).mockResolvedValue([
      {
        id: "rule-1",
        accountId: "account-1",
        name: "Block sender",
        field: "from",
        contains: "Jane@Example.test",
        action: "move_junk",
        enabled: true,
      },
    ]);
    renderShell();
    fireEvent.click(
      await screen.findByRole("option", { name: /First message/i }),
    );
    await screen.findByRole("heading", { name: "First message" });
    window.dispatchEvent(
      new CustomEvent("postal:menu-action", { detail: "block-sender" }),
    );
    await waitFor(() =>
      expect(api.moveMessage).toHaveBeenCalledWith(
        "account-1",
        firstMessage.id,
        "junk",
        expect.any(String),
      ),
    );
    expect(api.createFilterRule).not.toHaveBeenCalled();
  });

  it("opens the next and previous message from the reader", async () => {
    const older = makeMessage({
      id: 11,
      uid: 11,
      subject: "Older note",
      receivedAt: "2026-08-17T12:00:00Z",
      isRead: true,
    });
    const newer = makeMessage({
      id: 12,
      uid: 12,
      subject: "Newer note",
      receivedAt: "2026-08-18T12:00:00Z",
      isRead: true,
    });
    mockedListMessages.mockResolvedValue({
      items: [older, newer],
      nextCursor: null,
      hasMore: false,
    });
    mockedGetMessage.mockImplementation(async (_accountId, messageId) => {
      const summary = [older, newer].find((item) => item.id === messageId);
      if (!summary) throw new Error("message missing");
      return toDetail(summary);
    });
    renderShell();
    fireEvent.click(await screen.findByRole("option", { name: /Newer note/i }));
    expect(
      await screen.findByRole("heading", { name: "Newer note" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: strings.reader.previousMessage }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.nextMessage }),
    );
    expect(
      await screen.findByRole("heading", { name: "Older note" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.previousMessage }),
    );
    expect(
      await screen.findByRole("heading", { name: "Newer note" }),
    ).toBeVisible();
  });

  it("leaves an opened message unread until it is marked read", async () => {
    resetStore({
      settings: { ...defaultSettings, markRead: "manual" },
    });
    renderShell();
    await screen.findByRole("option", { name: /First message/i });
    fireEvent.click(screen.getByRole("option", { name: /First message/i }));
    expect(
      await screen.findByRole("heading", { name: "First message" }),
    ).toBeVisible();
    expect(mockedSetMessageFlags).not.toHaveBeenCalled();
  });

  it("keeps newer message selected when older read update finishes late", async () => {
    let releaseRead: () => void = () => undefined;
    const readPending = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    mockedSetMessageFlags.mockImplementation(
      async (_accountId, messageId, isRead) => {
        if (messageId === firstMessage.id && isRead) await readPending;
      },
    );

    renderShell();
    await screen.findByRole("option", { name: /First message/i });
    fireEvent.click(screen.getByRole("option", { name: /First message/i }));
    await screen.findByRole("heading", { name: "First message" });

    fireEvent.click(screen.getByRole("option", { name: /Second message/i }));
    await screen.findByRole("heading", { name: "Second message" });

    releaseRead();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Second message" }),
      ).toBeVisible(),
    );
  });

  it("offers a recent search and can clear it", async () => {
    const recent: string[] = [];
    vi.mocked(api.rememberSearch).mockImplementation(
      async (_accountId, query) => {
        const text = String(query).trim();
        const next = [
          text,
          ...recent.filter((item) => item.toLowerCase() !== text.toLowerCase()),
        ];
        recent.splice(0, recent.length, ...next);
        return next;
      },
    );
    mockedSearchCached.mockResolvedValue([]);
    mockedSearchServer.mockResolvedValue([]);
    renderShell();
    await screen.findByRole("option", { name: /First message/i });

    const search = screen.getByRole("searchbox", { name: "Search mail" });
    fireEvent.change(search, { target: { value: "Picnic" } });
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() =>
      expect(api.rememberSearch).toHaveBeenCalledWith("account-1", "Picnic"),
    );

    fireEvent.change(search, { target: { value: "" } });
    fireEvent.focus(search);
    fireEvent.click(screen.getByRole("menuitem", { name: "Picnic" }));
    await waitFor(() =>
      expect(mockedSearchCached).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Picnic" }),
      ),
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search mail" }), {
      target: { value: "" },
    });
    fireEvent.focus(screen.getByRole("searchbox", { name: "Search mail" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Clear recent searches" }),
    );
    expect(api.forgetRecentSearches).toHaveBeenCalledWith("account-1");
    expect(
      screen.queryByRole("menuitem", { name: "Picnic" }),
    ).not.toBeInTheDocument();
  });

  it("does not let stale search results replace a cleared mailbox", async () => {
    let releaseSearch: () => void = () => undefined;
    const searchPending = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    const staleResult = {
      ...firstMessage,
      subject: "Old search result",
    };
    mockedSearchServer.mockImplementation(async () => {
      await searchPending;
      return [staleResult];
    });

    renderShell();
    await screen.findByRole("option", { name: /First message/i });
    await waitFor(() => expect(mockedListMessages).toHaveBeenCalledTimes(1));

    const search = screen.getByRole("searchbox", { name: "Search mail" });
    fireEvent.change(search, { target: { value: "old" } });
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() => expect(mockedSearchServer).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(mockedListMessages).toHaveBeenCalledTimes(2));
    releaseSearch();

    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: /First message/i }),
      ).toBeVisible();
      expect(
        screen.queryByRole("option", { name: /Old search result/i }),
      ).toBeNull();
    });
  });

  it("still renders mailboxes when local draft data is damaged", async () => {
    mockedListDrafts.mockRejectedValue(new Error("damaged draft"));

    renderShell();

    expect(await screen.findByRole("button", { name: /^Inbox/ })).toBeVisible();
  });

  it("keeps toolbar actions named when labels collapse on narrow windows", async () => {
    renderShell();

    expect(
      await screen.findByRole("button", { name: "Get Mail" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Compose" })).toBeVisible();
  });

  it("exposes the message toolbar for keyboard navigation", async () => {
    renderShell();

    await screen.findByRole("option", { name: /First message/i });
    fireEvent.click(screen.getByRole("option", { name: /First message/i }));
    expect(
      await screen.findByRole("toolbar", { name: "Message actions" }),
    ).toBeVisible();
  });

  it("keeps oversize envelopes actionable instead of a dead end", async () => {
    mockedGetMessage.mockRejectedValueOnce(
      new Error("This message is too large to download safely."),
    );
    renderShell();

    await screen.findByRole("option", { name: /First message/i });
    fireEvent.click(screen.getByRole("option", { name: /First message/i }));
    expect(
      await screen.findByRole("heading", { name: "First message" }),
    ).toBeVisible();
  });

  it("selects every message between two shift-clicked rows", async () => {
    const third = makeMessage({
      id: 3,
      uid: 3,
      messageId: "<third@example.test>",
      subject: "Third message",
      preview: "Third preview",
    });
    mockedListMessages.mockResolvedValue({
      items: [...messages, third],
      nextCursor: null,
      hasMore: false,
    });
    renderShell();

    await screen.findByRole("option", { name: /Third message/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /First message/i }));
    fireEvent.click(screen.getByRole("option", { name: /Third message/i }), {
      shiftKey: true,
    });

    expect(
      screen.getByRole("checkbox", { name: /First message/i }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /Second message/i }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /Third message/i }),
    ).toBeChecked();

    fireEvent.click(screen.getByRole("option", { name: /Second message/i }), {
      shiftKey: true,
    });
    expect(
      screen.getByRole("checkbox", { name: /First message/i }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /Second message/i }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /Third message/i }),
    ).not.toBeChecked();
  });

  it("selects every loaded message", async () => {
    renderShell();

    await screen.findByRole("option", { name: /First message/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Select all" }));

    expect(
      screen.getByRole("checkbox", { name: /First message/i }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /Second message/i }),
    ).toBeChecked();
    expect(screen.getByRole("toolbar", { name: "2 selected" })).toBeVisible();
  });

  it("selects only the loaded unread messages", async () => {
    const read = makeMessage({
      id: 1,
      isRead: true,
      threadRoot: "<thread@example.test>",
      subject: "Read note",
    });
    const unread = makeMessage({
      id: 2,
      isRead: false,
      threadRoot: "<thread@example.test>",
      subject: "Unread note",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [read, unread],
      nextCursor: null,
      hasMore: false,
    });
    renderShell();

    await screen.findByRole("treeitem", { name: /Read note/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.contextMenu.selectUnread }),
    );

    expect(
      screen.getByRole("checkbox", { name: "Select Unread note" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Select Read note" }),
    ).not.toBeChecked();
    expect(screen.getByRole("toolbar", { name: "1 selected" })).toBeVisible();
  });

  it("disables select unread when every loaded message is read", async () => {
    mockedListMessages.mockResolvedValue({
      items: [
        makeMessage({ id: 1, isRead: true, subject: "Read note" }),
        makeMessage({ id: 2, isRead: true, subject: "Other note" }),
      ],
      nextCursor: null,
      hasMore: false,
    });
    renderShell();

    await screen.findByRole("option", { name: /Read note/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    expect(
      screen.getByRole("menuitem", { name: strings.contextMenu.selectUnread }),
    ).toBeDisabled();
  });

  it("snoozes the selected messages and opens the next one", async () => {
    const first = makeMessage({ id: 1, subject: "First note" });
    const keep = makeMessage({
      id: 2,
      subject: "Keep note",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    const third = makeMessage({
      id: 3,
      subject: "Third note",
      receivedAt: "2026-08-16T12:00:00Z",
    });
    const loaded = [first, keep, third];
    mockedListMessages.mockResolvedValue({
      items: loaded,
      nextCursor: null,
      hasMore: false,
    });
    mockedGetMessage.mockImplementation(async (_accountId, messageId) => {
      const summary = loaded.find((item) => item.id === messageId);
      if (!summary) throw new Error("message missing");
      return toDetail(summary);
    });
    vi.mocked(api.snoozeMessages).mockImplementation(async () => {
      mockedListMessages.mockResolvedValue({
        items: [keep],
        nextCursor: null,
        hasMore: false,
      });
    });
    renderShell();

    fireEvent.click(await screen.findByRole("option", { name: /First note/i }));
    await screen.findByRole("heading", { name: "First note" });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select First note" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Third note" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.mail.snoozeSelected }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.snoozeTomorrow }),
    );

    await waitFor(() =>
      expect(api.snoozeMessages).toHaveBeenCalledWith(
        "account-1",
        [1, 3],
        expect.any(String),
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "Keep note" }),
    ).toBeVisible();
    expect(screen.queryByRole("option", { name: /First note/i })).toBeNull();
    expect(screen.queryByRole("option", { name: /Third note/i })).toBeNull();
    expect(screen.getByRole("option", { name: /Keep note/i })).toBeVisible();
    expect(screen.queryByRole("toolbar", { name: /selected/i })).toBeNull();
  });

  it("leaves the selection in place when snooze fails", async () => {
    vi.mocked(api.snoozeMessages).mockRejectedValue(new Error("disk full"));
    renderShell();

    await screen.findByRole("option", { name: /First message/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /First message/i }));
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    expect(
      screen.getByRole("menuitem", { name: strings.mail.snoozeSelected }),
    ).toBeEnabled();
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.mail.snoozeSelected }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.snoozeTomorrow }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("Error: disk full"),
    );
    expect(
      screen.getByRole("checkbox", { name: /First message/i }),
    ).toBeChecked();
    expect(
      screen.getByRole("group", { name: strings.mail.snoozeSelected }),
    ).toBeVisible();
  });

  it("disables snooze until a message is selected", async () => {
    renderShell();
    await screen.findByRole("option", { name: /First message/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    expect(
      screen.getByRole("menuitem", { name: strings.mail.snoozeSelected }),
    ).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: strings.mail.pinSelected }),
    ).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: strings.mail.unpinSelected }),
    ).toBeDisabled();
  });

  it("pins the selected messages and leaves one that is already pinned out", async () => {
    const newer = makeMessage({
      id: 1,
      subject: "Newer note",
      receivedAt: "2026-08-18T12:00:00Z",
    });
    const middle = makeMessage({
      id: 2,
      subject: "Middle note",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    const older = makeMessage({
      id: 3,
      subject: "Older note",
      receivedAt: "2026-08-16T12:00:00Z",
      pinned: true,
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, middle, older],
      nextCursor: null,
      hasMore: false,
    });
    vi.mocked(api.setMessagesPinned).mockResolvedValue(1);
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("option", { name: /Newer note/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Middle note" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Older note" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    expect(
      screen.getByRole("menuitem", { name: strings.mail.unpinSelected }),
    ).toBeEnabled();
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.mail.pinSelected }),
    );

    await waitFor(() =>
      expect(api.setMessagesPinned).toHaveBeenCalledWith(
        "account-1",
        [2],
        true,
      ),
    );
    expect(screen.getAllByRole("option")[0]).toHaveAttribute(
      "aria-label",
      expect.stringMatching(/Pinned[\s\S]*Middle note/),
    );
    expect(screen.getAllByRole("option")[2]).toHaveAttribute(
      "aria-label",
      expect.stringMatching(/Newer note/),
    );
    expect(
      screen.getByRole("checkbox", { name: "Select Middle note" }),
    ).toBeChecked();
  });

  it("unpins the selected messages that are pinned", async () => {
    const newer = makeMessage({
      id: 1,
      subject: "Newer note",
      receivedAt: "2026-08-18T12:00:00Z",
    });
    const older = makeMessage({
      id: 2,
      subject: "Older note",
      receivedAt: "2026-08-17T12:00:00Z",
      pinned: true,
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    vi.mocked(api.setMessagesPinned).mockResolvedValue(1);
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("option", { name: /Pinned[\s\S]*Older note/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Older note" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Newer note" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    expect(
      screen.getByRole("menuitem", { name: strings.mail.pinSelected }),
    ).toBeEnabled();
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.mail.unpinSelected }),
    );

    await waitFor(() =>
      expect(api.setMessagesPinned).toHaveBeenCalledWith(
        "account-1",
        [2],
        false,
      ),
    );
    expect(screen.getAllByRole("option")[0]).toHaveAttribute(
      "aria-label",
      expect.stringMatching(/Newer note/),
    );
    expect(
      useAppStore.getState().messages.find((item) => item.id === 2)?.pinned,
    ).toBe(false);
  });

  it("leaves the selection unpinned when the pin cannot be saved", async () => {
    const newer = makeMessage({
      id: 1,
      subject: "Newer note",
      receivedAt: "2026-08-18T12:00:00Z",
    });
    const older = makeMessage({
      id: 2,
      subject: "Older note",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    vi.mocked(api.setMessagesPinned).mockRejectedValue(new Error("disk full"));
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("option", { name: /Newer note/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Older note" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.mail.pinSelected }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("Error: disk full"),
    );
    expect(screen.getAllByRole("option")[0]).toHaveAttribute(
      "aria-label",
      expect.stringMatching(/Newer note/),
    );
    expect(
      useAppStore.getState().messages.find((item) => item.id === 2)?.pinned,
    ).toBe(false);
    expect(
      screen.getByRole("checkbox", { name: "Select Older note" }),
    ).toBeChecked();
  });

  it("moves a loaded conversation to junk", async () => {
    const junk = makeMailbox({
      id: 5,
      name: "Junk",
      displayName: "Junk",
      role: "junk",
      unreadCount: 0,
      totalCount: 0,
    });
    const newer = makeMessage({
      id: 1,
      isRead: false,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      isRead: true,
      threadRoot: "<thread@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    const other = makeMessage({ id: 3, isRead: true, subject: "Other note" });
    mockedListMailboxes.mockResolvedValue([inbox, trash, junk]);
    mockedListMessages.mockResolvedValue({
      items: [newer, older, other],
      nextCursor: null,
      hasMore: false,
    });
    mockedMoveMessagesToMailbox.mockResolvedValue({
      updated: 2,
      queued: 0,
      failed: 0,
    });
    resetStore({
      mailboxes: [inbox, trash, junk],
      activeMailboxId: inbox.id,
    });
    renderShell();

    await screen.findByRole("treeitem", { name: /First message/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "junk-conversation",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );

    await waitFor(() =>
      expect(mockedMoveMessagesToMailbox).toHaveBeenCalledWith(
        "account-1",
        [1, 2],
        5,
        expect.any(String),
      ),
    );
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual([3]);
    expect(mockedGetMessage).not.toHaveBeenCalled();
  });

  it("opens the older and newer message in the loaded conversation", async () => {
    const newer = makeMessage({
      id: 1,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      threadRoot: "<thread@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    mockedGetMessage.mockImplementation(async (_accountId, messageId) => {
      const summary = [newer, older].find((item) => item.id === messageId);
      if (!summary) throw new Error("message missing");
      return detail(summary);
    });
    renderShell();
    fireEvent.click(
      await screen.findByRole("treeitem", { name: /First message/i }),
    );
    expect(
      await screen.findByRole("heading", { name: "First message" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    expect(
      screen.queryByRole("menuitem", {
        name: strings.reader.newerInConversation,
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.olderInConversation,
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Second message" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.newerInConversation,
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "First message" }),
    ).toBeVisible();
  });

  it("opens the unread message in the loaded conversation", async () => {
    const newer = makeMessage({
      id: 1,
      threadRoot: "<thread@example.test>",
      isRead: true,
    });
    const older = makeMessage({
      id: 2,
      subject: "Unread family note",
      threadRoot: "<thread@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
      isRead: false,
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    mockedGetMessage.mockImplementation(async (_accountId, messageId) => {
      const summary = [newer, older].find((item) => item.id === messageId);
      if (!summary) throw new Error("message missing");
      return detail(summary);
    });
    renderShell();
    fireEvent.click(
      await screen.findByRole("treeitem", {
        name: /Conversation.*First message/i,
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "First message" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.unreadInConversation,
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Unread family note" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    expect(
      screen.queryByRole("menuitem", {
        name: strings.reader.unreadInConversation,
      }),
    ).not.toBeInTheDocument();
  });

  it("selects every loaded message in a conversation", async () => {
    const newer = makeMessage({
      id: 1,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      threadRoot: "<thread@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    const other = makeMessage({ id: 3, subject: "Other note" });
    mockedListMessages.mockResolvedValue({
      items: [newer, older, other],
      nextCursor: null,
      hasMore: false,
    });
    renderShell();

    await screen.findByRole("treeitem", { name: /First message/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "select-conversation",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: /First message/i }),
      ).toBeChecked(),
    );
    expect(
      screen.getByRole("checkbox", { name: /Second message/i }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /Other note/i }),
    ).not.toBeChecked();
    expect(screen.getByRole("toolbar", { name: "2 selected" })).toBeVisible();
    expect(mockedGetMessage).not.toHaveBeenCalled();
  });

  it("selects loaded messages from the same sender", async () => {
    const jane = makeMessage({ id: 1, subject: "Weekend plans" });
    const janeAgain = makeMessage({
      id: 2,
      subject: "Saturday note",
      senderAddress: "Jane@Example.test",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    const morgan = makeMessage({
      id: 3,
      subject: "Library hours",
      senderAddress: "morgan@fastmail.com",
      senderName: "Morgan",
    });
    mockedListMessages.mockResolvedValue({
      items: [jane, janeAgain, morgan],
      nextCursor: null,
      hasMore: false,
    });
    renderShell();

    await screen.findByRole("option", { name: /Weekend plans/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "select-from-sender",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: /Weekend plans/i }),
      ).toBeChecked(),
    );
    expect(
      screen.getByRole("checkbox", { name: /Saturday note/i }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /Library hours/i }),
    ).not.toBeChecked();
    expect(screen.getByRole("toolbar", { name: "2 selected" })).toBeVisible();
    expect(mockedGetMessage).not.toHaveBeenCalled();
  });

  it("opens an earlier message stored in another folder", async () => {
    const current = makeMessage({
      id: 1,
      subject: "Weekend plans",
      messageId: "<weekend@example.test>",
    });
    const earlier = makeMessage({
      id: 2,
      mailboxId: trash.id,
      subject: "Earlier note",
      messageId: "<parent@example.test>",
      isRead: true,
    });
    mockedListMessages.mockImplementation(async (_accountId, mailboxId) => ({
      items: mailboxId === trash.id ? [earlier] : [current],
      nextCursor: null,
      hasMore: false,
    }));
    mockedGetMessage.mockImplementation(async (_accountId, messageId) => ({
      ...detail(messageId === earlier.id ? earlier : current),
      references: messageId === current.id ? ["<parent@example.test>"] : [],
    }));
    vi.mocked(api.findCachedMessage).mockResolvedValue(earlier);
    renderShell();

    fireEvent.click(
      await screen.findByRole("option", { name: /Weekend plans/i }),
    );
    await screen.findByRole("heading", { name: "Weekend plans" });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "open-earlier",
          target: { kind: "message", messageId: current.id },
        },
      }),
    );

    expect(
      await screen.findByRole("heading", { name: "Earlier note" }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Trash" })).toBeVisible();
    expect(api.findCachedMessage).toHaveBeenCalledWith(
      "account-1",
      "<parent@example.test>",
    );
  });

  it("marks a loaded conversation read without opening it", async () => {
    const newer = makeMessage({
      id: 1,
      isRead: false,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      isRead: false,
      threadRoot: "<thread@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    mockedSetMessagesFlags.mockResolvedValue({
      updated: 2,
      queued: 0,
      failed: 0,
    });
    renderShell();

    await screen.findByRole("treeitem", { name: /First message/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "mark-conversation-read",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );

    await waitFor(() =>
      expect(mockedSetMessagesFlags).toHaveBeenCalledWith(
        "account-1",
        [1, 2],
        true,
        undefined,
      ),
    );
    expect(mockedGetMessage).not.toHaveBeenCalled();
    expect(useAppStore.getState().messages.every((item) => item.isRead)).toBe(
      true,
    );
    expect(
      useAppStore.getState().mailboxes.find((mailbox) => mailbox.id === 1)
        ?.unreadCount,
    ).toBe(0);
  });

  it("archives a loaded conversation without opening it", async () => {
    const archive = makeMailbox({
      id: 4,
      name: "Archive",
      displayName: "Archive",
      role: "archive",
      unreadCount: 0,
      totalCount: 0,
    });
    const newer = makeMessage({
      id: 1,
      isRead: false,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      isRead: true,
      threadRoot: "<thread@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    const other = makeMessage({ id: 3, isRead: true, subject: "Other note" });
    mockedListMailboxes.mockResolvedValue([inbox, trash, archive]);
    mockedListMessages.mockResolvedValue({
      items: [newer, older, other],
      nextCursor: null,
      hasMore: false,
    });
    mockedMoveMessagesToMailbox.mockResolvedValue({
      updated: 2,
      queued: 0,
      failed: 0,
    });
    resetStore({
      mailboxes: [inbox, trash, archive],
      activeMailboxId: inbox.id,
    });
    renderShell();

    await screen.findByRole("treeitem", { name: /First message/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "archive-conversation",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );

    await waitFor(() =>
      expect(mockedMoveMessagesToMailbox).toHaveBeenCalledWith(
        "account-1",
        [1, 2],
        4,
        expect.any(String),
      ),
    );
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual([3]);
    expect(mockedGetMessage).not.toHaveBeenCalled();
    const boxes = useAppStore.getState().mailboxes;
    expect(boxes.find((mailbox) => mailbox.id === 1)?.totalCount).toBe(0);
    expect(boxes.find((mailbox) => mailbox.id === 4)?.totalCount).toBe(2);
  });

  it("saves files from a loaded conversation without opening it", async () => {
    const newer = makeMessage({
      id: 1,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      threadRoot: "<thread@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
      hasAttachments: true,
    });
    const other = makeMessage({ id: 3, subject: "Other note" });
    mockedListMessages.mockResolvedValue({
      items: [newer, older, other],
      nextCursor: null,
      hasMore: false,
    });
    vi.mocked(api.saveConversationAttachments).mockResolvedValue(2);
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("treeitem", { name: /First message/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "save-conversation-files",
          target: { kind: "message", messageId: 3 },
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "save-conversation-files",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );

    await waitFor(() =>
      expect(api.saveConversationAttachments).toHaveBeenCalledWith(
        "account-1",
        [1, 2],
      ),
    );
    expect(api.saveConversationAttachments).toHaveBeenCalledTimes(1);
    expect(mockedGetMessage).not.toHaveBeenCalled();
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual([
      1, 2, 3,
    ]);
  });

  it("saves files from the selected messages that have them", async () => {
    const withFile = makeMessage({
      id: 1,
      subject: "With file",
      hasAttachments: true,
    });
    const plain = makeMessage({ id: 2, subject: "Plain note" });
    const otherFile = makeMessage({
      id: 3,
      subject: "Other file",
      hasAttachments: true,
    });
    mockedListMessages.mockResolvedValue({
      items: [withFile, plain, otherFile],
      nextCursor: null,
      hasMore: false,
    });
    vi.mocked(api.saveConversationAttachments).mockResolvedValue(2);
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("option", { name: /With file/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select With file" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Plain note" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.saveSelectedFiles }),
    );

    await waitFor(() =>
      expect(api.saveConversationAttachments).toHaveBeenCalledWith(
        "account-1",
        [1],
      ),
    );
    expect(
      screen.getByRole("checkbox", { name: "Select With file" }),
    ).toBeChecked();
    expect(useAppStore.getState().messages).toHaveLength(3);
  });

  it("disables save selected files until a checked message has a file", async () => {
    renderShell();
    await screen.findByRole("option", { name: /First message/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    expect(
      screen.getByRole("menuitem", { name: strings.reader.saveSelectedFiles }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select First message" }),
    );
    expect(
      screen.getByRole("menuitem", { name: strings.reader.saveSelectedFiles }),
    ).toBeDisabled();
  });

  it("leaves the selection in place when selected files cannot be saved", async () => {
    const withFile = makeMessage({
      id: 1,
      subject: "With file",
      hasAttachments: true,
    });
    mockedListMessages.mockResolvedValue({
      items: [withFile],
      nextCursor: null,
      hasMore: false,
    });
    vi.mocked(api.saveConversationAttachments).mockRejectedValue(
      new Error("disk full"),
    );
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("option", { name: /With file/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select With file" }));
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.saveSelectedFiles }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("Error: disk full"),
    );
    expect(
      screen.getByRole("checkbox", { name: "Select With file" }),
    ).toBeChecked();
  });

  it("saves the selected messages as eml files and leaves the checks", async () => {
    const withFile = makeMessage({
      id: 1,
      subject: "With file",
      hasAttachments: true,
    });
    const plain = makeMessage({ id: 2, subject: "Plain note" });
    mockedListMessages.mockResolvedValue({
      items: [withFile, plain],
      nextCursor: null,
      hasMore: false,
    });
    vi.mocked(api.saveMessagesEml).mockResolvedValue(2);
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("option", { name: /With file/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select With file" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Plain note" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.saveSelectedMessages,
      }),
    );

    await waitFor(() =>
      expect(api.saveMessagesEml).toHaveBeenCalledWith("account-1", [1, 2]),
    );
    expect(
      screen.getByRole("checkbox", { name: "Select Plain note" }),
    ).toBeChecked();
    expect(useAppStore.getState().messages).toHaveLength(2);
  });

  it("leaves the selection in place when selected messages cannot be saved", async () => {
    const plain = makeMessage({ id: 1, subject: "Plain note" });
    mockedListMessages.mockResolvedValue({
      items: [plain],
      nextCursor: null,
      hasMore: false,
    });
    vi.mocked(api.saveMessagesEml).mockRejectedValue(new Error("disk full"));
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("option", { name: /Plain note/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Plain note" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.saveSelectedMessages,
      }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("Error: disk full"),
    );
    expect(
      screen.getByRole("checkbox", { name: "Select Plain note" }),
    ).toBeChecked();
    expect(api.saveConversationAttachments).not.toHaveBeenCalled();
  });

  it("starts a recipient rule from an address on the message", () => {
    const seen: Array<{ field?: string; contains?: string }> = [];
    const onRule = (event: Event) => {
      seen.push(
        (event as CustomEvent<{ field?: string; contains?: string }>).detail,
      );
    };
    window.addEventListener("postal:create-rule", onRule);
    resetStore({
      activeMailboxId: inbox.id,
      messages: [firstMessage],
      selectedMessage: toDetail(firstMessage),
    });
    renderShell();
    fireEvent(
      window,
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "create-address-rule",
          target: { kind: "address", address: "Sam <sam@example.test>" },
        },
      }),
    );
    fireEvent(
      window,
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "create-address-rule",
          target: { kind: "address", address: "Jane <jane@example.test>" },
        },
      }),
    );
    window.removeEventListener("postal:create-rule", onRule);
    expect(seen).toEqual([
      {
        accountId: "account-1",
        contains: "sam@example.test",
        field: "to",
      },
      {
        accountId: "account-1",
        contains: "jane@example.test",
        field: "from",
      },
    ]);
  });

  it("puts a conversation back when the move fails", async () => {
    const archive = makeMailbox({
      id: 4,
      name: "Archive",
      displayName: "Archive",
      role: "archive",
      unreadCount: 0,
      totalCount: 0,
    });
    const newer = makeMessage({
      id: 1,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      threadRoot: "<thread@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMailboxes.mockResolvedValue([inbox, trash, archive]);
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    mockedMoveMessagesToMailbox.mockRejectedValueOnce(new Error("offline"));
    resetStore({
      mailboxes: [inbox, trash, archive],
      activeMailboxId: inbox.id,
    });
    renderShell();

    await screen.findByRole("treeitem", { name: /First message/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "archive-conversation",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("Error: offline"),
    );
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual([
      1, 2,
    ]);
  });

  it("stars a loaded conversation without opening it", async () => {
    const newer = makeMessage({
      id: 1,
      isStarred: false,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      isStarred: true,
      threadRoot: "<thread@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    mockedSetMessagesFlags.mockResolvedValue({
      updated: 1,
      queued: 0,
      failed: 0,
    });
    renderShell();

    await screen.findByRole("treeitem", { name: /Starred/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "star-conversation",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );

    await waitFor(() =>
      expect(mockedSetMessagesFlags).toHaveBeenCalledWith(
        "account-1",
        [1],
        undefined,
        true,
      ),
    );
    expect(mockedGetMessage).not.toHaveBeenCalled();
    expect(
      useAppStore.getState().messages.every((item) => item.isStarred),
    ).toBe(true);
  });

  it("removes stars from a loaded conversation", async () => {
    const newer = makeMessage({
      id: 1,
      isStarred: true,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      isStarred: true,
      threadRoot: "<thread@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    mockedSetMessagesFlags.mockResolvedValue({
      updated: 2,
      queued: 0,
      failed: 0,
    });
    renderShell();

    await screen.findByRole("treeitem", { name: /Starred/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "unstar-conversation",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );

    await waitFor(() =>
      expect(mockedSetMessagesFlags).toHaveBeenCalledWith(
        "account-1",
        [1, 2],
        undefined,
        false,
      ),
    );
    expect(
      screen.queryByRole("treeitem", { name: /Starred/i }),
    ).not.toBeInTheDocument();
  });

  it("puts conversation stars back when the update fails", async () => {
    const newer = makeMessage({
      id: 1,
      isStarred: false,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      isStarred: false,
      threadRoot: "<thread@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    mockedSetMessagesFlags.mockRejectedValueOnce(new Error("offline"));
    renderShell();

    await screen.findByRole("treeitem", { name: /First message/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "star-conversation",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("Error: offline"),
    );
    expect(
      useAppStore.getState().messages.every((item) => !item.isStarred),
    ).toBe(true);
  });

  it("marks a loaded conversation unread without opening it", async () => {
    const newer = makeMessage({
      id: 1,
      isRead: true,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      isRead: false,
      threadRoot: "<thread@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    mockedSetMessagesFlags.mockResolvedValue({
      updated: 1,
      queued: 0,
      failed: 0,
    });
    renderShell();

    await screen.findByRole("treeitem", { name: /First message/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "mark-conversation-unread",
          target: { kind: "message", messageId: 2 },
        },
      }),
    );

    await waitFor(() =>
      expect(mockedSetMessagesFlags).toHaveBeenCalledWith(
        "account-1",
        [1],
        false,
        undefined,
      ),
    );
    expect(mockedGetMessage).not.toHaveBeenCalled();
    expect(useAppStore.getState().messages.every((item) => !item.isRead)).toBe(
      true,
    );
    expect(
      useAppStore.getState().mailboxes.find((mailbox) => mailbox.id === 1)
        ?.unreadCount,
    ).toBe(3);
  });

  it("opens the next unread message from the mailbox menu", async () => {
    const read = makeMessage({ id: 1, isRead: true });
    const unread = makeMessage({ id: 2, isRead: false });
    mockedListMessages.mockResolvedValue({
      items: [read, unread],
      nextCursor: null,
      hasMore: false,
    });
    renderShell();

    await screen.findByRole("option", { name: /First message/i });
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Next unread" }));

    expect(
      await screen.findByRole("heading", { name: "Second message" }),
    ).toBeVisible();
  });

  it("opens the next unread message from the keyboard", async () => {
    const read = makeMessage({ id: 1, isRead: true });
    const unread = makeMessage({ id: 2, isRead: false });
    mockedListMessages.mockResolvedValue({
      items: [read, unread],
      nextCursor: null,
      hasMore: false,
    });
    renderShell();

    await screen.findByRole("option", { name: /First message/i });
    fireEvent.keyDown(document.body, { key: "n" });

    expect(
      await screen.findByRole("heading", { name: "Second message" }),
    ).toBeVisible();
  });

  it("marks selected messages read in bulk", async () => {
    mockedSetMessagesFlags.mockResolvedValue({
      updated: 2,
      queued: 0,
      failed: 0,
    });
    renderShell();

    await screen.findByRole("option", { name: /First message/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /First message/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Second message/i }));
    expect(screen.getByRole("toolbar", { name: "2 selected" })).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark read" }));

    await waitFor(() =>
      expect(mockedSetMessagesFlags).toHaveBeenCalledWith(
        "account-1",
        [1, 2],
        true,
        undefined,
      ),
    );
  });

  it("stars selected messages in bulk", async () => {
    mockedSetMessagesFlags.mockResolvedValue({
      updated: 1,
      queued: 0,
      failed: 0,
    });
    renderShell();

    await screen.findByRole("option", { name: /First message/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /First message/i }));
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Add star" }));

    await waitFor(() =>
      expect(mockedSetMessagesFlags).toHaveBeenCalledWith(
        "account-1",
        [1],
        undefined,
        true,
      ),
    );
  });

  it("marks the whole mailbox read at once", async () => {
    mockedMarkMailboxRead.mockResolvedValue({
      updated: 2,
      queued: 0,
      failed: 0,
    });
    renderShell();

    await screen.findByRole("option", { name: /First message/i });
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark all read" }));

    await waitFor(() =>
      expect(mockedMarkMailboxRead).toHaveBeenCalledWith("account-1", 1),
    );
  });

  it("permanently deletes a selection that is already in Trash", async () => {
    renderShell();
    await screen.findByRole("option", { name: /First message/i });
    const listed = mockedListMessages.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /^Trash/ }));
    await waitFor(() =>
      expect(mockedListMessages.mock.calls.length).toBeGreaterThan(listed),
    );
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /First message/i }));
    fireEvent.click(
      screen.getByRole("button", { name: strings.mail.deleteForever }),
    );

    await waitFor(() =>
      expect(api.deleteTrashMessages).toHaveBeenCalledWith("account-1", [1]),
    );
    expect(api.showNativeConfirm).toHaveBeenCalledWith(
      strings.mail.deleteForever,
      strings.mail.deleteForeverQuestion(1),
    );
    expect(api.moveMessagesToMailbox).not.toHaveBeenCalled();
  });

  it("deletes a Trash conversation and opens the next message", async () => {
    const newer = makeMessage({
      id: 1,
      mailboxId: trash.id,
      threadRoot: "<trash@example.test>",
      subject: "Old receipt",
      isRead: true,
    });
    const older = makeMessage({
      id: 2,
      mailboxId: trash.id,
      threadRoot: "<trash@example.test>",
      subject: "Older receipt",
      isRead: true,
      receivedAt: "2026-08-17T12:00:00Z",
    });
    const keep = makeMessage({
      id: 3,
      mailboxId: trash.id,
      subject: "Keep this",
      isRead: true,
      receivedAt: "2026-08-16T12:00:00Z",
    });
    const loaded = [newer, older, keep];
    const countedTrash = { ...trash, totalCount: 3, unreadCount: 0 };
    mockedListMailboxes.mockResolvedValue([inbox, countedTrash]);
    mockedListMessages.mockResolvedValue({
      items: loaded,
      nextCursor: null,
      hasMore: false,
    });
    mockedGetMessage.mockImplementation(async (_accountId, messageId) => {
      const summary = loaded.find((item) => item.id === messageId);
      if (!summary) throw new Error("message missing");
      return detail(summary);
    });
    vi.mocked(api.deleteTrashMessages).mockResolvedValue(undefined);
    resetStore({
      accounts: [account],
      activeAccountId: account.id,
      mailboxes: [inbox, countedTrash],
      activeMailboxId: countedTrash.id,
    });
    renderShell();

    fireEvent.click(
      await screen.findByRole("treeitem", { name: /Old receipt/i }),
    );
    await screen.findByRole("heading", { name: "Old receipt" });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "delete-conversation",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );

    await waitFor(() =>
      expect(api.deleteTrashMessages).toHaveBeenCalledWith("account-1", [1, 2]),
    );
    expect(api.showNativeConfirm).toHaveBeenCalledWith(
      strings.reader.deleteConversation,
      strings.mail.deleteForeverQuestion(2),
    );
    expect(
      await screen.findByRole("heading", { name: "Keep this" }),
    ).toBeVisible();
    expect(screen.queryByRole("treeitem", { name: /Old receipt/i })).toBeNull();
    const updated = useAppStore
      .getState()
      .mailboxes.find((item) => item.id === trash.id);
    expect(updated?.totalCount).toBe(1);
    expect(updated?.unreadCount).toBe(0);
  });

  it("does not delete an Inbox conversation", async () => {
    const newer = makeMessage({
      id: 1,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      threadRoot: "<thread@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    renderShell();
    await screen.findByRole("treeitem", { name: /First message/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "delete-conversation",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.showNativeConfirm).not.toHaveBeenCalled();
    expect(api.deleteTrashMessages).not.toHaveBeenCalled();
  });

  it("moves a selection from Archive back to Inbox", async () => {
    const archive = makeMailbox({
      id: 2,
      name: "Archive",
      displayName: "Archive",
      role: "archive",
      unreadCount: 0,
      totalCount: 2,
    });
    resetStore({
      accounts: [account],
      activeAccountId: account.id,
      mailboxes: [inbox, archive],
      activeMailboxId: archive.id,
    });
    mockedListMailboxes.mockResolvedValue([inbox, archive]);
    mockedMoveMessagesToMailbox.mockResolvedValue({
      updated: 1,
      queued: 0,
      failed: 0,
    });
    renderShell();

    await screen.findByRole("option", { name: /First message/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /First message/i }));
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moveToInbox }),
    );

    await waitFor(() =>
      expect(mockedMoveMessagesToMailbox).toHaveBeenCalledWith(
        "account-1",
        [1],
        inbox.id,
        expect.any(String),
      ),
    );
  });

  it("moves selected messages to trash in bulk", async () => {
    mockedMoveMessagesToMailbox.mockResolvedValue({
      updated: 1,
      queued: 0,
      failed: 0,
    });
    renderShell();

    await screen.findByRole("option", { name: /First message/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /First message/i }));
    fireEvent.click(screen.getByRole("button", { name: "Move to trash" }));

    await waitFor(() =>
      expect(mockedMoveMessagesToMailbox).toHaveBeenCalledWith(
        "account-1",
        [1],
        3,
        expect.any(String),
      ),
    );
  });

  it("moves selected messages into a chosen folder", async () => {
    const projects = makeMailbox({
      id: 4,
      name: "Projects",
      displayName: "Projects",
      role: "other",
      unreadCount: 0,
      totalCount: 0,
    });
    resetStore({
      accounts: [account],
      activeAccountId: account.id,
      mailboxes: [inbox, trash, projects],
      activeMailboxId: inbox.id,
    });
    mockedListMailboxes.mockResolvedValue([inbox, trash, projects]);
    mockedMoveMessagesToMailbox.mockResolvedValue({
      updated: 1,
      queued: 0,
      failed: 0,
    });
    renderShell();

    await screen.findByRole("option", { name: /First message/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /First message/i }));
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to Projects" }));

    await waitFor(() =>
      expect(mockedMoveMessagesToMailbox).toHaveBeenCalledWith(
        "account-1",
        [1],
        4,
        expect.any(String),
      ),
    );
  });

  it("copies selected messages into a chosen folder and leaves them in place", async () => {
    const projects = makeMailbox({
      id: 4,
      name: "Projects",
      displayName: "Projects",
      role: "other",
      unreadCount: 0,
      totalCount: 0,
    });
    resetStore({
      accounts: [account],
      activeAccountId: account.id,
      mailboxes: [inbox, trash, projects],
      activeMailboxId: inbox.id,
    });
    mockedListMailboxes.mockResolvedValue([inbox, trash, projects]);
    mockedCopyMessagesToMailbox.mockResolvedValue({
      updated: 1,
      queued: 0,
      failed: 0,
    });
    renderShell();

    await screen.findByRole("option", { name: /First message/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /First message/i }));
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy to Projects" }));

    await waitFor(() =>
      expect(mockedCopyMessagesToMailbox).toHaveBeenCalledWith(
        "account-1",
        [1],
        4,
      ),
    );
    expect(
      screen.getByRole("checkbox", { name: /First message/i }),
    ).toBeChecked();
  });

  it("prints a loaded conversation without opening it", async () => {
    const newer = makeMessage({
      id: 1,
      threadRoot: "<thread@example.test>",
      subject: "Newer note",
    });
    const older = makeMessage({
      id: 2,
      threadRoot: "<thread@example.test>",
      subject: "Older note",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    mockedGetMessage.mockImplementation(async (_accountId, id) => {
      const summary = id === older.id ? older : newer;
      return toDetail(summary, {
        textBody: summary.subject,
        htmlBody: `<p>${summary.subject}</p><script>alert(1)</script>`,
      });
    });
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("treeitem", { name: /Newer note/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "print-conversation",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );

    const frame = await waitFor(() => {
      const printer = document.querySelector("iframe");
      if (!printer?.srcdoc.includes("Older note"))
        throw new Error("print document is not ready");
      return printer;
    });
    expect(frame.srcdoc.indexOf("Older note")).toBeLessThan(
      frame.srcdoc.indexOf("Newer note"),
    );
    expect(frame.srcdoc).not.toContain("alert(1)");
    expect(mockedGetMessage).toHaveBeenCalledWith("account-1", 1);
    expect(mockedGetMessage).toHaveBeenCalledWith("account-1", 2);
    expect(useAppStore.getState().selectedMessage).toBeUndefined();
  });

  it("prints the selected messages oldest first", async () => {
    const newer = makeMessage({
      id: 1,
      subject: "Newer note",
      receivedAt: "2026-08-18T12:00:00Z",
    });
    const older = makeMessage({
      id: 2,
      subject: "Older note",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    const skipped = makeMessage({
      id: 3,
      subject: "Skipped note",
      receivedAt: "2026-08-16T12:00:00Z",
    });
    const loaded = [newer, older, skipped];
    mockedListMessages.mockResolvedValue({
      items: loaded,
      nextCursor: null,
      hasMore: false,
    });
    mockedGetMessage.mockImplementation(async (_accountId, id) => {
      const summary = loaded.find((item) => item.id === id) ?? newer;
      return toDetail(summary, {
        textBody: summary.subject,
        htmlBody: `<p>${summary.subject}</p><script>alert(1)</script>`,
      });
    });
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("option", { name: /Newer note/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Newer note" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Older note" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.printSelected }),
    );

    const frame = await waitFor(() => {
      const printer = document.querySelector("iframe");
      if (!printer?.srcdoc.includes("Older note"))
        throw new Error("print document is not ready");
      return printer;
    });
    expect(frame.srcdoc.indexOf("Older note")).toBeLessThan(
      frame.srcdoc.indexOf("Newer note"),
    );
    expect(frame.srcdoc).not.toContain("Skipped note");
    expect(frame.srcdoc).not.toContain("alert(1)");
    expect(
      screen.getByRole("checkbox", { name: "Select Newer note" }),
    ).toBeChecked();
    frame.remove();
  });

  it("leaves the selection in place when a selected message cannot be printed", async () => {
    const newer = makeMessage({ id: 1, subject: "Newer note" });
    const older = makeMessage({
      id: 2,
      subject: "Older note",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    mockedGetMessage.mockRejectedValue(new Error("offline"));
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("option", { name: /Newer note/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Older note" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.printSelected }),
    );
    useAppStore.getState().setError(undefined);

    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/offline/),
    );
    expect(document.querySelector("iframe")).toBeNull();
    expect(
      screen.getByRole("checkbox", { name: "Select Older note" }),
    ).toBeChecked();
  });

  it("forwards a loaded conversation without opening it", async () => {
    const newer = makeMessage({
      id: 1,
      threadRoot: "<thread@example.test>",
      subject: "Newer note",
    });
    const older = makeMessage({
      id: 2,
      threadRoot: "<thread@example.test>",
      subject: "Older note",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    mockedGetMessage.mockImplementation(async (_accountId, id) => {
      const summary = id === older.id ? older : newer;
      return toDetail(summary, {
        textBody: summary.subject,
        htmlBody: `<p>${summary.subject}</p><script>alert(1)</script>`,
      });
    });
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("treeitem", { name: /Newer note/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "forward-conversation",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().composeSeed?.forwardMessages).toHaveLength(
        2,
      ),
    );
    const seed = useAppStore.getState().composeSeed;
    expect(seed?.composeMode).toBe("forward");
    expect(seed?.sourceMessage?.subject).toBe("Newer note");
    const quoted = seedBody(seed);
    expect(quoted.indexOf("Older note")).toBeLessThan(
      quoted.indexOf("Newer note"),
    );
    expect(quoted).not.toContain("alert(1)");
    expect(useAppStore.getState().selectedMessage).toBeUndefined();
    expect(mockedGetMessage).toHaveBeenCalledWith("account-1", 1);
    expect(mockedGetMessage).toHaveBeenCalledWith("account-1", 2);
  });

  it("leaves the list in place when a conversation cannot be forwarded", async () => {
    const newer = makeMessage({
      id: 1,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      threadRoot: "<thread@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    mockedGetMessage.mockRejectedValue(new Error("body unavailable"));
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("treeitem", { name: /First message/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "forward-conversation",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("Error: body unavailable"),
    );
    expect(useAppStore.getState().composeSeed).toBeUndefined();
    expect(useAppStore.getState().selectedMessage).toBeUndefined();
  });

  it("leaves the list in place when a conversation is too large to forward", async () => {
    const newer = makeMessage({
      id: 1,
      threadRoot: "<thread@example.test>",
      subject: "Newer note",
    });
    const older = makeMessage({
      id: 2,
      threadRoot: "<thread@example.test>",
      subject: "Older note",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    mockedGetMessage.mockImplementation(async (_accountId, id) =>
      toDetail(id === older.id ? older : newer, {
        textBody: "x".repeat(500_000),
      }),
    );
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("treeitem", { name: /Newer note/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "forward-conversation",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().error).toBe(
        strings.composer.conversationTooLarge,
      ),
    );
    expect(useAppStore.getState().composeSeed).toBeUndefined();
  });

  it("forwards the selected messages oldest first", async () => {
    const newer = makeMessage({
      id: 1,
      subject: "Newer note",
      receivedAt: "2026-08-18T12:00:00Z",
    });
    const older = makeMessage({
      id: 2,
      subject: "Older note",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    const skipped = makeMessage({
      id: 3,
      subject: "Skipped note",
      receivedAt: "2026-08-16T12:00:00Z",
    });
    const loaded = [newer, older, skipped];
    mockedListMessages.mockResolvedValue({
      items: loaded,
      nextCursor: null,
      hasMore: false,
    });
    mockedGetMessage.mockImplementation(async (_accountId, id) => {
      const summary = loaded.find((item) => item.id === id) ?? newer;
      return toDetail(summary, {
        textBody: summary.subject,
        htmlBody: `<p>${summary.subject}</p><script>alert(1)</script>`,
      });
    });
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("option", { name: /Newer note/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Newer note" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Older note" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.forwardSelected }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().composeSeed?.forwardMessages).toHaveLength(
        2,
      ),
    );
    const seed = useAppStore.getState().composeSeed;
    expect(seed?.composeMode).toBe("forward");
    expect(seed?.sourceMessage?.subject).toBe("Newer note");
    const quoted = seedBody(seed);
    expect(quoted.indexOf("Older note")).toBeLessThan(
      quoted.indexOf("Newer note"),
    );
    expect(quoted).not.toContain("Skipped note");
    expect(quoted).not.toContain("alert(1)");
    expect(
      screen.getByRole("checkbox", { name: "Select Newer note" }),
    ).toBeChecked();
  });

  it("leaves the selection in place when a selected message cannot be forwarded", async () => {
    const newer = makeMessage({ id: 1, subject: "Newer note" });
    const older = makeMessage({
      id: 2,
      subject: "Older note",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    mockedGetMessage.mockRejectedValue(new Error("body unavailable"));
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("option", { name: /Newer note/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Older note" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.forwardSelected }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("Error: body unavailable"),
    );
    expect(useAppStore.getState().composeSeed).toBeUndefined();
    expect(
      screen.getByRole("checkbox", { name: "Select Older note" }),
    ).toBeChecked();
  });

  it("leaves the selection in place when the selected messages are too large to forward", async () => {
    const newer = makeMessage({
      id: 1,
      subject: "Newer note",
      receivedAt: "2026-08-18T12:00:00Z",
    });
    const older = makeMessage({
      id: 2,
      subject: "Older note",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    mockedGetMessage.mockImplementation(async (_accountId, id) =>
      toDetail(id === older.id ? older : newer, {
        textBody: "x".repeat(500_000),
      }),
    );
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("option", { name: /Newer note/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Newer note" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Older note" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.forwardSelected }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().error).toBe(
        strings.composer.selectionTooLarge,
      ),
    );
    expect(useAppStore.getState().composeSeed).toBeUndefined();
    expect(
      screen.getByRole("checkbox", { name: "Select Newer note" }),
    ).toBeChecked();
  });

  it("copies the selected messages oldest first", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const newer = makeMessage({
      id: 1,
      subject: "Newer note",
      receivedAt: "2026-08-18T12:00:00Z",
    });
    const older = makeMessage({
      id: 2,
      subject: "Older note",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    const skipped = makeMessage({
      id: 3,
      subject: "Skipped note",
      receivedAt: "2026-08-16T12:00:00Z",
    });
    const loaded = [newer, older, skipped];
    mockedListMessages.mockResolvedValue({
      items: loaded,
      nextCursor: null,
      hasMore: false,
    });
    mockedGetMessage.mockImplementation(async (_accountId, id) => {
      const summary = loaded.find((item) => item.id === id) ?? newer;
      return toDetail(summary, {
        textBody: id === skipped.id ? "" : `${summary.subject} body`,
        htmlBody:
          id === skipped.id
            ? null
            : `<p>${summary.subject}</p><script>alert(1)</script>`,
      });
    });
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("option", { name: /Newer note/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Newer note" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Older note" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Skipped note" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.copySelectedText }),
    );

    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const copied = String(writeText.mock.calls[0]?.[0]);
    expect(copied.indexOf("Older note")).toBeLessThan(
      copied.indexOf("Newer note"),
    );
    expect(copied).toContain("Older note body");
    expect(copied).toContain("Newer note body");
    expect(copied).not.toContain("Skipped");
    expect(copied).not.toContain("alert(1)");
    expect(
      screen.getByRole("checkbox", { name: "Select Newer note" }),
    ).toBeChecked();
  });

  it("leaves the selection in place when selected text cannot be copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const newer = makeMessage({ id: 1, subject: "Newer note" });
    mockedListMessages.mockResolvedValue({
      items: [newer],
      nextCursor: null,
      hasMore: false,
    });
    mockedGetMessage.mockResolvedValue(
      toDetail(newer, { textBody: "", htmlBody: null }),
    );
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("option", { name: /Newer note/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Newer note" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.copySelectedText }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().error).toBe(strings.reader.noSelectedText),
    );
    expect(writeText).not.toHaveBeenCalled();
    expect(
      screen.getByRole("checkbox", { name: "Select Newer note" }),
    ).toBeChecked();
  });

  it("leaves the selection in place when the clipboard rejects the copy", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard locked"));
    Object.assign(navigator, { clipboard: { writeText } });
    const newer = makeMessage({ id: 1, subject: "Newer note" });
    mockedListMessages.mockResolvedValue({
      items: [newer],
      nextCursor: null,
      hasMore: false,
    });
    mockedGetMessage.mockResolvedValue(
      toDetail(newer, { textBody: "Bring the notes" }),
    );
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("option", { name: /Newer note/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Newer note" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.copySelectedText }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("Error: clipboard locked"),
    );
    expect(
      screen.getByRole("checkbox", { name: "Select Newer note" }),
    ).toBeChecked();
  });

  it("pins an older message above newer mail", async () => {
    const newer = makeMessage({
      id: 1,
      subject: "Newer note",
      receivedAt: "2026-08-18T12:00:00Z",
    });
    const older = makeMessage({
      id: 2,
      subject: "Older note",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    vi.mocked(api.setMessagesPinned).mockResolvedValue(1);
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("option", { name: /Newer note/i });
    expect(screen.getAllByRole("option")[0]).toHaveAttribute(
      "aria-label",
      expect.stringMatching(/Newer note/),
    );
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "pin",
          target: { kind: "message", messageId: 2 },
        },
      }),
    );
    await waitFor(() =>
      expect(screen.getAllByRole("option")[0]).toHaveAttribute(
        "aria-label",
        expect.stringMatching(/Pinned[\s\S]*Older note/),
      ),
    );
    expect(api.setMessagesPinned).toHaveBeenCalledWith("account-1", [2], true);
    expect(
      screen.getByText(strings.mail.pinned, { selector: ".list-day > span" }),
    ).toBeInTheDocument();
    expect(useAppStore.getState().selectedMessage).toBeUndefined();
  });

  it("leaves a message unpinned when the pin cannot be saved", async () => {
    const newer = makeMessage({
      id: 1,
      subject: "Newer note",
      receivedAt: "2026-08-18T12:00:00Z",
    });
    const older = makeMessage({
      id: 2,
      subject: "Older note",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    vi.mocked(api.setMessagesPinned).mockRejectedValue(new Error("disk full"));
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("option", { name: /Newer note/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "pin",
          target: { kind: "message", messageId: 2 },
        },
      }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("Error: disk full"),
    );
    expect(screen.getAllByRole("option")[0]).toHaveAttribute(
      "aria-label",
      expect.stringMatching(/Newer note/),
    );
    expect(
      useAppStore.getState().messages.find((item) => item.id === 2)?.pinned,
    ).toBe(false);
  });

  it("leaves the list in place when a conversation print cannot load", async () => {
    const newer = makeMessage({
      id: 1,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      threadRoot: "<thread@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    mockedGetMessage.mockRejectedValue(new Error("body unavailable"));
    resetStore({ activeMailboxId: inbox.id });
    renderShell();

    await screen.findByRole("treeitem", { name: /First message/i });
    document.querySelectorAll("iframe").forEach((frame) => frame.remove());
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "print-conversation",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("Error: body unavailable"),
    );
    expect(document.querySelector("iframe")).toBeNull();
    expect(useAppStore.getState().selectedMessage).toBeUndefined();
  });

  it("copies a loaded conversation into another folder and leaves it in place", async () => {
    const projects = makeMailbox({
      id: 4,
      name: "Projects",
      displayName: "Projects",
      role: "other",
      unreadCount: 0,
      totalCount: 0,
    });
    const newer = makeMessage({
      id: 1,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      threadRoot: "<thread@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    const other = makeMessage({ id: 3, subject: "Other note" });
    mockedListMailboxes.mockResolvedValue([inbox, trash, projects]);
    mockedListMessages.mockResolvedValue({
      items: [newer, older, other],
      nextCursor: null,
      hasMore: false,
    });
    mockedCopyMessagesToMailbox.mockResolvedValue({
      updated: 2,
      queued: 0,
      failed: 0,
    });
    resetStore({
      mailboxes: [inbox, trash, projects],
      activeMailboxId: inbox.id,
    });
    renderShell();

    await screen.findByRole("treeitem", { name: /First message/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "copy-conversation:4",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );

    await waitFor(() =>
      expect(mockedCopyMessagesToMailbox).toHaveBeenCalledWith(
        "account-1",
        [1, 2],
        4,
      ),
    );
    expect(mockedGetMessage).not.toHaveBeenCalled();
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual([
      1, 2, 3,
    ]);
    expect(useAppStore.getState().selectedMessage).toBeUndefined();
  });

  it("leaves a conversation in place when the copy fails", async () => {
    const projects = makeMailbox({
      id: 4,
      name: "Projects",
      displayName: "Projects",
      role: "other",
    });
    const newer = makeMessage({
      id: 1,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      threadRoot: "<thread@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMailboxes.mockResolvedValue([inbox, trash, projects]);
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    mockedCopyMessagesToMailbox.mockRejectedValue(new Error("copy failed"));
    resetStore({
      mailboxes: [inbox, trash, projects],
      activeMailboxId: inbox.id,
    });
    renderShell();

    await screen.findByRole("treeitem", { name: /First message/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "copy-conversation:4",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("Error: copy failed"),
    );
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual([
      1, 2,
    ]);
  });

  it("moves a loaded conversation into another folder and opens the next message", async () => {
    const projects = makeMailbox({
      id: 4,
      name: "Projects",
      displayName: "Projects",
      role: "other",
      unreadCount: 0,
      totalCount: 0,
    });
    const newer = makeMessage({
      id: 1,
      isRead: false,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      isRead: true,
      threadRoot: "<thread@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    const other = makeMessage({ id: 3, isRead: true, subject: "Other note" });
    mockedListMailboxes.mockResolvedValue([inbox, trash, projects]);
    mockedListMessages.mockResolvedValue({
      items: [newer, older, other],
      nextCursor: null,
      hasMore: false,
    });
    mockedMoveMessagesToMailbox.mockResolvedValue({
      updated: 2,
      queued: 0,
      failed: 0,
    });
    resetStore({
      mailboxes: [inbox, trash, projects],
      activeMailboxId: inbox.id,
    });
    renderShell();

    await screen.findByRole("treeitem", { name: /First message/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "move-conversation:4",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );

    await waitFor(() =>
      expect(mockedMoveMessagesToMailbox).toHaveBeenCalledWith(
        "account-1",
        [1, 2],
        4,
        expect.any(String),
      ),
    );
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual([3]);
    expect(mockedGetMessage).not.toHaveBeenCalled();
    const boxes = useAppStore.getState().mailboxes;
    expect(boxes.find((mailbox) => mailbox.id === 1)?.totalCount).toBe(0);
    expect(boxes.find((mailbox) => mailbox.id === 4)?.totalCount).toBe(2);
  });

  it("puts a conversation back when moving it to a folder fails", async () => {
    const projects = makeMailbox({
      id: 4,
      name: "Projects",
      displayName: "Projects",
      role: "other",
    });
    const newer = makeMessage({
      id: 1,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      threadRoot: "<thread@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMailboxes.mockResolvedValue([inbox, trash, projects]);
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    mockedMoveMessagesToMailbox.mockRejectedValue(new Error("offline"));
    resetStore({
      mailboxes: [inbox, trash, projects],
      activeMailboxId: inbox.id,
    });
    renderShell();

    await screen.findByRole("treeitem", { name: /First message/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "move-conversation:4",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("Error: offline"),
    );
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual([
      1, 2,
    ]);
  });

  it("moves a dragged message into the folder it is dropped on", async () => {
    const moveOne = vi.mocked(api.moveMessageToMailbox);
    moveOne.mockResolvedValue(undefined);
    renderShell();
    const row = await screen.findByRole("option", { name: /First message/i });
    const dataTransfer = messageDragTransfer();
    fireEvent.dragStart(row, { dataTransfer });
    const trash = screen.getByRole("button", { name: "Trash" });
    fireEvent.dragOver(trash, { dataTransfer });
    expect(trash).toHaveClass("drop-target");
    fireEvent.drop(trash, { dataTransfer });

    await waitFor(() =>
      expect(moveOne).toHaveBeenCalledWith(
        "account-1",
        1,
        3,
        expect.any(String),
      ),
    );
    expect(dataTransfer.getData("application/x-postal-snap-messages")).toBe(
      "account-1\n1",
    );
  });

  it("moves every selected message when one of them is dropped on a folder", async () => {
    mockedMoveMessagesToMailbox.mockResolvedValue({
      updated: 2,
      queued: 0,
      failed: 0,
    });
    renderShell();
    await screen.findByRole("option", { name: /First message/i });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /First message/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Second message/i }));
    const dataTransfer = messageDragTransfer();
    fireEvent.dragStart(
      screen.getByRole("option", { name: /First message/i }),
      { dataTransfer },
    );
    fireEvent.drop(screen.getByRole("button", { name: "Trash" }), {
      dataTransfer,
    });

    await waitFor(() =>
      expect(mockedMoveMessagesToMailbox).toHaveBeenCalledWith(
        "account-1",
        [1, 2],
        3,
        expect.any(String),
      ),
    );
  });

  it("moves every loaded message when a conversation is dropped on a folder", async () => {
    const newer = makeMessage({
      id: 1,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      threadRoot: "<thread@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    mockedMoveMessagesToMailbox.mockResolvedValue({
      updated: 2,
      queued: 0,
      failed: 0,
    });
    renderShell();
    const header = await screen.findByRole("treeitem", {
      name: /First message/i,
    });
    const dataTransfer = messageDragTransfer();
    fireEvent.dragStart(header, { dataTransfer });
    fireEvent.drop(screen.getByRole("button", { name: "Trash" }), {
      dataTransfer,
    });

    await waitFor(() =>
      expect(mockedMoveMessagesToMailbox).toHaveBeenCalledWith(
        "account-1",
        [1, 2],
        3,
        expect.any(String),
      ),
    );
  });

  it("moves only the message that was dragged out of an open conversation", async () => {
    const newer = makeMessage({
      id: 1,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      threadRoot: "<thread@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    const moveOne = vi.mocked(api.moveMessageToMailbox);
    moveOne.mockResolvedValue(undefined);
    renderShell();
    const header = await screen.findByRole("treeitem", {
      name: /Conversation/i,
    });
    fireEvent.click(header);
    const dataTransfer = messageDragTransfer();
    fireEvent.dragStart(
      await screen.findByRole("treeitem", { name: /Second message/i }),
      { dataTransfer },
    );
    fireEvent.drop(screen.getByRole("button", { name: "Trash" }), {
      dataTransfer,
    });

    await waitFor(() =>
      expect(moveOne).toHaveBeenCalledWith(
        "account-1",
        2,
        3,
        expect.any(String),
      ),
    );
    expect(mockedMoveMessagesToMailbox).not.toHaveBeenCalled();
  });

  it("leaves a message in its folder when dropped on that same folder", async () => {
    const moveOne = vi.mocked(api.moveMessageToMailbox);
    renderShell();
    const row = await screen.findByRole("option", { name: /First message/i });
    const dataTransfer = messageDragTransfer();
    fireEvent.dragStart(row, { dataTransfer });
    const inboxButton = screen.getByRole("button", { name: /^Inbox/ });
    fireEvent.drop(inboxButton, { dataTransfer });
    expect(inboxButton).not.toHaveClass("drop-target");
    expect(moveOne).not.toHaveBeenCalled();
  });

  it("shows attachment, invitation, reply, and forward marks for a conversation", async () => {
    const newer = makeMessage({
      id: 1,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      threadRoot: "<thread@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
      hasAttachments: true,
      hasCalendar: true,
      isAnswered: true,
      isForwarded: true,
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    renderShell();
    const header = await screen.findByRole("treeitem", {
      name: /Conversation/i,
    });
    expect(header).toHaveAccessibleName(/Has attachments/);
    expect(header).toHaveAccessibleName(/Calendar invitation/);
    expect(header).toHaveAccessibleName(/Replied/);
    expect(header).toHaveAccessibleName(/Forwarded/);
    expect(header.querySelectorAll(".message-subject svg")).toHaveLength(4);
  });

  it("names high importance on a message and on a conversation", async () => {
    const urgent = makeMessage({
      id: 1,
      subject: "Urgent note",
      importance: "high",
      threadRoot: "<urgent@example.test>",
    });
    const older = makeMessage({
      id: 2,
      subject: "Earlier note",
      importance: "low",
      threadRoot: "<urgent@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [urgent, older],
      nextCursor: null,
      hasMore: false,
    });
    renderShell();
    const header = await screen.findByRole("treeitem", {
      name: /Urgent note/i,
    });
    expect(header).toHaveAccessibleName(/High importance/);
    expect(header.querySelector(".importance-high")).toBeTruthy();
  });

  it("shows when mail was last checked", async () => {
    const checked = new Date().toISOString();
    useAppStore.setState({
      sync: {
        [account.id]: {
          accountId: account.id,
          phase: "idle",
          lastSuccessAt: checked,
        },
      },
    });
    renderShell();
    expect(await screen.findByRole("status")).toHaveTextContent(
      `${strings.mail.mailUpToDate}. ${strings.mail.checkedAt(formatMessageDate(checked))}`,
    );
  });

  it("does not auto-send a held message while live sync is offline", async () => {
    const sendNow = vi.mocked(api.sendScheduledOutbox);
    const held = {
      id: "outbox-1",
      accountId: account.id,
      recipients: "lee@example.com",
      subject: "Held note",
      state: "scheduled",
      detail: "Held for review.",
      createdAt: "2026-08-18T11:00:00Z",
      sendAt: new Date(Date.now() - 1000).toISOString(),
    } as const;
    mockedListOutbox.mockResolvedValue([held]);
    useAppStore.setState({
      activeLocalView: "outbox",
      outbox: [held],
      sync: {
        [account.id]: {
          accountId: account.id,
          phase: "offline",
          detail: "Connection lost.",
        },
      },
    });
    renderShell();
    await screen.findByText("Held note");
    await waitFor(() => expect(sendNow).not.toHaveBeenCalled());
  });

  it("dispatches an overdue held message only once while its send is pending", async () => {
    let finishSend: (() => void) | undefined;
    const sendNow = vi.mocked(api.sendScheduledOutbox);
    sendNow.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSend = () =>
            resolve({ id: "outbox-1", state: "sent", detail: null });
        }),
    );
    const held = {
      id: "outbox-1",
      accountId: account.id,
      recipients: "lee@example.com",
      subject: "Held note",
      state: "scheduled",
      detail: "Held for review.",
      createdAt: "2026-08-18T11:00:00Z",
      sendAt: new Date(Date.now() - 1000).toISOString(),
    } as const;
    mockedListOutbox.mockResolvedValue([held]);
    useAppStore.setState({ outbox: [held] });

    renderShell();
    await waitFor(() => expect(sendNow).toHaveBeenCalledTimes(1));
    act(() => useAppStore.setState({ outbox: [{ ...held }] }));
    await waitFor(() => expect(sendNow).toHaveBeenCalledTimes(1));

    finishSend?.();
  });

  it("sends a held message early on request", async () => {
    const sendNow = vi.mocked(api.sendScheduledOutbox);
    sendNow.mockResolvedValue({ id: "outbox-1", state: "sent", detail: null });
    const held = {
      id: "outbox-1",
      accountId: account.id,
      recipients: "lee@example.com",
      subject: "Held note",
      state: "scheduled",
      detail: "Held for review.",
      createdAt: "2026-08-18T11:00:00Z",
      sendAt: new Date(Date.now() + 60_000).toISOString(),
    } as const;
    mockedListOutbox.mockResolvedValue([held]);
    useAppStore.setState({
      activeLocalView: "outbox",
      outbox: [held],
    });
    renderShell();

    fireEvent.click(await screen.findByRole("button", { name: "Send now" }));
    await waitFor(() =>
      expect(sendNow).toHaveBeenCalledWith("outbox-1", "account-1"),
    );
  });

  it("disables Send now and names the in-flight scheduled item", async () => {
    let finishSend: (() => void) | undefined;
    const sendNow = vi.mocked(api.sendScheduledOutbox);
    sendNow.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSend = () =>
            resolve({ id: "outbox-1", state: "sent", detail: null });
        }),
    );
    const held = {
      id: "outbox-1",
      accountId: account.id,
      recipients: "lee@example.com",
      subject: "Held note",
      state: "scheduled",
      detail: "Held for review.",
      createdAt: "2026-08-18T11:00:00Z",
      sendAt: new Date(Date.now() + 60_000).toISOString(),
    } as const;
    mockedListOutbox.mockResolvedValue([held]);
    useAppStore.setState({ activeLocalView: "outbox", outbox: [held] });
    renderShell();

    fireEvent.click(await screen.findByRole("button", { name: "Send now" }));
    await waitFor(() => expect(sendNow).toHaveBeenCalledTimes(1));
    const sending = await screen.findByRole("button", {
      name: strings.mail.sendingNow("Held note"),
    });
    expect(sending).toBeDisabled();
    expect(sending).toHaveTextContent(strings.mail.sending);
    fireEvent.click(sending);
    expect(sendNow).toHaveBeenCalledTimes(1);

    act(() => finishSend?.());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: strings.mail.sendNow }),
      ).toBeEnabled(),
    );
  });

  it("does not auto-send a stale scheduled item from another account", async () => {
    const sendNow = vi.mocked(api.sendScheduledOutbox);
    const foreign = {
      id: "outbox-foreign",
      accountId: "account-2",
      recipients: "lee@example.com",
      subject: "Other account note",
      state: "scheduled",
      detail: "Held for review.",
      createdAt: "2026-08-18T11:00:00Z",
      sendAt: new Date(Date.now() - 1000).toISOString(),
    } as const;
    mockedListOutbox.mockResolvedValue([foreign]);
    useAppStore.setState({ outbox: [foreign] });
    renderShell();

    await screen.findByRole("option", { name: /First message/i });
    await waitFor(() => expect(sendNow).not.toHaveBeenCalled());
  });

  it("collapses threads until expanded", async () => {
    const threaded = [firstMessage, secondMessage].map((message) => ({
      ...message,
      threadRoot: "<thread@example.test>",
    }));
    mockedListMessages.mockResolvedValue({
      items: threaded,
      nextCursor: null,
      hasMore: false,
    });
    renderShell();

    const header = await screen.findByRole("treeitem", {
      name: /Conversation.*2 messages/i,
    });
    expect(
      screen.queryByRole("treeitem", { name: /First message/i }),
    ).toBeNull();
    fireEvent.click(header);
    expect(
      await screen.findByRole("treeitem", { name: /First message/i }),
    ).toBeVisible();
    expect(
      screen.getAllByRole("treeitem", { name: /Second message/i }),
    ).toHaveLength(2);
  });

  it("lists snoozed mail separately with a way back", async () => {
    mockedListSnoozed.mockResolvedValue([
      {
        message: firstMessage,
        snoozedUntil: "2026-09-01T08:00:00+00:00",
      },
    ]);
    mockedUnsnoozeMessage.mockResolvedValue(undefined);
    renderShell();

    fireEvent.click(screen.getByRole("button", { name: /^Snoozed/ }));
    expect(
      await screen.findByRole("heading", { name: "Snoozed" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: /^Unread, Jane, First message, Snoozed until/,
      }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Bring back First message" }),
    );
    await waitFor(() =>
      expect(mockedUnsnoozeMessage).toHaveBeenCalledWith("account-1", 1),
    );
  });

  it("inerts the mailbox chrome when the reader is an overlay", async () => {
    useAppStore.setState({
      settings: { ...defaultSettings, readingPane: "hidden" },
    });
    mockedGetMessage.mockResolvedValue({
      ...detail(firstMessage),
      htmlBody: "<p>Hello from the overlay.</p>",
    });
    renderShell();
    await screen.findByRole("option", { name: /First message/i });
    fireEvent.click(screen.getByRole("option", { name: /First message/i }));
    await screen.findByRole("heading", { name: "First message" });

    // jsdom has no `inert`, so the overlay falls back to aria-hidden plus a
    // focus trap; Chromium and WebKit exercise the real inert attribute.
    expect(document.getElementById("message-pane")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(document.querySelector(".app-toolbar")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(document.getElementById("reader-pane")).not.toHaveAttribute(
      "aria-hidden",
    );
    expect(screen.getByTitle("Message content")).toHaveAttribute(
      "tabindex",
      "0",
    );
  });

  it("cycles reader-overlay focus with Tab when inert is unavailable", async () => {
    // jsdom has no layout, so focusability checks need the stub used by the
    // dialog tests; restore it after this test to keep other assertions raw.
    const originalCheckVisibility = HTMLElement.prototype.checkVisibility;
    Object.defineProperty(HTMLElement.prototype, "checkVisibility", {
      configurable: true,
      value: function checkVisibility(this: HTMLElement) {
        return !this.hidden;
      },
    });
    try {
      useAppStore.setState({
        settings: { ...defaultSettings, readingPane: "hidden" },
      });
      mockedGetMessage.mockResolvedValue({
        ...detail(firstMessage),
        htmlBody: "<p>Hello from the overlay.</p>",
      });
      renderShell();
      await screen.findByRole("option", { name: /First message/i });
      fireEvent.click(screen.getByRole("option", { name: /First message/i }));
      await screen.findByRole("heading", { name: "First message" });

      const overlay = document.getElementById("reader-pane");
      if (!overlay) throw new Error("reader overlay is missing");
      const focusable = [
        ...overlay.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), iframe, [href], [tabindex]:not([tabindex='-1'])",
        ),
      ].filter((item) => !item.hidden);
      expect(focusable.length).toBeGreaterThan(1);

      // Cycle across the last stop, and back across the first.
      focusable[focusable.length - 1]?.focus();
      fireEvent.keyDown(window, { key: "Tab" });
      expect(document.activeElement).toBe(focusable[0]);
      fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(focusable[focusable.length - 1]);
    } finally {
      Object.defineProperty(HTMLElement.prototype, "checkVisibility", {
        configurable: true,
        value: originalCheckVisibility,
      });
    }
  });

  it("rolls pane width back when saving the new size fails", async () => {
    mockedSaveSettings.mockRejectedValueOnce(new Error("disk full"));
    renderShell();
    await screen.findByRole("option", { name: /First message/i });

    fireEvent.keyDown(
      screen.getByRole("separator", { name: "Resize message list" }),
      { key: "Home" },
    );

    await waitFor(() =>
      expect(useAppStore.getState().settings.messagePaneWidth).toBe(400),
    );
    expect(useAppStore.getState().error).toMatch(/disk full/i);
  });

  it("clears the open message after it moves", async () => {
    let onChanged: ((event: MessageChangeEvent) => void) | undefined;
    mockedOnMessageChanged.mockImplementation(async (handler) => {
      onChanged = handler;
      return () => undefined;
    });

    renderShell();
    await screen.findByRole("option", { name: /First message/i });
    fireEvent.click(screen.getByRole("option", { name: /First message/i }));
    await screen.findByRole("heading", { name: "First message" });
    await waitFor(() => expect(onChanged).toBeTypeOf("function"));

    onChanged?.({
      accountId: account.id,
      messageId: firstMessage.id,
      kind: "moved",
    });
    await waitFor(() =>
      expect(useAppStore.getState().selectedMessage).toBeUndefined(),
    );
  });

  it("lists messages separately when conversation grouping is off", async () => {
    const threaded = [firstMessage, secondMessage].map((message) => ({
      ...message,
      threadRoot: "<thread@example.test>",
    }));
    mockedListMessages.mockResolvedValue({
      items: threaded,
      nextCursor: null,
      hasMore: false,
    });
    useAppStore.setState({
      settings: { ...defaultSettings, groupThreads: false },
    });
    renderShell();

    expect(
      await screen.findByRole("option", { name: /First message/i }),
    ).toBeVisible();
    expect(
      screen.getByRole("option", { name: /Second message/i }),
    ).toBeVisible();
    expect(screen.queryByRole("option", { name: /Conversation/i })).toBeNull();
  });

  it("opens the newest message from a conversation header", async () => {
    const threaded = [firstMessage, secondMessage].map((message) => ({
      ...message,
      threadRoot: "<thread@example.test>",
    }));
    mockedListMessages.mockResolvedValue({
      items: threaded,
      nextCursor: null,
      hasMore: false,
    });
    renderShell();

    fireEvent.click(
      await screen.findByRole("treeitem", {
        name: /Conversation.*2 messages/i,
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Second message" }),
    ).toBeVisible();
  });

  it("restores an undone send into the composer", async () => {
    const draft = {
      id: "draft-restored",
      accountId: account.id,
      to: ["lee@example.com"],
      cc: [],
      bcc: [],
      subject: "Held note",
      htmlBody: "<p>Hi</p>",
      textBody: "Hi",
      attachments: [],
    };
    vi.mocked(api.restoreOutbox).mockResolvedValue(draft);
    const held = {
      id: "outbox-1",
      accountId: account.id,
      recipients: "lee@example.com",
      subject: "Held note",
      state: "scheduled",
      detail: "Held for review.",
      createdAt: "2026-08-18T11:00:00Z",
      sendAt: new Date(Date.now() + 60_000).toISOString(),
    } as const;
    mockedListOutbox.mockResolvedValue([held]);
    useAppStore.setState({
      activeLocalView: "outbox",
      outbox: [held],
    });
    renderShell();

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(api.restoreOutbox).toHaveBeenCalledWith("outbox-1", "account-1"),
    );
    expect(api.deleteOutbox).not.toHaveBeenCalled();
    expect(useAppStore.getState().composerOpen).toBe(true);
    expect(useAppStore.getState().composeSeed?.draft).toEqual(draft);
  });

  it("shows an undo toast after a held send and clears it", async () => {
    const draft = {
      id: "draft-sent",
      accountId: account.id,
      to: ["lee@example.com"],
      cc: [],
      bcc: [],
      subject: "Just sent",
      htmlBody: "<p>Hi</p>",
      textBody: "Hi",
      attachments: [],
    };
    vi.mocked(api.restoreOutbox).mockResolvedValue(draft);
    useAppStore.setState({
      lastSent: {
        outboxId: "outbox-2",
        accountId: account.id,
        scheduled: false,
      },
    });
    renderShell();

    expect(await screen.findByText(strings.composer.messageHeld)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(api.restoreOutbox).toHaveBeenCalledWith("outbox-2", "account-1"),
    );
    expect(useAppStore.getState().composerOpen).toBe(true);
    expect(useAppStore.getState().lastSent).toBeUndefined();
  });

  it("refreshes mail and reports sync failures", async () => {
    renderShell();
    await screen.findByRole("option", { name: /First message/i });

    fireEvent.click(screen.getByRole("button", { name: "Get Mail" }));
    await waitFor(() =>
      expect(mockedSyncAccount).toHaveBeenCalledWith("account-1"),
    );

    mockedSyncAccount.mockRejectedValueOnce(new Error("sync unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Get Mail" }));
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/sync unavailable/i),
    );
  });

  it("merges cached and server search across the account", async () => {
    const cached = { ...firstMessage, subject: "Cached match" };
    const server = { ...secondMessage, subject: "Server match" };
    mockedSearchCached.mockResolvedValue([cached]);
    mockedSearchServer.mockResolvedValue([server]);
    renderShell();
    await screen.findByRole("option", { name: /First message/i });

    const search = screen.getByRole("searchbox", { name: "Search mail" });
    fireEvent.change(search, { target: { value: "project" } });
    fireEvent.submit(screen.getByRole("search"));
    const cachedRow = await screen.findByRole("option", {
      name: /Cached match/i,
    });
    expect(cachedRow).toBeVisible();
    expect(cachedRow).not.toHaveAccessibleName(/In Inbox/);
    expect(
      await screen.findByRole("option", { name: /Server match/i }),
    ).toBeVisible();
    expect(mockedSearchCached).toHaveBeenLastCalledWith({
      accountId: "account-1",
      mailboxId: 1,
      text: "project",
      allFolders: false,
      limit: 250,
    });

    fireEvent.click(screen.getByRole("button", { name: "All folders" }));
    await waitFor(() =>
      expect(mockedSearchServer).toHaveBeenLastCalledWith(
        expect.objectContaining({ allFolders: true }),
      ),
    );
    expect(screen.getByRole("button", { name: "All folders" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("option", { name: /Cached match/i }),
    ).toHaveAccessibleName(/In Inbox/);
  });

  it("archives the focused message with e and leaves it closed", async () => {
    renderShell();
    const row = await screen.findByRole("option", { name: /First message/i });
    fireEvent.keyDown(row, { key: "e" });
    expect(useAppStore.getState().error).toMatch(/does not have that folder/i);
    expect(api.moveMessage).not.toHaveBeenCalled();
    expect(row).toBeInTheDocument();

    const archive = makeMailbox({
      id: 4,
      name: "Archive",
      displayName: "Archive",
      role: "archive",
      unreadCount: 0,
      totalCount: 0,
    });
    useAppStore.setState({ mailboxes: [inbox, archive, trash] });
    vi.mocked(api.moveMessage).mockResolvedValue(undefined);
    fireEvent.keyDown(row, { key: "e" });
    await waitFor(() =>
      expect(api.moveMessage).toHaveBeenCalledWith(
        "account-1",
        firstMessage.id,
        "archive",
        expect.any(String),
      ),
    );
    expect(
      screen.queryByRole("option", { name: /First message/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "First message" }),
    ).not.toBeInTheDocument();
  });

  it("replies to the focused message without opening it", async () => {
    mockedGetMessage.mockRejectedValueOnce(new Error("message missing"));
    renderShell();
    const row = await screen.findByRole("option", { name: /First message/i });
    fireEvent.keyDown(row, { key: "r" });
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/message missing/i),
    );
    expect(useAppStore.getState().composerOpen).toBe(false);

    useAppStore.setState({ error: undefined });
    fireEvent.keyDown(row, { key: "r" });
    await waitFor(() =>
      expect(useAppStore.getState().composeSeed?.composeMode).toBe("reply"),
    );
    expect(useAppStore.getState().composeSeed?.sourceMessage?.id).toBe(
      firstMessage.id,
    );
    expect(useAppStore.getState().composerOpen).toBe(true);
    expect(
      screen.queryByRole("heading", { name: "First message" }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(row, { key: "a" });
    await waitFor(() =>
      expect(useAppStore.getState().composeSeed?.composeMode).toBe("replyAll"),
    );

    useAppStore.getState().closeComposer();
    fireEvent.click(row);
    expect(
      await screen.findByRole("heading", { name: "First message" }),
    ).toBeVisible();
    fireEvent.keyDown(document.body, { key: "r" });
    await waitFor(() =>
      expect(useAppStore.getState().composeSeed?.composeMode).toBe("reply"),
    );
  });

  it("marks the focused message as junk without opening it", async () => {
    renderShell();
    const row = await screen.findByRole("option", { name: /First message/i });
    fireEvent.keyDown(row, { key: "!" });
    expect(useAppStore.getState().error).toMatch(/does not have that folder/i);
    expect(api.moveMessage).not.toHaveBeenCalled();
    expect(row).toBeInTheDocument();

    const junk = makeMailbox({
      id: 6,
      name: "Junk",
      displayName: "Junk",
      role: "junk",
      unreadCount: 0,
      totalCount: 0,
    });
    useAppStore.setState({
      mailboxes: [inbox, junk, trash],
      error: undefined,
    });
    vi.mocked(api.moveMessage).mockResolvedValue(undefined);
    fireEvent.keyDown(row, { key: "!" });
    await waitFor(() =>
      expect(api.moveMessage).toHaveBeenCalledWith(
        "account-1",
        firstMessage.id,
        "junk",
        expect.any(String),
      ),
    );
    expect(
      screen.queryByRole("option", { name: /First message/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "First message" }),
    ).not.toBeInTheDocument();
  });

  it("moves a focused Junk message to Inbox", async () => {
    const junk = makeMailbox({
      id: 6,
      name: "Junk",
      displayName: "Junk",
      role: "junk",
      unreadCount: 0,
      totalCount: 1,
    });
    const filed = makeMessage({
      id: 4,
      mailboxId: junk.id,
      subject: "Junk note",
    });
    mockedListMailboxes.mockResolvedValue([inbox, junk, trash]);
    mockedListMessages.mockResolvedValue({
      items: [filed],
      nextCursor: null,
      hasMore: false,
    });
    useAppStore.setState({
      mailboxes: [inbox, junk, trash],
      activeMailboxId: junk.id,
    });
    vi.mocked(api.moveMessageToMailbox).mockResolvedValue(undefined);
    renderShell();
    fireEvent.keyDown(
      await screen.findByRole("option", { name: /Junk note/i }),
      { key: "!" },
    );
    await waitFor(() =>
      expect(api.moveMessageToMailbox).toHaveBeenCalledWith(
        "account-1",
        filed.id,
        inbox.id,
        expect.any(String),
      ),
    );
    expect(
      screen.queryByRole("heading", { name: "Junk note" }),
    ).not.toBeInTheDocument();
  });

  it("moves the focused message to Trash without opening it", async () => {
    mockedListMailboxes.mockResolvedValue([inbox]);
    useAppStore.setState({ mailboxes: [inbox] });
    renderShell();
    const row = await screen.findByRole("option", { name: /First message/i });
    await waitFor(() =>
      expect(
        useAppStore.getState().mailboxes.some((box) => box.role === "trash"),
      ).toBe(false),
    );
    fireEvent.keyDown(row, { key: "Delete" });
    expect(useAppStore.getState().error).toMatch(/does not have that folder/i);
    expect(api.moveMessage).not.toHaveBeenCalled();

    useAppStore.setState({ mailboxes: [inbox, trash], error: undefined });
    vi.mocked(api.moveMessage).mockResolvedValue(undefined);
    fireEvent.keyDown(row, { key: "#" });
    await waitFor(() =>
      expect(api.moveMessage).toHaveBeenCalledWith(
        "account-1",
        firstMessage.id,
        "trash",
        expect.any(String),
      ),
    );
    expect(
      screen.queryByRole("option", { name: /First message/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "First message" }),
    ).not.toBeInTheDocument();
    expect(api.showNativeConfirm).not.toHaveBeenCalled();
  });

  it("deletes a focused Trash message after confirmation", async () => {
    const filed = makeMessage({
      id: 3,
      mailboxId: trash.id,
      subject: "Filed note",
    });
    mockedListMessages.mockResolvedValue({
      items: [filed],
      nextCursor: null,
      hasMore: false,
    });
    useAppStore.setState({ activeMailboxId: trash.id });
    vi.mocked(api.showNativeConfirm).mockResolvedValueOnce(false);
    vi.mocked(api.deleteTrashMessages).mockResolvedValue(undefined);
    renderShell();
    const row = await screen.findByRole("option", { name: /Filed note/i });
    fireEvent.keyDown(row, { key: "Delete" });
    await waitFor(() => expect(api.showNativeConfirm).toHaveBeenCalled());
    expect(api.deleteTrashMessages).not.toHaveBeenCalled();
    expect(row).toBeInTheDocument();

    vi.mocked(api.showNativeConfirm).mockResolvedValueOnce(true);
    fireEvent.keyDown(row, { key: "Delete" });
    await waitFor(() =>
      expect(api.deleteTrashMessages).toHaveBeenCalledWith("account-1", [
        filed.id,
      ]),
    );
    expect(
      screen.queryByRole("option", { name: /Filed note/i }),
    ).not.toBeInTheDocument();
  });

  it("moves a focused Archive message to Inbox", async () => {
    const archive = makeMailbox({
      id: 4,
      name: "Archive",
      displayName: "Archive",
      role: "archive",
      unreadCount: 0,
      totalCount: 1,
    });
    const filed = makeMessage({
      id: 3,
      mailboxId: archive.id,
      subject: "Filed note",
    });
    mockedListMailboxes.mockResolvedValue([inbox, archive, trash]);
    mockedListMessages.mockResolvedValue({
      items: [filed],
      nextCursor: null,
      hasMore: false,
    });
    useAppStore.setState({
      mailboxes: [inbox, archive, trash],
      activeMailboxId: archive.id,
    });
    vi.mocked(api.moveMessageToMailbox).mockResolvedValue(undefined);
    renderShell();
    fireEvent.keyDown(
      await screen.findByRole("option", { name: /Filed note/i }),
      { key: "e" },
    );
    await waitFor(() =>
      expect(api.moveMessageToMailbox).toHaveBeenCalledWith(
        "account-1",
        filed.id,
        inbox.id,
        expect.any(String),
      ),
    );
    expect(
      screen.queryByRole("heading", { name: "Filed note" }),
    ).not.toBeInTheDocument();
  });

  it("checks the focused message with x and leaves it closed", async () => {
    renderShell();
    const row = await screen.findByRole("option", { name: /First message/i });
    fireEvent.keyDown(row, { key: "x" });
    expect(
      await screen.findByRole("toolbar", { name: "1 selected" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "First message" }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(row, { key: "x" });
    expect(
      await screen.findByRole("toolbar", { name: "0 selected" }),
    ).toBeVisible();
  });

  it("searches the whole account for mail from the sender", async () => {
    mockedSearchCached.mockResolvedValue([]);
    mockedSearchServer.mockResolvedValue([]);
    renderShell();
    await screen.findByRole("option", { name: /First message/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "messages-from-sender",
          target: { kind: "message", messageId: firstMessage.id },
        },
      }),
    );
    await waitFor(() =>
      expect(mockedSearchCached).toHaveBeenCalledWith({
        accountId: "account-1",
        mailboxId: inbox.id,
        text: 'from:"jane@example.test"',
        allFolders: true,
        limit: 250,
      }),
    );
    expect(screen.getByRole("searchbox", { name: "Search mail" })).toHaveValue(
      'from:"jane@example.test"',
    );
    expect(
      screen.getByRole("button", { name: strings.mail.searchAllFolders }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("searches the whole account for mail with this subject", async () => {
    const reply = { ...firstMessage, subject: "Re: Fwd: Picnic plans" };
    mockedListMessages.mockResolvedValue({
      items: [reply],
      nextCursor: null,
      hasMore: false,
    });
    mockedSearchCached.mockResolvedValue([]);
    mockedSearchServer.mockResolvedValue([]);
    renderShell();
    await screen.findByRole("option", { name: /Picnic plans/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "messages-with-subject",
          target: { kind: "message", messageId: reply.id },
        },
      }),
    );
    await waitFor(() =>
      expect(mockedSearchCached).toHaveBeenCalledWith({
        accountId: "account-1",
        mailboxId: inbox.id,
        text: 'subject:"Picnic plans"',
        allFolders: true,
        limit: 250,
      }),
    );
    expect(screen.getByRole("searchbox", { name: "Search mail" })).toHaveValue(
      'subject:"Picnic plans"',
    );
  });

  it("writes to an address and searches mail sent to it", async () => {
    mockedSearchCached.mockResolvedValue([]);
    mockedSearchServer.mockResolvedValue([]);
    renderShell();
    await screen.findByRole("option", { name: /First message/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "compose-to-address",
          target: {
            kind: "address",
            address: "Lee <lee@example.test>",
          },
        },
      }),
    );
    expect(useAppStore.getState().composeSeed?.prefill?.to).toEqual([
      "lee@example.test",
    ]);
    useAppStore.getState().closeComposer();
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "messages-to-address",
          target: { kind: "address", address: "Lee <lee@example.test>" },
        },
      }),
    );
    await waitFor(() =>
      expect(mockedSearchCached).toHaveBeenCalledWith({
        accountId: "account-1",
        mailboxId: inbox.id,
        text: 'to:"lee@example.test"',
        allFolders: true,
        limit: 250,
      }),
    );
    expect(screen.getByRole("searchbox", { name: "Search mail" })).toHaveValue(
      'to:"lee@example.test"',
    );
  });

  it("leaves search and opens the folder a result came from", async () => {
    const filed = makeMessage({
      id: 8,
      mailboxId: trash.id,
      subject: "Filed away",
    });
    mockedSearchCached.mockResolvedValue([filed]);
    mockedSearchServer.mockResolvedValue([]);
    mockedGetMessage.mockImplementation(async (_accountId, messageId) => {
      if (messageId === filed.id) return toDetail(filed);
      const summary = messages.find((item) => item.id === messageId);
      if (!summary) throw new Error("message missing");
      return toDetail(summary);
    });
    renderShell();
    await screen.findByRole("option", { name: /First message/i });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search mail" }), {
      target: { value: "filed" },
    });
    fireEvent.submit(screen.getByRole("search"));
    fireEvent.click(await screen.findByRole("option", { name: /Filed away/i }));
    // Highlight marks split the subject; browsers still name it "Filed away".
    expect(
      await screen.findByRole("heading", { name: /^Filed\s?away$/ }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.showDetails }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: strings.reader.showInFolder("Trash"),
      }),
    );
    expect(useAppStore.getState().activeMailboxId).toBe(trash.id);
    expect(useAppStore.getState().selectedMessage?.subject).toBe("Filed away");
    expect(screen.getByRole("searchbox", { name: "Search mail" })).toHaveValue(
      "",
    );
  });

  it("keeps cached search results when server search fails", async () => {
    mockedSearchCached.mockResolvedValue([
      { ...firstMessage, subject: "Offline match" },
    ]);
    mockedSearchServer.mockRejectedValue(new Error("server offline"));
    renderShell();
    await screen.findByRole("option", { name: /First message/i });

    fireEvent.change(screen.getByRole("searchbox", { name: "Search mail" }), {
      target: { value: "offline" },
    });
    fireEvent.submit(screen.getByRole("search"));

    expect(
      await screen.findByRole("option", { name: /Offline match/i }),
    ).toBeVisible();
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(
        /server search unavailable/i,
      ),
    );
  });

  it("lists unread mail when Unread is chosen, including a fresh request", async () => {
    const readMessage = makeMessage({ id: 2, isRead: true });
    mockedListMessages.mockImplementation(async (...args: unknown[]) => {
      const filter = args[4];
      return {
        items:
          filter === "unread" ? [firstMessage] : [firstMessage, readMessage],
        nextCursor: null,
        hasMore: false,
      };
    });
    renderShell();

    expect(
      await screen.findByRole("option", { name: /Second message/i }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("radio", { name: "Unread" }));

    await waitFor(() =>
      expect(mockedListMessages).toHaveBeenCalledWith(
        "account-1",
        1,
        undefined,
        100,
        "unread",
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("option", { name: /Second message/i }),
      ).toBeNull(),
    );
    expect(
      screen.getByRole("option", { name: /First message/i }),
    ).toBeVisible();
    expect(screen.getByRole("radio", { name: "Unread" })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
    await waitFor(() =>
      expect(screen.queryByRole("radiogroup", { name: "Show" })).toBeNull(),
    );
  });

  it("lists pinned mail when Pinned is chosen", async () => {
    const pinned = makeMessage({
      id: 1,
      subject: "Pinned note",
      pinned: true,
    });
    const plain = makeMessage({ id: 2, subject: "Plain note" });
    mockedListMessages.mockImplementation(async (...args: unknown[]) => {
      const filter = args[4];
      return {
        items: filter === "pinned" ? [pinned] : [pinned, plain],
        nextCursor: null,
        hasMore: false,
      };
    });
    renderShell();

    expect(
      await screen.findByRole("option", { name: /Plain note/i }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /^More filters/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Pinned" }));

    await waitFor(() =>
      expect(mockedListMessages).toHaveBeenCalledWith(
        "account-1",
        1,
        undefined,
        100,
        "pinned",
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: /Plain note/i })).toBeNull(),
    );
    expect(screen.getByRole("option", { name: /Pinned note/i })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "More filters: Pinned" }),
    ).toBeVisible();
  });

  it("says when the mailbox has no pinned mail", async () => {
    mockedListMessages.mockImplementation(async (...args: unknown[]) => {
      const filter = args[4];
      return {
        items: filter === "pinned" ? [] : [firstMessage],
        nextCursor: null,
        hasMore: false,
      };
    });
    renderShell();
    await screen.findByRole("option", { name: /First message/i });
    fireEvent.click(screen.getByRole("button", { name: /^More filters/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Pinned" }));
    expect(await screen.findByText(strings.mail.noPinned)).toBeVisible();
  });

  it("sorts the mailbox from the menu and keeps that order flat", async () => {
    renderShell();
    await screen.findByRole("option", { name: /First message/i });

    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "From" }));

    await waitFor(() =>
      expect(mockedListMessages).toHaveBeenCalledWith(
        "account-1",
        1,
        undefined,
        100,
        undefined,
        "sender",
      ),
    );
    expect(document.querySelector(".list-day")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    expect(screen.getByRole("menuitemradio", { name: "From" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemradio", { name: "Date" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("loads another mailbox page", async () => {
    mockedListMessages
      .mockResolvedValueOnce({
        items: messages,
        nextCursor: { receivedAt: firstMessage.receivedAt, uid: 1 },
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [makeMessage({ id: 3 })],
        nextCursor: null,
        hasMore: false,
      });
    renderShell();

    fireEvent.click(
      await screen.findByRole("button", { name: "Load older mail" }),
    );
    expect(
      await screen.findByRole("option", { name: /Subject 3/i }),
    ).toBeVisible();
    expect(mockedListMessages).toHaveBeenLastCalledWith("account-1", 1, {
      receivedAt: firstMessage.receivedAt,
      uid: 1,
    });
  });

  it("creates, renames, cancels, and deletes personal folders", async () => {
    const projects = makeMailbox({
      id: 4,
      name: "Projects",
      displayName: "Projects",
      role: "other",
      unreadCount: 0,
      totalCount: 0,
    });
    resetStore({
      accounts: [account],
      activeAccountId: account.id,
      mailboxes: [inbox, trash, projects],
      activeMailboxId: inbox.id,
    });
    mockedListMailboxes.mockResolvedValue([inbox, trash, projects]);
    renderShell();
    await screen.findByRole("button", { name: "Projects" });

    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(screen.getByPlaceholderText("Folder name"), {
      target: { value: "Receipts" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    await waitFor(() =>
      expect(mockedCreateFolder).toHaveBeenCalledWith("account-1", "Receipts"),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Rename folder Projects" }),
    );
    fireEvent.change(screen.getByPlaceholderText("Folder name"), {
      target: { value: "Client work" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("Folder name"), {
      key: "Escape",
    });
    expect(mockedRenameFolder).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Rename folder Projects" }),
    );
    fireEvent.change(screen.getByPlaceholderText("Folder name"), {
      target: { value: "Client work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() =>
      expect(mockedRenameFolder).toHaveBeenCalledWith(
        "account-1",
        4,
        "Client work",
      ),
    );

    vi.mocked(api.showNativeConfirm).mockResolvedValueOnce(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Delete folder Projects" }),
    );
    await waitFor(() => expect(api.showNativeConfirm).toHaveBeenCalled());
    expect(mockedDeleteFolder).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Delete folder Projects" }),
    );
    await waitFor(() =>
      expect(mockedDeleteFolder).toHaveBeenCalledWith("account-1", 4),
    );
  });

  it("empties populated Trash and Junk after confirmation", async () => {
    const fullTrash = { ...trash, totalCount: 2 };
    const junk = makeMailbox({
      id: 5,
      name: "Junk",
      displayName: "Junk",
      role: "junk",
      unreadCount: 0,
      totalCount: 1,
    });
    resetStore({
      accounts: [account],
      activeAccountId: account.id,
      mailboxes: [inbox, fullTrash, junk],
      activeMailboxId: fullTrash.id,
    });
    mockedListMailboxes.mockResolvedValue([inbox, fullTrash, junk]);
    mockedListMessages.mockResolvedValue({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    renderShell();

    fireEvent.click(await screen.findByRole("button", { name: "Empty trash" }));
    await waitFor(() =>
      expect(api.emptyTrash).toHaveBeenCalledWith("account-1"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Junk" }));
    fireEvent.click(await screen.findByRole("button", { name: "Empty junk" }));
    await waitFor(() =>
      expect(api.emptyJunk).toHaveBeenCalledWith("account-1"),
    );
  });

  it("opens a saved draft from the local list", async () => {
    const summary = {
      id: "draft-1",
      accountId: account.id,
      recipients: "lee@example.com",
      subject: "Draft subject",
      updatedAt: "2026-08-18T11:00:00Z",
      syncState: "synced" as const,
    };
    const draft = {
      id: summary.id,
      accountId: account.id,
      to: ["lee@example.com"],
      cc: [],
      bcc: [],
      subject: summary.subject,
      htmlBody: "<p>Draft</p>",
      textBody: "Draft",
      attachments: [],
    };
    mockedListDrafts.mockResolvedValue([summary]);
    mockedGetDraft.mockResolvedValue(draft);
    useAppStore.setState({ activeLocalView: "drafts", drafts: [summary] });
    renderShell();

    fireEvent.click(
      await screen.findByRole("button", { name: /Draft subject/i }),
    );
    await waitFor(() =>
      expect(mockedGetDraft).toHaveBeenCalledWith("draft-1", "account-1"),
    );
    expect(useAppStore.getState().composeSeed?.draft).toEqual(draft);
  });

  it("handles retry, sent-copy, and discard outbox actions", async () => {
    const base = {
      accountId: account.id,
      recipients: "lee@example.com",
      createdAt: "2026-08-18T11:00:00Z",
    };
    const items = [
      {
        ...base,
        id: "attention",
        subject: "Maybe sent",
        state: "needs_attention" as const,
      },
      {
        ...base,
        id: "copy",
        subject: "Copy pending",
        state: "sent_copy_pending" as const,
      },
      {
        ...base,
        id: "queued",
        subject: "Queued note",
        state: "queued" as const,
      },
    ];
    mockedListOutbox.mockResolvedValue(items);
    useAppStore.setState({ activeLocalView: "outbox", outbox: items });
    vi.mocked(api.showNativeConfirm).mockResolvedValueOnce(false);
    renderShell();

    fireEvent.click(
      await screen.findByRole("button", { name: "Retry sending" }),
    );
    await waitFor(() => expect(api.showNativeConfirm).toHaveBeenCalled());
    expect(api.retryOutbox).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry sending" }));
    await waitFor(() =>
      expect(api.retryOutbox).toHaveBeenCalledWith("attention", "account-1"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save Sent copy" }));
    await waitFor(() =>
      expect(api.retrySentCopy).toHaveBeenCalledWith("copy", "account-1"),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Discard" })[1]);
    await waitFor(() =>
      expect(api.deleteOutbox).toHaveBeenCalledWith("queued", "account-1"),
    );
  });

  it("reports partial and missing-target bulk operations", async () => {
    mockedSetMessagesFlags.mockResolvedValue({
      updated: 0,
      queued: 0,
      failed: 1,
    });
    renderShell();
    await screen.findByRole("option", { name: /First message/i });

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /First message/i }));
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark unread" }));
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/1 message could not/i),
    );

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /First message/i }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(useAppStore.getState().error).toBe(strings.mail.noTargetFolder);
  });

  it("bridges menu and keyboard actions into mailbox state", async () => {
    const onOpenSettings = vi.fn();
    renderShell(onOpenSettings);
    await screen.findByRole("option", { name: /First message/i });

    window.dispatchEvent(
      new CustomEvent("postal:menu-action", { detail: "compose" }),
    );
    expect(useAppStore.getState().composerOpen).toBe(true);
    useAppStore.getState().closeComposer();
    window.dispatchEvent(
      new CustomEvent("postal:menu-action", { detail: "settings" }),
    );
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    window.dispatchEvent(
      new CustomEvent("postal:menu-action", { detail: "text-larger" }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().settings.textScale).toBe(1.15),
    );
    window.dispatchEvent(
      new CustomEvent("postal:menu-action", { detail: "reading-pane-bottom" }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().settings.readingPane).toBe("bottom"),
    );

    fireEvent.keyDown(window, { key: "/" });
    expect(
      screen.getByRole("searchbox", { name: "Search mail" }),
    ).toHaveFocus();
    fireEvent.keyDown(window, { key: "F5" });
    await waitFor(() => expect(mockedSyncAccount).toHaveBeenCalled());
  });

  it("closes mailbox action menu with Escape and outside click", async () => {
    renderShell();
    await screen.findByRole("option", { name: /First message/i });
    const trigger = screen.getByRole("button", {
      name: "More mailbox actions",
    });

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(
      await screen.findByRole("menuitemradio", { name: "Date" }),
    ).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(
      screen.queryByRole("menuitem", { name: "Mark all read" }),
    ).toBeNull();

    fireEvent.click(trigger);
    expect(
      await screen.findByRole("menuitem", { name: "Mark all read" }),
    ).toBeVisible();
    fireEvent.mouseDown(document.body);
    expect(
      screen.queryByRole("menuitem", { name: "Mark all read" }),
    ).toBeNull();
  });

  it("supports global message navigation and mail shortcuts", async () => {
    const actions: string[] = [];
    const menuListener = (event: Event) => {
      actions.push((event as CustomEvent<string>).detail);
    };
    const scrollListener = vi.fn();
    window.addEventListener("postal:menu-action", menuListener);
    window.addEventListener("postal:scroll-reader", scrollListener);
    // Flat list order; grouped conversation order is covered in e2e.
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, groupThreads: false },
    });
    renderShell();
    await screen.findByRole("option", { name: /First message/i });

    fireEvent.keyDown(document.body, { key: "j" });
    expect(
      await screen.findByRole("heading", { name: "First message" }),
    ).toBeVisible();
    fireEvent.keyDown(document.body, { key: "j" });
    expect(
      await screen.findByRole("heading", { name: "Second message" }),
    ).toBeVisible();
    fireEvent.keyDown(document.body, { key: "k" });
    expect(
      await screen.findByRole("heading", { name: "First message" }),
    ).toBeVisible();
    fireEvent.keyDown(document.body, { key: "End" });
    expect(
      await screen.findByRole("heading", { name: "Second message" }),
    ).toBeVisible();
    fireEvent.keyDown(document.body, { key: "Home" });
    expect(
      await screen.findByRole("heading", { name: "First message" }),
    ).toBeVisible();
    fireEvent.keyDown(document.body, { key: "Delete" });

    fireEvent.keyDown(document.body, { key: " " });
    fireEvent.keyDown(document.body, { key: " ", shiftKey: true });
    expect(scrollListener).toHaveBeenCalledTimes(2);
    expect((scrollListener.mock.calls[0][0] as CustomEvent).detail).toBe(1);
    expect((scrollListener.mock.calls[1][0] as CustomEvent).detail).toBe(-1);

    fireEvent.keyDown(document.body, { key: "r", ctrlKey: true });
    fireEvent.keyDown(document.body, {
      key: "r",
      ctrlKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(document.body, {
      key: "f",
      ctrlKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(document.body, { key: "e", ctrlKey: true });
    fireEvent.keyDown(document.body, {
      key: "a",
      ctrlKey: true,
      metaKey: true,
    });
    fireEvent.keyDown(document.body, {
      key: "u",
      ctrlKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(document.body, {
      key: "l",
      ctrlKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(document.body, {
      key: "j",
      ctrlKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(document.body, {
      key: "ArrowRight",
      ctrlKey: true,
      altKey: true,
    });
    fireEvent.keyDown(document.body, {
      key: "ArrowDown",
      ctrlKey: true,
      altKey: true,
    });
    fireEvent.keyDown(document.body, {
      key: "ArrowUp",
      ctrlKey: true,
      altKey: true,
    });
    fireEvent.keyDown(document.body, {
      key: "f",
      ctrlKey: true,
      altKey: true,
    });
    expect(actions).toEqual(
      expect.arrayContaining([
        "reply-preferred",
        "reply-all",
        "forward",
        "archive",
        "toggle-read",
        "toggle-star",
        "junk",
        "reading-pane-right",
        "reading-pane-bottom",
        "reading-pane-hidden",
        "trash",
      ]),
    );

    fireEvent.keyDown(document.body, { key: "n", ctrlKey: true });
    expect(useAppStore.getState().composerOpen).toBe(true);
    window.removeEventListener("postal:menu-action", menuListener);
    window.removeEventListener("postal:scroll-reader", scrollListener);
  });

  it("leaves Space available for local-mail action buttons", async () => {
    const held = {
      id: "attention-space",
      accountId: account.id,
      recipients: "lee@example.com",
      subject: "Needs retry",
      state: "needs_attention" as const,
      detail: "Held for review.",
      createdAt: "2026-08-18T11:00:00Z",
    };
    mockedListOutbox.mockResolvedValue([held]);
    useAppStore.setState({ activeLocalView: "outbox", outbox: [held] });
    renderShell();

    const retry = await screen.findByRole("button", {
      name: "Retry sending",
    });
    const event = new KeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      bubbles: true,
      cancelable: true,
    });

    expect(retry.dispatchEvent(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
  });

  it("automatically submits overdue scheduled mail while online", async () => {
    const held = {
      id: "due-now",
      accountId: account.id,
      recipients: "lee@example.com",
      subject: "Due note",
      state: "scheduled",
      detail: "Held for review.",
      createdAt: "2026-08-18T11:00:00Z",
      sendAt: new Date(Date.now() - 1000).toISOString(),
    } as const;
    mockedListOutbox.mockResolvedValue([held]);
    vi.mocked(api.sendScheduledOutbox).mockResolvedValue({
      id: held.id,
      state: "sent",
      detail: null,
    });
    useAppStore.setState({ activeLocalView: "outbox", outbox: [held] });
    renderShell();

    await waitFor(() =>
      expect(api.sendScheduledOutbox).toHaveBeenCalledWith(
        "due-now",
        "account-1",
      ),
    );
  });

  it("refreshes local data from every native change bridge", async () => {
    let folderChanged: ((event: { accountId: string }) => void) | undefined;
    let draftChanged: ((event: { accountId: string }) => void) | undefined;
    let outboxChanged: ((event: { accountId: string }) => void) | undefined;
    const stops = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    mockedOnFolderCountsChanged.mockImplementation(async (handler) => {
      folderChanged = handler;
      return stops[0];
    });
    vi.mocked(api.onDraftSyncChanged).mockImplementation(async (handler) => {
      draftChanged = handler;
      return stops[1];
    });
    vi.mocked(api.onOutboxChanged).mockImplementation(async (handler) => {
      outboxChanged = handler;
      return stops[2];
    });
    mockedOnMessageChanged.mockResolvedValue(stops[3]);
    const { unmount } = renderShell();
    await screen.findByRole("option", { name: /First message/i });
    await waitFor(() => {
      expect(folderChanged).toBeTypeOf("function");
      expect(draftChanged).toBeTypeOf("function");
      expect(outboxChanged).toBeTypeOf("function");
    });
    const before = mockedListMailboxes.mock.calls.length;

    folderChanged?.({ accountId: account.id });
    draftChanged?.({ accountId: account.id });
    outboxChanged?.({ accountId: account.id });
    window.dispatchEvent(
      new CustomEvent("postal:local-mail-changed", { detail: account.id }),
    );
    await waitFor(() =>
      expect(mockedListMailboxes.mock.calls.length).toBeGreaterThan(before),
    );
    unmount();
    expect(stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
  });

  it("opens and escapes the narrow-window mailbox drawer", async () => {
    const removeMediaListener = vi.fn();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: removeMediaListener,
      })),
    );
    const { container, unmount } = renderShell();
    await screen.findByRole("option", { name: /First message/i });

    const toggle = screen.getByRole("button", { name: "Show mailboxes" });
    fireEvent.click(toggle);
    expect(container.querySelector(".mail-shell")).toHaveClass("sidebar-open");
    // jsdom lacks `inert`; the drawer falls back to aria-hidden plus a trap.
    expect(document.getElementById("message-pane")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".mail-shell")).not.toHaveClass(
      "sidebar-open",
    );
    expect(document.getElementById("message-pane")).not.toHaveAttribute(
      "aria-hidden",
    );

    unmount();
    expect(removeMediaListener).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("persists the desktop sidebar and resets mailbox state when switching accounts", async () => {
    const secondAccount = makeAccount("account-2");
    resetStore({
      accounts: [account, secondAccount],
      activeAccountId: account.id,
      mailboxes: [inbox, trash],
      activeMailboxId: inbox.id,
    });
    renderShell();
    await screen.findByRole("option", { name: /First message/i });

    fireEvent.click(screen.getByRole("button", { name: "Hide mailboxes" }));
    await waitFor(() =>
      expect(useAppStore.getState().settings.sidebarVisible).toBe(false),
    );
    expect(mockedSaveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ sidebarVisible: false }),
    );

    mockedSaveSettings.mockRejectedValueOnce(new Error("settings read-only"));
    fireEvent.click(screen.getByRole("button", { name: "Show mailboxes" }));
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/settings read-only/i),
    );

    switchToAccount(secondAccount.id);
    await waitFor(() =>
      expect(useAppStore.getState().activeAccountId).toBe(secondAccount.id),
    );
    expect(useAppStore.getState().activeLocalView).toBeUndefined();
    expect(useAppStore.getState().selectedMessage).toBeUndefined();
  });

  it("reports folder creation, deletion, and emptying failures", async () => {
    const fullTrash = { ...trash, totalCount: 2 };
    const junk = makeMailbox({
      id: 4,
      name: "Junk",
      displayName: "Junk",
      role: "junk",
      unreadCount: 0,
      totalCount: 1,
    });
    const projects = makeMailbox({
      id: 5,
      name: "Projects",
      displayName: "Projects",
      role: "other",
      unreadCount: 0,
      totalCount: 0,
    });
    const folders = [inbox, fullTrash, junk, projects];
    resetStore({
      accounts: [account],
      activeAccountId: account.id,
      mailboxes: folders,
      activeMailboxId: inbox.id,
    });
    mockedListMailboxes.mockResolvedValue(folders);
    mockedCreateFolder.mockRejectedValueOnce(new Error("create denied"));
    mockedDeleteFolder.mockRejectedValueOnce(new Error("delete denied"));
    vi.mocked(api.emptyTrash).mockRejectedValueOnce(new Error("trash busy"));
    vi.mocked(api.emptyJunk).mockRejectedValueOnce(new Error("junk busy"));
    renderShell();
    await screen.findByRole("button", { name: "Projects" });

    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(screen.getByPlaceholderText("Folder name"), {
      target: { value: "Receipts" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/create denied/i),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.common.cancel }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Delete folder Projects" }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/delete denied/i),
    );

    fireEvent.click(screen.getByRole("button", { name: "Trash" }));
    fireEvent.click(await screen.findByRole("button", { name: "Empty trash" }));
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/trash busy/i),
    );

    fireEvent.click(screen.getByRole("button", { name: "Junk" }));
    fireEvent.click(await screen.findByRole("button", { name: "Empty junk" }));
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/junk busy/i),
    );
  });

  it("reports failed bulk mutations while preserving the selection", async () => {
    const archive = makeMailbox({
      id: 4,
      name: "Archive",
      displayName: "Archive",
      role: "archive",
      unreadCount: 0,
      totalCount: 0,
    });
    const folders = [inbox, archive, trash];
    resetStore({
      accounts: [account],
      activeAccountId: account.id,
      mailboxes: folders,
      activeMailboxId: inbox.id,
    });
    mockedListMailboxes.mockResolvedValue(folders);
    mockedSetMessagesFlags.mockRejectedValueOnce(
      new Error("flag batch failed"),
    );
    mockedMoveMessagesToMailbox.mockRejectedValueOnce(
      new Error("move batch failed"),
    );
    mockedMarkMailboxRead
      .mockResolvedValueOnce({ updated: 1, queued: 0, failed: 1 })
      .mockRejectedValueOnce(new Error("mark all failed"));
    renderShell();
    await screen.findByRole("option", { name: /First message/i });

    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /First message/i }));
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark read" }));
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/flag batch failed/i),
    );
    expect(screen.getByRole("toolbar", { name: "1 selected" })).toBeVisible();

    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "1 selected" })).getByRole(
        "button",
        { name: "Archive" },
      ),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/move batch failed/i),
    );
    expect(screen.getByRole("toolbar", { name: "1 selected" })).toBeVisible();

    const mailboxMenu = screen.getByRole("button", {
      name: "More mailbox actions",
    });
    fireEvent.click(mailboxMenu);
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark all read" }));
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/1 message could not/i),
    );
    fireEvent.click(mailboxMenu);
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark all read" }));
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/mark all failed/i),
    );
  });

  it("opens snoozed mail and reports local-list failures", async () => {
    const snoozed = {
      message: firstMessage,
      snoozedUntil: "2026-09-01T08:00:00+00:00",
    };
    const draft = {
      id: "broken-draft",
      accountId: account.id,
      recipients: "lee@example.com",
      subject: "Broken draft",
      updatedAt: "2026-08-18T11:00:00Z",
      syncState: "localOnly" as const,
    };
    mockedListSnoozed.mockResolvedValue([snoozed]);
    mockedListDrafts.mockResolvedValue([draft]);
    useAppStore.setState({
      activeLocalView: "snoozed",
      snoozed: [snoozed],
      drafts: [draft],
    });
    renderShell();

    fireEvent.click(
      await screen.findByRole("button", {
        name: /^Unread, Jane, First message, Snoozed until/,
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "First message" }),
    ).toBeVisible();
    expect(mockedSetMessageFlags).toHaveBeenCalledWith(
      "account-1",
      firstMessage.id,
      true,
      undefined,
    );

    mockedUnsnoozeMessage.mockRejectedValueOnce(new Error("unsnooze failed"));
    fireEvent.click(
      screen.getByRole("button", { name: "Bring back First message" }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/unsnooze failed/i),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Drafts/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Broken draft/i }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/draft missing/i),
    );
  });

  it("duplicates a draft as a new unscheduled message", async () => {
    const summary = {
      id: "draft-1",
      accountId: account.id,
      recipients: "pat@example.com",
      subject: "Family update",
      updatedAt: "2026-08-18T11:00:00Z",
      syncState: "synced" as const,
    };
    const draft = {
      id: "draft-1",
      accountId: account.id,
      to: ["pat@example.com"],
      cc: [] as string[],
      bcc: [] as string[],
      subject: "Family update",
      htmlBody: "<p>Draft message</p>",
      textBody: "Draft message",
      attachments: [{ token: "file-1", filename: "notes.txt", inline: false }],
      sendAt: "2026-12-01T15:00:00Z",
    };
    mockedListDrafts.mockResolvedValue([summary]);
    mockedGetDraft.mockResolvedValue(draft);
    mockedSaveDraft.mockResolvedValue({
      id: "draft-2",
      syncState: "localPending",
    });
    useAppStore.setState({ activeLocalView: "drafts", drafts: [summary] });
    renderShell();
    await screen.findByRole("button", { name: /Family update/i });

    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "duplicate-draft",
          target: { kind: "draft", draftId: "draft-1" },
        },
      }),
    );

    await waitFor(() => expect(mockedSaveDraft).toHaveBeenCalled());
    expect(mockedSaveDraft.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        id: undefined,
        sendAt: null,
        subject: "Family update",
        attachments: draft.attachments,
      }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().composeSeed?.draft?.id).toBe("draft-2"),
    );
    expect(useAppStore.getState().composeSeed?.draft?.sendAt).toBeNull();
    expect(useAppStore.getState().composerOpen).toBe(true);
  });

  it("discards a draft from the drafts list", async () => {
    const summary = {
      id: "draft-1",
      accountId: account.id,
      recipients: "pat@example.com",
      subject: "Family update",
      updatedAt: "2026-08-18T11:00:00Z",
      syncState: "synced" as const,
    };
    mockedListDrafts.mockResolvedValue([summary]);
    vi.mocked(api.deleteDraft).mockResolvedValue(undefined);
    vi.mocked(api.showNativeConfirm).mockResolvedValueOnce(false);
    useAppStore.setState({
      activeLocalView: "drafts",
      drafts: [summary],
      composerOpen: true,
      composeSeed: {
        draft: {
          id: "draft-1",
          accountId: account.id,
          to: ["pat@example.com"],
          cc: [],
          bcc: [],
          subject: "Family update",
          htmlBody: "<p>Draft message</p>",
          textBody: "Draft message",
          attachments: [],
        },
      },
    });
    renderShell();
    await screen.findByRole("button", { name: /Family update/i });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: {
            id: "delete-draft",
            target: { kind: "draft", draftId: "draft-1" },
          },
        }),
      );
    });
    await waitFor(() => expect(api.showNativeConfirm).toHaveBeenCalled());
    expect(api.deleteDraft).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /Family update/i }),
    ).toBeVisible();

    vi.mocked(api.showNativeConfirm).mockResolvedValueOnce(true);
    mockedListDrafts.mockResolvedValue([]);
    act(() => {
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: {
            id: "delete-draft",
            target: { kind: "draft", draftId: "draft-1" },
          },
        }),
      );
    });
    await waitFor(() =>
      expect(api.deleteDraft).toHaveBeenCalledWith("draft-1", "account-1"),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Family update/i }),
      ).toBeNull(),
    );
    expect(useAppStore.getState().composerOpen).toBe(false);
  });

  it("checks mail and marks another folder read from the folder menu", async () => {
    const archive = makeMailbox({
      id: 2,
      name: "Archive",
      displayName: "Archive",
      role: "archive",
      unreadCount: 2,
      totalCount: 2,
    });
    resetStore({
      accounts: [account],
      activeAccountId: account.id,
      mailboxes: [inbox, archive, trash],
      activeMailboxId: inbox.id,
    });
    mockedListMailboxes.mockResolvedValue([inbox, archive, trash]);
    mockedMarkMailboxRead.mockResolvedValue({
      updated: 2,
      queued: 0,
      failed: 0,
    });
    renderShell();
    await screen.findByRole("button", { name: /^Archive/ });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: {
            id: "get-mail",
            target: { kind: "folder", mailboxId: archive.id },
          },
        }),
      );
    });
    await waitFor(() =>
      expect(mockedSyncAccount).toHaveBeenCalledWith("account-1"),
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: {
            id: "mark-all-read",
            target: { kind: "folder", mailboxId: archive.id },
          },
        }),
      );
    });
    await waitFor(() =>
      expect(mockedMarkMailboxRead).toHaveBeenCalledWith("account-1", 2),
    );
    expect(useAppStore.getState().activeMailboxId).toBe(inbox.id);
  });

  it("reports every outbox recovery failure", async () => {
    const base = {
      accountId: account.id,
      recipients: "lee@example.com",
      createdAt: "2026-08-18T11:00:00Z",
    };
    const items = [
      {
        ...base,
        id: "attention-fail",
        subject: "Retry failure",
        state: "needs_attention" as const,
      },
      {
        ...base,
        id: "copy-fail",
        subject: "Copy failure",
        state: "sent_copy_pending" as const,
      },
      {
        ...base,
        id: "scheduled-fail",
        subject: "Schedule failure",
        state: "scheduled" as const,
        sendAt: new Date(Date.now() + 60_000).toISOString(),
      },
      {
        ...base,
        id: "queued-fail",
        subject: "Discard failure",
        state: "queued" as const,
      },
    ];
    mockedListOutbox.mockResolvedValue(items);
    useAppStore.setState({ activeLocalView: "outbox", outbox: items });
    vi.mocked(api.retryOutbox).mockRejectedValueOnce(new Error("retry failed"));
    vi.mocked(api.retrySentCopy).mockRejectedValueOnce(
      new Error("copy retry failed"),
    );
    vi.mocked(api.sendScheduledOutbox).mockRejectedValueOnce(
      new Error("send now failed"),
    );
    vi.mocked(api.restoreOutbox).mockRejectedValueOnce(
      new Error("undo failed"),
    );
    vi.mocked(api.deleteOutbox).mockRejectedValueOnce(
      new Error("discard failed"),
    );
    renderShell();
    await screen.findByText("Retry failure");

    fireEvent.click(
      within(screen.getByText("Retry failure").closest("article")!).getByRole(
        "button",
        { name: "Retry sending" },
      ),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/retry failed/i),
    );
    fireEvent.click(
      within(screen.getByText("Copy failure").closest("article")!).getByRole(
        "button",
        { name: "Save Sent copy" },
      ),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/copy retry failed/i),
    );
    const scheduledRow = within(
      screen.getByText("Schedule failure").closest("article")!,
    );
    fireEvent.click(scheduledRow.getByRole("button", { name: "Send now" }));
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/send now failed/i),
    );
    fireEvent.click(scheduledRow.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/undo failed/i),
    );
    fireEvent.click(
      within(screen.getByText("Discard failure").closest("article")!).getByRole(
        "button",
        { name: "Discard" },
      ),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/discard failed/i),
    );
  });

  it("shows an oversize snoozed envelope when its body cannot load", async () => {
    const snoozed = {
      message: firstMessage,
      snoozedUntil: "2026-09-01T08:00:00+00:00",
    };
    mockedListSnoozed.mockResolvedValue([snoozed]);
    mockedGetMessage.mockRejectedValueOnce(
      new Error("This message is too large to download safely."),
    );
    useAppStore.setState({ activeLocalView: "snoozed", snoozed: [snoozed] });
    renderShell();

    fireEvent.click(
      await screen.findByRole("button", {
        name: /^Unread, Jane, First message, Snoozed until/,
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "First message" }),
    ).toBeVisible();
    expect(useAppStore.getState().selectedMessage?.textBody).toBe("");
    expect(useAppStore.getState().error).toMatch(/too large/i);
  });

  it("runs future scheduled mail and exposes remaining shell controls", async () => {
    const held = {
      id: "due-soon",
      accountId: account.id,
      recipients: "lee@example.com",
      subject: "Due soon",
      state: "scheduled",
      detail: "Held for review.",
      createdAt: "2026-08-18T11:00:00Z",
      sendAt: new Date(Date.now() + 30).toISOString(),
    } as const;
    mockedListOutbox.mockResolvedValueOnce([held]).mockResolvedValue([]);
    vi.mocked(api.sendScheduledOutbox).mockResolvedValue({
      id: held.id,
      state: "sent",
      detail: null,
    });
    useAppStore.setState({
      activeLocalView: "outbox",
      outbox: [held],
      updateReady: "0.2.0",
      settings: { ...defaultSettings, readingPane: "bottom" },
    });
    renderShell();

    fireEvent.click(
      await screen.findByRole("button", {
        name: strings.mail.updateReadyBadge,
      }),
    );
    expect(applyPendingUpdate).toHaveBeenCalled();
    fireEvent.keyDown(
      screen.getByRole("separator", { name: strings.mail.resizeFolders }),
      { key: "End" },
    );
    fireEvent.keyDown(
      screen.getByRole("separator", { name: strings.mail.resizeReader }),
      { key: "End" },
    );
    expect(useAppStore.getState().settings.folderPaneWidth).toBe(420);
    expect(useAppStore.getState().settings.readerPaneHeight).toBe(800);

    fireEvent.click(
      screen.getByRole("button", { name: strings.mail.addAccount }),
    );
    expect(
      screen.getByRole("dialog", { name: strings.mail.addEmailAccount }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: strings.mail.closeAddAccount }),
    );
    expect(
      screen.queryByRole("dialog", { name: strings.mail.addEmailAccount }),
    ).not.toBeInTheDocument();

    await waitFor(() =>
      expect(api.sendScheduledOutbox).toHaveBeenCalledWith(
        "due-soon",
        "account-1",
      ),
    );
  });

  it("reports failed appearance shortcuts, clears empty search, and moves junk mail out", async () => {
    const junk = makeMailbox({
      id: 4,
      name: "Junk",
      displayName: "Junk",
      role: "junk",
      unreadCount: 0,
      totalCount: 1,
    });
    mockedListMailboxes.mockResolvedValue([inbox, trash, junk]);
    mockedSearchCached.mockResolvedValue([]);
    mockedSearchServer.mockResolvedValue([]);
    mockedMoveMessagesToMailbox.mockResolvedValue({
      updated: 1,
      queued: 0,
      failed: 0,
    });
    mockedSaveSettings.mockRejectedValueOnce(new Error("scale save failed"));
    resetStore({
      accounts: [account],
      activeAccountId: account.id,
      mailboxes: [inbox, trash, junk],
      activeMailboxId: inbox.id,
      settings: { ...defaultSettings, textScale: 1.07 },
    });
    renderShell();
    await screen.findByRole("option", { name: /First message/i });

    window.dispatchEvent(
      new CustomEvent("postal:menu-action", { detail: "text-larger" }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/scale save failed/i),
    );
    mockedSaveSettings.mockRejectedValueOnce(new Error("pane save failed"));
    window.dispatchEvent(
      new CustomEvent("postal:menu-action", { detail: "reading-pane-hidden" }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/pane save failed/i),
    );

    fireEvent.click(screen.getByRole("button", { name: "Outbox" }));
    expect(useAppStore.getState().activeLocalView).toBe("outbox");
    fireEvent.click(screen.getByRole("button", { name: /Inbox/ }));
    await screen.findByRole("option", { name: /First message/i });

    fireEvent.change(screen.getByRole("searchbox", { name: "Search mail" }), {
      target: { value: "no-such-mail" },
    });
    fireEvent.submit(screen.getByRole("search"));
    fireEvent.click(
      await screen.findByRole("button", { name: strings.mail.clearSearch }),
    );
    await screen.findByRole("option", { name: /First message/i });

    fireEvent.click(screen.getByRole("button", { name: "Junk" }));
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /First message/i }));
    fireEvent.click(
      screen.getByRole("button", { name: "More mailbox actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.notJunk }),
    );
    await waitFor(() =>
      expect(mockedMoveMessagesToMailbox).toHaveBeenCalledWith(
        "account-1",
        [1],
        inbox.id,
        expect.any(String),
      ),
    );
  });

  it("reports overdue scheduled send failures", async () => {
    vi.mocked(api.sendScheduledOutbox).mockRejectedValueOnce(
      new Error("schedule send failed"),
    );
    useAppStore.setState({
      outbox: [
        {
          id: "overdue",
          accountId: account.id,
          recipients: "lee@example.com",
          subject: "Overdue",
          state: "scheduled",
          detail: null,
          createdAt: "2026-08-18T11:00:00Z",
          sendAt: new Date(Date.now() - 1_000).toISOString(),
        },
      ],
    });
    renderShell();
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/schedule send failed/i),
    );
  });

  it("refreshes the list and account data after snoozing from the reader", async () => {
    const snooze = vi.mocked(api.snoozeMessage);
    snooze.mockResolvedValue(undefined);
    renderShell();
    await screen.findByRole("option", { name: /First message/i });
    fireEvent.click(screen.getByRole("option", { name: /First message/i }));
    await screen.findByRole("heading", { name: "First message" });
    const listCalls = mockedListMessages.mock.calls.length;
    const mailboxCalls = mockedListMailboxes.mock.calls.length;

    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.snooze }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.snoozeTomorrow }),
    );

    await waitFor(() =>
      expect(snooze).toHaveBeenCalledWith("account-1", 1, expect.any(String)),
    );
    await waitFor(() =>
      expect(mockedListMessages.mock.calls.length).toBeGreaterThan(listCalls),
    );
    expect(mockedListMailboxes.mock.calls.length).toBeGreaterThan(mailboxCalls);
    expect(
      await screen.findByRole("heading", { name: "Second message" }),
    ).toBeVisible();
  });

  it("returns to Inbox from another mailbox", async () => {
    mockedListMessages.mockImplementation(async (_accountId, mailboxId) => ({
      items: mailboxId === inbox.id ? [firstMessage] : [],
      nextCursor: null,
      hasMore: false,
    }));
    resetStore({
      mailboxes: [inbox, trash],
      activeMailboxId: trash.id,
    });
    renderShell();

    expect(await screen.findByRole("heading", { name: "Trash" })).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: strings.mail.moreMailboxActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.mail.goToInbox }),
    );
    expect(await screen.findByRole("heading", { name: "Inbox" })).toBeVisible();
    expect(
      await screen.findByRole("option", { name: /First message/i }),
    ).toBeVisible();
  });

  it("opens the next mailbox that has unread mail", async () => {
    const archive = makeMailbox({
      id: 2,
      name: "Archive",
      displayName: "Archive",
      role: "archive",
      unreadCount: 3,
      totalCount: 3,
    });
    const archived = makeMessage({
      id: 8,
      mailboxId: archive.id,
      subject: "Archived note",
    });
    mockedListMailboxes.mockResolvedValue([inbox, archive, trash]);
    mockedListMessages.mockImplementation(async (_accountId, mailboxId) => ({
      items: mailboxId === archive.id ? [archived] : [firstMessage],
      nextCursor: null,
      hasMore: false,
    }));
    resetStore({
      mailboxes: [inbox, archive, trash],
      activeMailboxId: inbox.id,
    });
    renderShell();

    await screen.findByRole("option", { name: /First message/i });
    fireEvent.click(
      screen.getByRole("button", { name: strings.mail.moreMailboxActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.mail.nextUnreadMailbox }),
    );
    expect(
      await screen.findByRole("heading", { name: "Archive" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("option", { name: /Archived note/i }),
    ).toBeVisible();
  });

  it("expands and collapses every loaded conversation", async () => {
    const newer = makeMessage({
      id: 1,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      threadRoot: "<thread@example.test>",
      subject: "Older note",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    mockedListMessages.mockResolvedValue({
      items: [newer, older],
      nextCursor: null,
      hasMore: false,
    });
    renderShell();
    await screen.findByRole("treeitem", { name: /First message/i });
    expect(screen.getAllByRole("treeitem")).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", { name: strings.mail.moreMailboxActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.mail.expandConversations }),
    );
    expect(screen.getByRole("treeitem", { name: /Older note/i })).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: strings.mail.moreMailboxActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.mail.collapseConversations,
      }),
    );
    expect(
      screen.queryByRole("treeitem", { name: /Older note/i }),
    ).not.toBeInTheDocument();
  });

  it("snoozes a loaded conversation and opens the next message", async () => {
    const newer = makeMessage({
      id: 1,
      threadRoot: "<thread@example.test>",
    });
    const older = makeMessage({
      id: 2,
      threadRoot: "<thread@example.test>",
      subject: "Older note",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    const other = makeMessage({
      id: 3,
      subject: "Library hours",
      receivedAt: "2026-08-16T12:00:00Z",
    });
    const loaded = [newer, older, other];
    mockedListMessages.mockResolvedValue({
      items: loaded,
      nextCursor: null,
      hasMore: false,
    });
    mockedGetMessage.mockImplementation(async (_accountId, messageId) => {
      const summary = loaded.find((item) => item.id === messageId);
      if (!summary) throw new Error("message missing");
      return toDetail(summary);
    });
    vi.mocked(api.snoozeMessages).mockResolvedValue(undefined);
    renderShell();

    await screen.findByRole("treeitem", { name: /First message/i });
    window.dispatchEvent(
      new CustomEvent(CONTEXT_ACTION_EVENT, {
        detail: {
          id: "snooze-conversation",
          target: { kind: "message", messageId: 1 },
        },
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: strings.reader.snoozeTomorrow,
      }),
    );

    await waitFor(() =>
      expect(api.snoozeMessages).toHaveBeenCalledWith(
        "account-1",
        [1, 2],
        expect.any(String),
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "Library hours" }),
    ).toBeVisible();
  });

  it("restores the mailbox when a submitted search input is cleared", async () => {
    mockedSearchCached.mockResolvedValue([
      { ...firstMessage, subject: "Search hit" },
    ]);
    mockedSearchServer.mockResolvedValue([]);
    renderShell();
    await screen.findByRole("option", { name: /First message/i });

    const search = screen.getByRole("searchbox", { name: "Search mail" });
    fireEvent.change(search, { target: { value: "hit" } });
    fireEvent.submit(screen.getByRole("search"));
    await screen.findByRole("option", { name: /Search hit/i });

    const listCalls = mockedListMessages.mock.calls.length;
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() =>
      expect(mockedListMessages.mock.calls.length).toBeGreaterThan(listCalls),
    );
    expect(
      await screen.findByRole("option", { name: /First message/i }),
    ).toBeVisible();
    expect(screen.queryByRole("option", { name: /Search hit/i })).toBeNull();
  });

  it("binds native change listeners once and follows the current account", async () => {
    const secondAccount = makeAccount("account-2");
    resetStore({
      accounts: [account, secondAccount],
      activeAccountId: account.id,
      mailboxes: [inbox, trash],
      activeMailboxId: inbox.id,
    });
    let folderChanged: ((event: { accountId: string }) => void) | undefined;
    mockedOnFolderCountsChanged.mockImplementation(async (handler) => {
      folderChanged = handler;
      return () => undefined;
    });
    renderShell();
    await screen.findByRole("option", { name: /First message/i });
    expect(mockedOnFolderCountsChanged).toHaveBeenCalledTimes(1);

    switchToAccount(secondAccount.id);
    await waitFor(() =>
      expect(mockedListMailboxes).toHaveBeenCalledWith("account-2"),
    );
    expect(mockedOnFolderCountsChanged).toHaveBeenCalledTimes(1);

    const before = mockedListMailboxes.mock.calls.length;
    folderChanged?.({ accountId: secondAccount.id });
    await waitFor(() =>
      expect(mockedListMailboxes.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it("creates a folder inside another folder", async () => {
    const projects = makeMailbox({
      id: 4,
      name: "Projects",
      displayName: "Projects",
      role: "other",
      unreadCount: 0,
      totalCount: 0,
      delimiter: "/",
    });
    resetStore({
      accounts: [account],
      activeAccountId: account.id,
      mailboxes: [inbox, trash, projects],
      activeMailboxId: inbox.id,
    });
    mockedListMailboxes.mockResolvedValue([inbox, trash, projects]);
    renderShell();
    await screen.findByRole("button", { name: "Projects" });
    act(() => {
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: {
            id: "new-subfolder",
            target: { kind: "folder", mailboxId: projects.id },
          },
        }),
      );
    });
    expect(screen.getByText("New folder inside Projects")).toBeVisible();
    fireEvent.change(screen.getByPlaceholderText("Folder name"), {
      target: { value: "Notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    await waitFor(() =>
      expect(mockedCreateFolder).toHaveBeenCalledWith("account-1", "Notes", 4),
    );
  });

  it("closes the folder dialog when the account changes", async () => {
    const secondAccount = makeAccount("account-2");
    resetStore({
      accounts: [account, secondAccount],
      activeAccountId: account.id,
      mailboxes: [inbox, trash],
      activeMailboxId: inbox.id,
    });
    renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "New folder" }));
    expect(screen.getByPlaceholderText("Folder name")).toBeVisible();

    switchToAccount(secondAccount.id);
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Folder name")).toBeNull(),
    );
  });

  it("clears loading when a mailbox switch leaves no fetch to run", async () => {
    const secondAccount = makeAccount("account-2");
    resetStore({
      accounts: [account, secondAccount],
      activeAccountId: account.id,
      mailboxes: [inbox, trash],
      activeMailboxId: inbox.id,
    });
    mockedListMessages.mockImplementation(() => new Promise(() => {}));
    mockedListMailboxes.mockImplementation(async (accountId) =>
      accountId === secondAccount.id ? [] : [inbox, trash],
    );
    renderShell();
    expect(await screen.findByText(strings.mail.loadingMessages)).toBeVisible();

    switchToAccount(secondAccount.id);
    await waitFor(() =>
      expect(screen.queryByText(strings.mail.loadingMessages)).toBeNull(),
    );
  });

  it("surfaces a Send now outcome that stays queued", async () => {
    vi.mocked(api.sendScheduledOutbox).mockResolvedValue({
      id: "outbox-1",
      state: "scheduled",
      detail: "Waiting for a secure mail connection.",
    });
    const held = {
      id: "outbox-1",
      accountId: account.id,
      recipients: "lee@example.com",
      subject: "Held note",
      state: "scheduled",
      detail: "Held for review.",
      createdAt: "2026-08-18T11:00:00Z",
      sendAt: new Date(Date.now() + 60_000).toISOString(),
    } as const;
    mockedListOutbox.mockResolvedValue([held]);
    useAppStore.setState({ activeLocalView: "outbox", outbox: [held] });
    renderShell();

    fireEvent.click(await screen.findByRole("button", { name: "Send now" }));
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/secure mail connection/i),
    );
  });

  it("opens the next message after the open message is trashed", async () => {
    vi.mocked(api.moveMessage).mockResolvedValue(undefined);
    renderShell();
    fireEvent.click(
      await screen.findByRole("option", { name: /First message/i }),
    );
    await screen.findByRole("heading", { name: "First message" });
    fireEvent.click(screen.getByRole("button", { name: strings.reader.trash }));

    await waitFor(() =>
      expect(api.moveMessage).toHaveBeenCalledWith(
        "account-1",
        1,
        "trash",
        expect.any(String),
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "Second message" }),
    ).toBeVisible();
  });

  it("replies and moves a message from the product context menu", async () => {
    renderShell();
    const row = await screen.findByRole("option", { name: /First message/i });
    fireEvent.contextMenu(row);
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.reply }),
    );
    await waitFor(() => expect(useAppStore.getState().composerOpen).toBe(true));
    expect(useAppStore.getState().composeSeed?.composeMode).toBe("reply");

    fireEvent.contextMenu(
      screen.getByRole("option", { name: /Second message/i }),
    );
    vi.mocked(api.moveMessage).mockResolvedValue(undefined);
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.trash }),
    );
    await waitFor(() =>
      expect(api.moveMessage).toHaveBeenCalledWith(
        "account-1",
        2,
        "trash",
        expect.any(String),
      ),
    );
  });

  it("marks unread mail read from the context menu without flipping it back", async () => {
    renderShell();
    const row = await screen.findByRole("option", { name: /First message/i });
    fireEvent.contextMenu(row);
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.markRead }),
    );
    await waitFor(() =>
      expect(mockedSetMessageFlags).toHaveBeenCalledWith(
        account.id,
        firstMessage.id,
        true,
        undefined,
      ),
    );
    await waitFor(() =>
      expect(useAppStore.getState().selectedMessage?.isRead).toBe(true),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      mockedSetMessageFlags.mock.calls.some((call) => call[2] === false),
    ).toBe(false);
  });

  it("does not run a message action when opening the clicked row fails", async () => {
    mockedGetMessage.mockRejectedValue(new Error("offline"));
    renderShell();
    const row = await screen.findByRole("option", { name: /First message/i });
    fireEvent.contextMenu(row);
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.trash }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/offline/i),
    );
    expect(api.moveMessage).not.toHaveBeenCalled();
  });

  it("empties trash and still confirms folder delete from the context menu", async () => {
    const projects = makeMailbox({
      id: 4,
      name: "Projects",
      displayName: "Projects",
      role: "other",
      unreadCount: 0,
      totalCount: 0,
    });
    const fullTrash = { ...trash, totalCount: 4 };
    resetStore({
      accounts: [account],
      activeAccountId: account.id,
      mailboxes: [inbox, fullTrash, projects],
      activeMailboxId: inbox.id,
    });
    mockedListMailboxes.mockResolvedValue([inbox, fullTrash, projects]);
    vi.mocked(api.emptyTrash).mockResolvedValue(undefined);
    renderShell();
    await screen.findByRole("button", { name: "Projects" });

    fireEvent.contextMenu(screen.getByRole("button", { name: /Trash/i }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.mail.emptyTrash }),
    );
    await waitFor(() =>
      expect(api.emptyTrash).toHaveBeenCalledWith("account-1"),
    );
    expect(api.showNativeConfirm).toHaveBeenCalled();

    fireEvent.contextMenu(screen.getByRole("button", { name: "Projects" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.mail.deleteFolder }),
    );
    await waitFor(() =>
      expect(mockedDeleteFolder).toHaveBeenCalledWith("account-1", 4),
    );
    expect(api.showNativeConfirm).toHaveBeenCalledWith(
      strings.appName,
      strings.mail.deleteFolderQuestion("Projects"),
    );
  });

  it("routes folder, local-list, and outbox context actions", async () => {
    const junk = makeMailbox({
      id: 5,
      name: "Junk",
      displayName: "Junk",
      role: "junk",
      unreadCount: 0,
      totalCount: 2,
    });
    const projects = makeMailbox({
      id: 4,
      name: "Projects",
      displayName: "Projects",
      role: "other",
      unreadCount: 0,
      totalCount: 0,
    });
    const draft = {
      id: "draft-ctx",
      accountId: account.id,
      recipients: "lee@example.com",
      subject: "Context draft",
      updatedAt: "2026-08-18T11:00:00Z",
      syncState: "synced" as const,
    };
    const outbox = [
      {
        id: "retry-ctx",
        accountId: account.id,
        recipients: "lee@example.com",
        subject: "Retry",
        state: "needs_attention" as const,
        createdAt: "2026-08-18T11:00:00Z",
      },
      {
        id: "copy-ctx",
        accountId: account.id,
        recipients: "lee@example.com",
        subject: "Copy",
        state: "sent_copy_pending" as const,
        createdAt: "2026-08-18T11:00:00Z",
      },
      {
        id: "later-ctx",
        accountId: account.id,
        recipients: "lee@example.com",
        subject: "Later",
        state: "scheduled" as const,
        createdAt: "2026-08-18T11:00:00Z",
        sendAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ];
    const snoozed = {
      message: firstMessage,
      snoozedUntil: "2026-09-01T08:00:00+00:00",
    };
    resetStore({
      accounts: [account],
      activeAccountId: account.id,
      mailboxes: [inbox, trash, junk, projects],
      activeMailboxId: inbox.id,
      drafts: [draft],
      outbox,
      snoozed: [snoozed],
    });
    mockedListMailboxes.mockResolvedValue([inbox, trash, junk, projects]);
    mockedListDrafts.mockResolvedValue([draft]);
    mockedListOutbox.mockResolvedValue(outbox);
    mockedListSnoozed.mockResolvedValue([snoozed]);
    mockedGetDraft.mockResolvedValue({
      id: draft.id,
      accountId: account.id,
      to: ["lee@example.com"],
      cc: [],
      bcc: [],
      subject: draft.subject,
      htmlBody: "<p>Draft</p>",
      textBody: "Draft",
      attachments: [],
    });
    vi.mocked(api.retryOutbox).mockResolvedValue({
      id: "retry-ctx",
      state: "sent",
      detail: null,
    });
    vi.mocked(api.retrySentCopy).mockResolvedValue({
      id: "copy-ctx",
      state: "sent",
      detail: null,
    });
    vi.mocked(api.sendScheduledOutbox).mockResolvedValue({
      id: "later-ctx",
      state: "sent",
      detail: null,
    });
    vi.mocked(api.emptyJunk).mockResolvedValue(undefined);
    mockedUnsnoozeMessage.mockResolvedValue(undefined);
    renderShell();
    await screen.findByRole("option", { name: /First message/i });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: { id: "open", target: { kind: "folder", mailboxId: 99 } },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: {
            id: "open",
            target: { kind: "folder", mailboxId: inbox.id },
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: {
            id: "open",
            target: { kind: "folder", mailboxId: trash.id },
          },
        }),
      );
    });
    await waitFor(() =>
      expect(useAppStore.getState().activeMailboxId).toBe(trash.id),
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: {
            id: "empty-junk",
            target: { kind: "folder", mailboxId: junk.id },
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: {
            id: "rename-folder",
            target: { kind: "folder", mailboxId: projects.id },
          },
        }),
      );
    });
    await waitFor(() =>
      expect(api.emptyJunk).toHaveBeenCalledWith("account-1"),
    );
    expect(screen.getByPlaceholderText("Folder name")).toBeVisible();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: { id: "open", target: { kind: "local-nav", view: "drafts" } },
        }),
      );
    });
    await waitFor(() =>
      expect(useAppStore.getState().activeLocalView).toBe("drafts"),
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: {
            id: "open",
            target: { kind: "draft", draftId: "draft-ctx" },
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: {
            id: "retry",
            target: { kind: "outbox", outboxId: "retry-ctx" },
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: {
            id: "retry-copy",
            target: { kind: "outbox", outboxId: "copy-ctx" },
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: {
            id: "send-now",
            target: { kind: "outbox", outboxId: "later-ctx" },
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: {
            id: "discard",
            target: { kind: "outbox", outboxId: "missing" },
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: {
            id: "discard",
            target: { kind: "outbox", outboxId: "copy-ctx" },
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: {
            id: "snooze",
            target: { kind: "message", messageId: firstMessage.id },
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: {
            id: "move-mailbox:3",
            target: { kind: "message", messageId: firstMessage.id },
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: { id: "open", target: { kind: "snoozed", messageId: 99 } },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: {
            id: "unsnooze",
            target: { kind: "snoozed", messageId: firstMessage.id },
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, { detail: undefined }),
      );
    });
    await waitFor(() =>
      expect(mockedGetDraft).toHaveBeenCalledWith("draft-ctx", "account-1"),
    );
    await waitFor(() =>
      expect(api.retryOutbox).toHaveBeenCalledWith("retry-ctx", "account-1"),
    );
    expect(api.retrySentCopy).toHaveBeenCalledWith("copy-ctx", "account-1");
    expect(api.sendScheduledOutbox).toHaveBeenCalledWith(
      "later-ctx",
      "account-1",
    );
    expect(mockedUnsnoozeMessage).toHaveBeenCalledWith(
      "account-1",
      firstMessage.id,
    );
  });
});
