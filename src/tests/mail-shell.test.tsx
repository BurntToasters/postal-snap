import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { MailShell } from "../components/MailShell";
import { strings } from "../i18n";
import { defaultSettings, useAppStore } from "../store";
import { promptToRestartForUpdate } from "../update";
import type { MessageChangeEvent, MessageSummary } from "../types";
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
    listMailboxes: vi.fn(),
    listDrafts: vi.fn(),
    listOutbox: vi.fn(),
    listSnoozed: vi.fn().mockResolvedValue([]),
    listAccounts: vi.fn(),
    syncAccount: vi.fn(),
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(),
    getDraft: vi.fn(),
    snoozeMessage: vi.fn(),
    unsnoozeMessage: vi.fn(),
    retryOutbox: vi.fn(),
    retrySentCopy: vi.fn(),
    sendScheduledOutbox: vi.fn(),
    emptyTrash: vi.fn(),
    emptyJunk: vi.fn(),
    deleteOutbox: vi.fn(),
    restoreOutbox: vi.fn(),
    getOutbox: vi.fn(),
    listMessages: vi.fn(),
    getMessage: vi.fn(),
    setMessageFlags: vi.fn(),
    setMessagesFlags: vi.fn(),
    moveMessagesToMailbox: vi.fn(),
    markMailboxRead: vi.fn(),
    searchCached: vi.fn(),
    searchServer: vi.fn(),
    saveSettings: vi.fn(),
    onFolderCountsChanged: vi.fn(),
    onMessageChanged: vi.fn(),
    onDraftSyncChanged: vi.fn().mockResolvedValue(() => undefined),
    onOutboxChanged: vi.fn().mockResolvedValue(() => undefined),
    showNativeConfirm: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock("../update", () => ({
  promptToRestartForUpdate: vi.fn().mockResolvedValue(undefined),
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
const mockedUnsnoozeMessage = vi.mocked(api.unsnoozeMessage);
const mockedListMessages = vi.mocked(api.listMessages);
const mockedGetMessage = vi.mocked(api.getMessage);
const mockedSetMessageFlags = vi.mocked(api.setMessageFlags);
const mockedSetMessagesFlags = vi.mocked(api.setMessagesFlags);
const mockedMoveMessagesToMailbox = vi.mocked(api.moveMessagesToMailbox);
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
  return render(<MailShell onOpenSettings={onOpenSettings} />);
}

describe("mail shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mockSaveSettingsPassthrough();
    mockedOnFolderCountsChanged.mockResolvedValue(() => undefined);
    mockedOnMessageChanged.mockResolvedValue(() => undefined);
    mockedSearchCached.mockResolvedValue([]);
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
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));

    await waitFor(() =>
      expect(mockedSetMessagesFlags).toHaveBeenCalledWith(
        "account-1",
        [1, 2],
        true,
        undefined,
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
      ),
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

    const header = await screen.findByRole("button", {
      name: /Conversation.*2 messages/i,
    });
    expect(screen.queryByRole("option", { name: /First message/i })).toBeNull();
    fireEvent.click(header);
    expect(
      await screen.findByRole("option", { name: /First message/i }),
    ).toBeVisible();
    expect(
      screen.getByRole("option", { name: /Second message/i }),
    ).toBeVisible();
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
      screen.getByRole("button", { name: "Bring back: First message" }),
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

    expect(document.getElementById("message-pane")).toHaveAttribute("inert");
    expect(document.querySelector(".app-toolbar")).toHaveAttribute("inert");
    expect(document.getElementById("reader-pane")).not.toHaveAttribute("inert");
    expect(screen.getByTitle("Message content")).toHaveAttribute(
      "tabindex",
      "0",
    );
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
    expect(screen.queryByRole("button", { name: /Conversation/i })).toBeNull();
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
      await screen.findByRole("button", { name: /Conversation.*2 messages/i }),
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

    expect(await screen.findByText(strings.mail.messageSent)).toBeVisible();
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
    expect(
      await screen.findByRole("option", { name: /Cached match/i }),
    ).toBeVisible();
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

    fireEvent.click(screen.getByRole("button", { name: "This mailbox" }));
    await waitFor(() =>
      expect(mockedSearchServer).toHaveBeenLastCalledWith(
        expect.objectContaining({ allFolders: true }),
      ),
    );
    expect(
      screen.getByRole("button", { name: "This account" }),
    ).toHaveAttribute("aria-pressed", "true");
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

    fireEvent.click(screen.getByRole("button", { name: "Rename Projects" }));
    fireEvent.change(screen.getByPlaceholderText("Folder name"), {
      target: { value: "Client work" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("Folder name"), {
      key: "Escape",
    });
    expect(mockedRenameFolder).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Rename Projects" }));
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
      screen.getByRole("button", { name: "Delete folder: Projects" }),
    );
    await waitFor(() => expect(api.showNativeConfirm).toHaveBeenCalled());
    expect(mockedDeleteFolder).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Delete folder: Projects" }),
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
    fireEvent.click(screen.getByRole("button", { name: "Mark unread" }));
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
      await screen.findByRole("menuitem", { name: "Mark all read" }),
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
      key: "f",
      ctrlKey: true,
      altKey: true,
    });
    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(actions).toEqual(
      expect.arrayContaining([
        "reply",
        "reply-all",
        "forward",
        "archive",
        "toggle-read",
        "toggle-star",
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
    expect(document.getElementById("message-pane")).toHaveAttribute("inert");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".mail-shell")).not.toHaveClass(
      "sidebar-open",
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

    fireEvent.change(screen.getByRole("combobox", { name: "Account" }), {
      target: { value: secondAccount.id },
    });
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
      screen.getByRole("button", { name: "Delete folder: Projects" }),
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
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
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
      screen.getByRole("button", { name: "Bring back: First message" }),
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
    expect(promptToRestartForUpdate).toHaveBeenCalledWith("0.2.0");
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
      screen.getByRole("button", { name: strings.reader.notJunk }),
    );
    await waitFor(() =>
      expect(mockedMoveMessagesToMailbox).toHaveBeenCalledWith(
        "account-1",
        [1],
        inbox.id,
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
});
