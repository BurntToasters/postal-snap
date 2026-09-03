import { create } from "zustand";
import type {
  AccountSummary,
  AppSettings,
  ComposeDraft,
  DraftSummary,
  MailboxSummary,
  MessageDetail,
  MessageCursor,
  MessageSummary,
  OutboxSummary,
  SyncState,
} from "./types";

export interface ComposerSeed {
  draft?: ComposeDraft;
  draftSummary?: DraftSummary;
  prefill?: Partial<
    Pick<
      ComposeDraft,
      "to" | "cc" | "bcc" | "subject" | "htmlBody" | "textBody" | "attachments"
    >
  >;
  sourceMessage?: MessageDetail;
  composeMode?: "reply" | "replyAll" | "forward";
}

export const defaultSettings: AppSettings = {
  schemaVersion: 2,
  readingPane: "right",
  textScale: 1,
  privateNotifications: false,
  theme: "system",
  density: "comfortable",
  cachePolicy: { mode: "recent", days: 90, maxBytes: 1_073_741_824 },
  lastAccountId: null,
  lastMailboxId: null,
  folderPaneWidth: 248,
  messagePaneWidth: 390,
  readerPaneHeight: 360,
};

interface AppState {
  accounts: AccountSummary[];
  activeAccountId?: string;
  mailboxes: MailboxSummary[];
  activeMailboxId?: number;
  activeLocalView?: "drafts" | "outbox";
  messages: MessageSummary[];
  messageCursor?: MessageCursor;
  hasMoreMessages: boolean;
  drafts: DraftSummary[];
  outbox: OutboxSummary[];
  selectedMessage?: MessageDetail;
  sync: Record<string, SyncState>;
  settings: AppSettings;
  composerOpen: boolean;
  composerAccountId?: string;
  composeSeed?: ComposerSeed;
  busy: boolean;
  error?: string;
  updateReady: string | null;
  setUpdateReady: (version: string | null) => void;
  setAccounts: (accounts: AccountSummary[]) => void;
  selectAccount: (id: string) => void;
  setMailboxes: (mailboxes: MailboxSummary[]) => void;
  selectMailbox: (id: number) => void;
  selectLocalView: (view: "drafts" | "outbox") => void;
  setMessages: (
    messages: MessageSummary[],
    cursor?: MessageCursor,
    hasMore?: boolean,
  ) => void;
  appendMessages: (
    messages: MessageSummary[],
    cursor?: MessageCursor,
    hasMore?: boolean,
  ) => void;
  setDrafts: (drafts: DraftSummary[]) => void;
  setOutbox: (outbox: OutboxSummary[]) => void;
  selectMessage: (message?: MessageDetail) => void;
  setSync: (sync: SyncState) => void;
  setSettings: (settings: AppSettings) => void;
  openComposer: (seed?: ComposerSeed) => void;
  closeComposer: () => void;
  setBusy: (busy: boolean) => void;
  setError: (error?: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  accounts: [],
  mailboxes: [],
  messages: [],
  hasMoreMessages: false,
  drafts: [],
  outbox: [],
  sync: {},
  settings: defaultSettings,
  composerOpen: false,
  busy: false,
  updateReady: null,
  setUpdateReady: (updateReady) => set({ updateReady }),
  setAccounts: (accounts) =>
    set((state) => {
      const accountIds = new Set(accounts.map((account) => account.id));
      const activeAccountId =
        state.activeAccountId && accountIds.has(state.activeAccountId)
          ? state.activeAccountId
          : (accounts.find(
              (account) => account.id === state.settings.lastAccountId,
            )?.id ?? accounts[0]?.id);
      const activeAccountChanged = activeAccountId !== state.activeAccountId;
      const composerAccountRemoved = Boolean(
        state.composerAccountId && !accountIds.has(state.composerAccountId),
      );
      const sync = Object.fromEntries(
        Object.entries(state.sync).filter(([accountId]) =>
          accountIds.has(accountId),
        ),
      );

      return {
        accounts,
        activeAccountId,
        sync,
        ...(activeAccountChanged
          ? {
              activeMailboxId: undefined,
              activeLocalView: undefined,
              mailboxes: [],
              messages: [],
              messageCursor: undefined,
              hasMoreMessages: false,
              drafts: [],
              outbox: [],
              selectedMessage: undefined,
              busy: false,
            }
          : {}),
        ...(composerAccountRemoved
          ? {
              composerOpen: false,
              composerAccountId: undefined,
              composeSeed: undefined,
            }
          : {}),
      };
    }),
  selectAccount: (activeAccountId) =>
    set({
      activeAccountId,
      activeMailboxId: undefined,
      activeLocalView: undefined,
      mailboxes: [],
      messages: [],
      messageCursor: undefined,
      hasMoreMessages: false,
      drafts: [],
      outbox: [],
      selectedMessage: undefined,
    }),
  setMailboxes: (mailboxes) =>
    set((state) => ({
      mailboxes,
      activeMailboxId: state.activeLocalView
        ? undefined
        : state.activeMailboxId &&
            mailboxes.some((box) => box.id === state.activeMailboxId)
          ? state.activeMailboxId
          : (
              mailboxes.find(
                (box) => box.id === state.settings.lastMailboxId,
              ) ??
              mailboxes.find((box) => box.role === "inbox") ??
              mailboxes[0]
            )?.id,
    })),
  selectMailbox: (activeMailboxId) =>
    set((state) =>
      state.activeMailboxId === activeMailboxId && !state.activeLocalView
        ? {}
        : {
            activeMailboxId,
            activeLocalView: undefined,
            messages: [],
            messageCursor: undefined,
            hasMoreMessages: false,
            selectedMessage: undefined,
          },
    ),
  selectLocalView: (activeLocalView) =>
    set({
      activeLocalView,
      activeMailboxId: undefined,
      messages: [],
      messageCursor: undefined,
      hasMoreMessages: false,
      selectedMessage: undefined,
    }),
  setMessages: (messages, messageCursor, hasMoreMessages = false) =>
    set({ messages, messageCursor, hasMoreMessages }),
  appendMessages: (messages, messageCursor, hasMoreMessages = false) =>
    set((state) => ({
      messages: [
        ...state.messages,
        ...messages.filter(
          (message) =>
            !state.messages.some((existing) => existing.id === message.id),
        ),
      ],
      messageCursor,
      hasMoreMessages,
    })),
  setDrafts: (drafts) => set({ drafts }),
  setOutbox: (outbox) => set({ outbox }),
  selectMessage: (selectedMessage) => set({ selectedMessage }),
  setSync: (sync) =>
    set((state) => ({ sync: { ...state.sync, [sync.accountId]: sync } })),
  setSettings: (settings) =>
    set((state) => ({
      settings,
      activeAccountId:
        state.activeAccountId ??
        state.accounts.find((account) => account.id === settings.lastAccountId)
          ?.id,
    })),
  openComposer: (composeSeed) =>
    set((state) => ({
      composerOpen: true,
      composerAccountId: composeSeed?.draft?.accountId ?? state.activeAccountId,
      composeSeed,
    })),
  closeComposer: () =>
    set({
      composerOpen: false,
      composerAccountId: undefined,
      composeSeed: undefined,
    }),
  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),
}));
