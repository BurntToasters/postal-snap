import { create } from "zustand";
import type { MessageListSort } from "./listSort";
import { rememberOpenMessage } from "./recentMessage";
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
  SyncProgress,
  SyncState,
} from "./types";

export interface SentNotice {
  outboxId: string;
  accountId: string;
  /** True when the user picked Send Later vs the undo-send hold. */
  scheduled: boolean;
  /** Undo-send hold length in seconds; undefined for explicit Send Later. */
  undoSeconds?: number;
  /** Original moved to Archive with this send. Undo puts it back. */
  archivedMessage?: { messageId: number; mailboxId: number };
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
  /** Loaded messages quoted together when forwarding a conversation. */
  forwardMessages?: MessageDetail[];
  composeMode?:
    | "reply"
    | "replyAll"
    | "forward"
    | "forwardAttachment"
    | "editAsNew"
    | "replyList"
    | "redirect";
  /** Plain text the user had selected in the open message. */
  quoteExcerpt?: string;
  /** Text written in the reader's reply box. */
  replyNote?: string;
  /** Reply or reply-all with an empty letter. Recipients and subject stay. */
  omitQuote?: boolean;
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
  imageSenders: [],
  groupThreads: true,
  bccSelf: false,
  signatureAboveQuote: true,
  replyToAll: false,
  unreadFoldersOnly: false,
  composerWidth: 0,
  composerHeight: 0,
  lastFromAddresses: [],
  mailboxSort: "date",
  mailboxFilter: "all",
  mailboxViews: [],
  pinnedMailboxes: [],
  hiddenMailboxes: [],
  collapsedMailboxes: [],
  recentMoveMailboxId: null,
  showMessagePreviews: true,
  newMailSound: true,
  quietHoursStart: "",
  quietHoursEnd: "",
  markRead: "open",
  notifyNewMail: true,
  closeToTray: true,
  updateCheckInterval: "startupAnd6h",
  setupCompleted: false,
  setupStep: null,
};

interface AppState {
  accounts: AccountSummary[];
  activeAccountId?: string;
  lastMailboxByAccount: Record<string, number>;
  mailboxes: MailboxSummary[];
  activeMailboxId?: number;
  activeLocalView?: "drafts" | "outbox" | "snoozed";
  messages: MessageSummary[];
  mailboxSort?: MessageListSort;
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
  /** Kept here so progress events re-render only the status line. */
  syncProgress: SyncProgress | undefined;
  setSyncProgress: (progress: SyncProgress | undefined) => void;
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

function keepOpenMessage(state: AppState) {
  const message = state.selectedMessage;
  if (
    !state.activeAccountId ||
    !state.activeMailboxId ||
    state.activeLocalView ||
    !message ||
    message.accountId !== state.activeAccountId ||
    message.mailboxId !== state.activeMailboxId
  ) {
    return;
  }
  rememberOpenMessage(state.activeAccountId, state.activeMailboxId, message.id);
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
  lastMailboxByAccount: {},
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
  syncProgress: undefined,
  setSyncProgress: (syncProgress) => set({ syncProgress }),
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
      const lastMailboxByAccount = Object.fromEntries(
        Object.entries(state.lastMailboxByAccount).filter(([accountId]) =>
          accountIds.has(accountId),
        ),
      );
      if (state.activeAccountId && state.activeMailboxId) {
        lastMailboxByAccount[state.activeAccountId] = state.activeMailboxId;
      }

      return {
        accounts,
        activeAccountId,
        sync,
        lastMailboxByAccount,
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
    set((state) => {
      keepOpenMessage(state);
      const lastMailboxByAccount = { ...state.lastMailboxByAccount };
      if (state.activeAccountId && state.activeMailboxId) {
        lastMailboxByAccount[state.activeAccountId] = state.activeMailboxId;
      }
      return {
        activeAccountId,
        lastMailboxByAccount,
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
      };
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
                (box) =>
                  box.id ===
                  (state.activeAccountId
                    ? state.lastMailboxByAccount[state.activeAccountId]
                    : undefined),
              ) ??
              mailboxes.find(
                (box) =>
                  state.settings.lastAccountId === state.activeAccountId &&
                  box.id === state.settings.lastMailboxId,
              ) ??
              mailboxes.find((box) => box.role === "inbox") ??
              mailboxes[0]
            )?.id,
    })),
  selectMailbox: (activeMailboxId) =>
    set((state) => {
      if (state.activeMailboxId === activeMailboxId && !state.activeLocalView) {
        return {};
      }
      keepOpenMessage(state);
      return {
        activeMailboxId,
        lastMailboxByAccount: state.activeAccountId
          ? {
              ...state.lastMailboxByAccount,
              [state.activeAccountId]: activeMailboxId,
            }
          : state.lastMailboxByAccount,
        activeLocalView: undefined,
        messages: [],
        messageCursor: undefined,
        hasMoreMessages: false,
        selectedMessage: undefined,
      };
    }),
  selectLocalView: (activeLocalView) =>
    set((state) => {
      keepOpenMessage(state);
      return {
        activeLocalView,
        activeMailboxId: undefined,
        messages: [],
        messageCursor: undefined,
        hasMoreMessages: false,
        selectedMessage: undefined,
      };
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
        composeSeed?.draft?.accountId ??
        composeSeed?.sourceMessage?.accountId ??
        state.activeAccountId;
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
