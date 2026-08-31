import { beforeEach, describe, expect, it } from "vitest";
import { defaultSettings, useAppStore } from "../store";
import type { AccountSummary } from "../types";

const account = (id: string): AccountSummary => ({
  id,
  provider: "manual",
  email: `${id}@example.test`,
  displayName: id,
  syncState: "idle",
});

describe("account reconciliation", () => {
  beforeEach(() => {
    useAppStore.setState({
      accounts: [],
      activeAccountId: undefined,
      mailboxes: [],
      activeMailboxId: undefined,
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
  });

  it("clears all account-scoped state when the active account is removed", () => {
    const first = account("first");
    const second = account("second");
    useAppStore.setState({
      accounts: [first, second],
      activeAccountId: first.id,
      mailboxes: [
        {
          id: 10,
          accountId: first.id,
          name: "INBOX",
          displayName: "Inbox",
          role: "inbox",
          totalCount: 1,
          unreadCount: 1,
        },
      ],
      activeMailboxId: 10,
      messages: [
        {
          id: 20,
          accountId: first.id,
          mailboxId: 10,
          uid: 1,
          messageId: "message@example.test",
          subject: "Private subject",
          senderName: "Sender",
          senderAddress: "sender@example.test",
          recipients: "recipient@example.test",
          receivedAt: "2026-01-01T00:00:00Z",
          preview: "Private preview",
          isRead: false,
          isStarred: false,
          hasAttachments: false,
          size: 100,
        },
      ],
      hasMoreMessages: true,
      drafts: [
        {
          id: "draft",
          accountId: first.id,
          recipients: "recipient@example.test",
          subject: "Draft",
          updatedAt: "2026-01-01T00:00:00Z",
          syncState: "localOnly",
        },
      ],
      selectedMessage: {
        id: 20,
        accountId: first.id,
        mailboxId: 10,
        uid: 1,
        messageId: "message@example.test",
        subject: "Private subject",
        senderName: "Sender",
        senderAddress: "sender@example.test",
        recipients: "recipient@example.test",
        receivedAt: "2026-01-01T00:00:00Z",
        preview: "Private preview",
        isRead: false,
        isStarred: false,
        hasAttachments: false,
        size: 100,
        to: [],
        cc: [],
        replyTo: null,
        textBody: "Private body",
        htmlBody: null,
        remoteImagesBlocked: false,
        attachments: [],
      },
      composerOpen: true,
      composerAccountId: first.id,
      busy: true,
      sync: {
        [first.id]: { accountId: first.id, phase: "syncing" },
        [second.id]: { accountId: second.id, phase: "idle" },
      },
    });

    useAppStore.getState().setAccounts([second]);

    const state = useAppStore.getState();
    expect(state.activeAccountId).toBe(second.id);
    expect(state.mailboxes).toEqual([]);
    expect(state.messages).toEqual([]);
    expect(state.drafts).toEqual([]);
    expect(state.outbox).toEqual([]);
    expect(state.selectedMessage).toBeUndefined();
    expect(state.hasMoreMessages).toBe(false);
    expect(state.composerOpen).toBe(false);
    expect(state.composerAccountId).toBeUndefined();
    expect(state.busy).toBe(false);
    expect(state.sync).toEqual({
      [second.id]: { accountId: second.id, phase: "idle" },
    });
  });

  it("closes a composer for a removed non-active account", () => {
    const first = account("first");
    const second = account("second");
    useAppStore.setState({
      accounts: [first, second],
      activeAccountId: second.id,
      composerOpen: true,
      composerAccountId: first.id,
    });

    useAppStore.getState().setAccounts([second]);

    expect(useAppStore.getState().activeAccountId).toBe(second.id);
    expect(useAppStore.getState().composerOpen).toBe(false);
  });
});
