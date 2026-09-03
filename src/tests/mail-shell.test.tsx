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
    listMessages: vi.fn(),
    getMessage: vi.fn(),
    setMessageFlags: vi.fn(),
    searchCached: vi.fn(),
    searchServer: vi.fn(),
    saveSettings: vi.fn(),
    onFolderCountsChanged: vi.fn(),
    onMessageChanged: vi.fn(),
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
const mockedListMessages = vi.mocked(api.listMessages);
const mockedGetMessage = vi.mocked(api.getMessage);
const mockedSetMessageFlags = vi.mocked(api.setMessageFlags);
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
    mailboxes: [inbox],
    activeMailboxId: inbox.id,
    activeLocalView: undefined,
    messages: [],
    messageCursor: undefined,
    hasMoreMessages: false,
    drafts: [],
    outbox: [],
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
    mockedListMailboxes.mockResolvedValue([inbox]);
    mockedListDrafts.mockResolvedValue([]);
    mockedListOutbox.mockResolvedValue([]);
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
});
