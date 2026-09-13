import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../store";
import { makeAccount } from "./helpers/fixtures";
import { resetStore } from "./helpers/store";

const account = (id: string) => makeAccount(id);

describe("account reconciliation", () => {
  beforeEach(() => {
    resetStore({
      accounts: [],
      activeAccountId: undefined,
      mailboxes: [],
      activeMailboxId: undefined,
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

  it("restores the last account when settings arrive before a selection", () => {
    const remembered = account("remembered");
    useAppStore.setState({
      accounts: [remembered],
      activeAccountId: undefined,
    });
    useAppStore.getState().setSettings({
      ...useAppStore.getState().settings,
      lastAccountId: remembered.id,
    });
    expect(useAppStore.getState().activeAccountId).toBe(remembered.id);
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

  it("queues a composer prefill until an account becomes active", () => {
    useAppStore
      .getState()
      .openComposer({ prefill: { to: ["late@example.test"] } });

    expect(useAppStore.getState().composerOpen).toBe(false);
    expect(useAppStore.getState().pendingComposeSeed?.prefill?.to).toEqual([
      "late@example.test",
    ]);

    const late = account("late");
    useAppStore.getState().setAccounts([late]);

    expect(useAppStore.getState().composerOpen).toBe(true);
    expect(useAppStore.getState().composerAccountId).toBe(late.id);
    expect(useAppStore.getState().composeSeed?.prefill?.to).toEqual([
      "late@example.test",
    ]);
    expect(useAppStore.getState().pendingComposeSeed).toBeUndefined();
  });

  it("flushes a queued prefill when an account is selected explicitly", () => {
    const late = account("late");
    useAppStore.setState({ accounts: [late], activeAccountId: undefined });
    useAppStore
      .getState()
      .openComposer({ prefill: { to: ["queued@example.test"] } });

    useAppStore.getState().selectAccount(late.id);

    expect(useAppStore.getState().composerOpen).toBe(true);
    expect(useAppStore.getState().composerAccountId).toBe(late.id);
    expect(useAppStore.getState().pendingComposeSeed).toBeUndefined();
  });
});
