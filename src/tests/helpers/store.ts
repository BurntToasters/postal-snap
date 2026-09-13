import { defaultSettings, useAppStore } from "../../store";
import { makeAccount, makeMailbox } from "./fixtures";

type StoreOverrides = Partial<ReturnType<typeof useAppStore.getState>>;

export function resetStore(overrides: StoreOverrides = {}): void {
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
    pendingComposeSeed: undefined,
    busy: false,
    error: undefined,
    lastSent: undefined,
    ...overrides,
  });
}
