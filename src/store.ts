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
  SnoozedSummary,
  SyncState,
} from "./types";

export interface SentNotice {
  outboxId: string;
  accountId: string;
  /** True when the user picked Send Later vs the undo-send hold. */
  scheduled: boolean;
  /** Undo-send hold length in seconds; undefined for explicit Send Later. */
  undoSeconds?: number;
}

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
  folderPaneWidth: 264,
  messagePaneWidth: 400,
  readerPaneHeight: 360,
  windowEffects: true,
  sidebarVisible: true,
  undoSendSeconds: 10,
  blockAdvertisingAndTracking: true,
  blockReportedThreats: true,
  groupThreads: true,
  notifyNewMail: true,
  closeToTray: true,
  updateCheckInterval: "startupAnd6h",
  setupCompleted: false,
  setupStep: null,
};

interface AppState {
  accounts: AccountSummary[];
  activeAccountId?: string;
  mailboxes: MailboxSummary[];
  activeMailboxId?: number;
  activeLocalView?: "drafts" | "outbox" | "snoozed";
  messages: MessageSummary[];
  messageCursor?: MessageCursor;
  hasMoreMessages: boolean;
  drafts: DraftSummary[];
  outbox: OutboxSummary[];
  snoozed: SnoozedSummary[];
  selectedMessage?: MessageDetail;
  sync: Record<string, SyncState>;
  settings: AppSettings;
  composerOpen: boolean;
  composerAccountId?: string;
  composeSeed?: ComposerSeed;
  pendingComposeSeed?: ComposerSeed;
  composeNonce: number;
  busy: boolean;
  error?: string;
  lastSent?: SentNotice;
  updateReady: string | null;
  setUpdateReady: (version: string | null) => void;
  setAccounts: (accounts: AccountSummary[]) => void;
  selectAccount: (id: string) => void;
  setMailboxes: (mailboxes: MailboxSummary[]) => void;
  selectMailbox: (id: number) => void;
  selectLocalView: (view: "drafts" | "outbox" | "snoozed") => void;
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
  setSnoozed: (snoozed: SnoozedSummary[]) => void;
  selectMessage: (message?: MessageDetail) => void;
  setSync: (sync: SyncState) => void;
  setSettings: (settings: AppSettings) => void;
  openComposer: (seed?: ComposerSeed) => void;
  closeComposer: () => void;
  setBusy: (busy: boolean) => void;
  setError: (error?: string) => void;
  setLastSent: (notice?: SentNotice) => void;
}

function pendingComposerState(
  state: AppState,
  accountId: string | undefined,
): Partial<AppState> {
  if (!accountId || !state.pendingComposeSeed) return {};
  return {
    composerOpen: true,
    composerAccountId: accountId,
    composeSeed: state.pendingComposeSeed,
    composeNonce: state.composeNonce + 1,
    pendingComposeSeed: undefined,
  };
}

export const useAppStore = create<AppState>((set) => ({
  accounts: [],
  mailboxes: [],
  messages: [],
  hasMoreMessages: false,
  drafts: [],
  outbox: [],
  snoozed: [],
  sync: {},
  settings: defaultSettings,
  composerOpen: false,
  composeNonce: 0,
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
              snoozed: [],
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
        ...pendingComposerState(state, activeAccountId),
      };
    }),
  selectAccount: (activeAccountId) =>
    set((state) => ({
      activeAccountId,
      activeMailboxId: undefined,
      activeLocalView: undefined,
      mailboxes: [],
      messages: [],
      messageCursor: undefined,
      hasMoreMessages: false,
      drafts: [],
      outbox: [],
      snoozed: [],
      selectedMessage: undefined,
      ...pendingComposerState(state, activeAccountId),
    })),
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
  setSnoozed: (snoozed) => set({ snoozed }),
  selectMessage: (selectedMessage) => set({ selectedMessage }),
  setSync: (sync) =>
    set((state) => ({ sync: { ...state.sync, [sync.accountId]: sync } })),
  setSettings: (settings) =>
    set((state) => {
      const activeAccountId =
        state.activeAccountId ??
        state.accounts.find((account) => account.id === settings.lastAccountId)
          ?.id;
      return {
        settings,
        activeAccountId,
        ...pendingComposerState(state, activeAccountId),
      };
    }),
  openComposer: (composeSeed) =>
    set((state) => {
      const composerAccountId =
        composeSeed?.draft?.accountId ?? state.activeAccountId;
      if (!composerAccountId) {
        if (!composeSeed) return state;
        return { pendingComposeSeed: composeSeed };
      }
      return {
        composerOpen: true,
        composerAccountId,
        composeSeed,
        composeNonce: state.composeNonce + 1,
        pendingComposeSeed: undefined,
      };
    }),
  closeComposer: () =>
    set({
      composerOpen: false,
      composerAccountId: undefined,
      composeSeed: undefined,
    }),
  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),
  setLastSent: (lastSent) => set({ lastSent }),
}));
