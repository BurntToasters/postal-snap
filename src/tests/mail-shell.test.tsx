import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { MailShell } from "../components/MailShell";
import { defaultSettings, useAppStore } from "../store";
import type {
  AccountSummary,
  MailboxSummary,
  MessageDetail,
  MessageSummary,
} from "../types";

vi.mock("../api", () => ({
  api: {
    listMailboxes: vi.fn(),
    listDrafts: vi.fn(),
    listOutbox: vi.fn(),
    listSnoozed: vi.fn().mockResolvedValue([]),
    snoozeMessage: vi.fn(),
    unsnoozeMessage: vi.fn(),
    retryOutbox: vi.fn(),
    retrySentCopy: vi.fn(),
    sendScheduledOutbox: vi.fn(),
    deleteOutbox: vi.fn(),
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
  },
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

const account: AccountSummary = {
  id: "account-1",
  provider: "manual",
  email: "sam@example.test",
  displayName: "Sam",
  syncState: "idle",
};

const inbox: MailboxSummary = {
  id: 1,
  accountId: account.id,
  name: "INBOX",
  displayName: "Inbox",
  role: "inbox",
  unreadCount: 2,
  totalCount: 2,
};

const trash: MailboxSummary = {
  id: 3,
  accountId: account.id,
  name: "Trash",
  displayName: "Trash",
  role: "trash",
  unreadCount: 0,
  totalCount: 0,
};

const firstMessage: MessageSummary = {
  id: 1,
  accountId: account.id,
  mailboxId: inbox.id,
  uid: 1,
  messageId: "<first@example.test>",
  subject: "First message",
  senderName: "Jane",
  senderAddress: "jane@example.test",
  recipients: account.email,
  receivedAt: "2026-08-18T12:00:00Z",
  preview: "First preview",
  isRead: false,
  isStarred: false,
  hasAttachments: false,
  size: 100,
};

const secondMessage: MessageSummary = {
  ...firstMessage,
  id: 2,
  uid: 2,
  messageId: "<second@example.test>",
  subject: "Second message",
  preview: "Second preview",
};

const messages = [firstMessage, secondMessage];

const mockedListMailboxes = vi.mocked(api.listMailboxes);
const mockedListDrafts = vi.mocked(api.listDrafts);
const mockedListOutbox = vi.mocked(api.listOutbox);
const mockedListSnoozed = vi.mocked(api.listSnoozed);
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

function detail(summary: MessageSummary): MessageDetail {
  return {
    ...summary,
    to: [account.email],
    cc: [],
    replyTo: null,
    textBody: summary.preview,
    htmlBody: null,
    remoteImagesBlocked: false,
    attachments: [],
  };
}

function resetStore() {
  useAppStore.setState({
    accounts: [account],
    activeAccountId: account.id,
    mailboxes: [inbox, trash],
    activeMailboxId: inbox.id,
    activeLocalView: undefined,
    messages: [],
    messageCursor: undefined,
    hasMoreMessages: false,
    drafts: [],
    outbox: [],
    snoozed: [],
    selectedMessage: undefined,
    sync: {},
    settings: defaultSettings,
    composerOpen: false,
    composerAccountId: undefined,
    composeSeed: undefined,
    busy: false,
    error: undefined,
  });
}

function renderShell() {
  return render(<MailShell onOpenSettings={vi.fn()} />);
}

describe("mail shell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    mockedListMailboxes.mockResolvedValue([inbox, trash]);
    mockedListDrafts.mockResolvedValue([]);
    mockedListOutbox.mockResolvedValue([]);
    mockedListSnoozed.mockResolvedValue([]);
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
    mockedSaveSettings.mockImplementation(async (next) => next);
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

    const search = screen.getByRole("textbox", { name: "Search mail" });
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
    expect(screen.getByRole("button", { name: "Write" })).toBeVisible();
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
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));

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
});
