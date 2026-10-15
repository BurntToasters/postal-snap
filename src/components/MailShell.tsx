import { outboxDetail } from "../outboxDetail";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useMailboxMessages } from "../hooks/useMailboxMessages";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useMailShortcuts } from "../hooks/useMailShortcuts";
import { useScheduledOutbox } from "../hooks/useScheduledOutbox";
import { api } from "../api";
import {
  CONTEXT_ACTION_EVENT,
  addressSearchQuery,
  earlierHeaderId,
  subjectSearchQuery,
} from "../contextMenu";
import { strings } from "../i18n";
import { rangeSelection } from "../selectionRange";
import { matchesListFilter, type MessageListFilter } from "../listFilter";
import type { MessageListSort } from "../listSort";
import { mailboxListView, rememberMailboxView } from "../mailboxView";
import { rememberedOpenMessage } from "../recentMessage";
import { readMessageDrag } from "../messageDrag";
import { preferredReplyMode } from "./composer/composerSeed";
import { folderLabel, folderParentLabel, folderPathLabel } from "../i18n/mail";
import { useAppStore } from "../store";
import type { AccountInboxCount, ComposeDraft, MessageSummary } from "../types";
import { applyPendingUpdate } from "../update";
import { ErrorBoundary } from "./ErrorBoundary";
import { MessageReader } from "./MessageReader";
import {
  AddAccountDialog,
  MoveFolderDialog,
  OutboxPreviewDialog,
  SentNoticeToast,
} from "./mail/mailDialogs";
import { Sidebar } from "./mail/sidebar";
import { DraftList, OutboxList, SnoozedList } from "./mail/localLists";
import { isOversizeError, matchesLocalQuery } from "./mail/mailSearch";
import { folderIcons } from "./mail/folderIcons";
import {
  mailboxByRole,
  nextUnreadMailbox,
  parentMailboxIds,
  previousUnreadMailbox,
} from "./mail/folderTreeModel";
import { MessageList } from "./mail/messageList";
import { MailToolbar } from "./mail/mailToolbar";
import { BulkBar, MessagePaneHeader } from "./mail/messagePaneChrome";
import { SnoozePanel } from "./reader/snoozePanel";
import { PaneSplitter } from "./mail/paneSplitter";
import { useSettingsSave } from "./settings/useSettingsSave";
import { useOverlayFocus } from "./mail/useOverlayFocus";
import { handleContextAction } from "./mail/mailContextActions";
import { useLocalListActions } from "./mail/useLocalListActions";
import { useMailEvents } from "./mail/useMailEvents";

import { MEDIA_QUERIES } from "../breakpoints";
import { toggleListedRead } from "../markRead";
import {
  markLoadedConversationRead,
  markLoadedConversationUnread,
} from "../markConversation";
import {
  collapseFolders,
  expandFolders,
  mailboxIsPinned,
  pinMailbox,
  unpinMailbox,
} from "../pinnedMailboxes";
import { hydrateRecentMoveMailbox } from "../recentMailbox";
import { copySelectedMessageText } from "../copyMessageText";
import { forwardSelectedMessages } from "../forwardConversation";
import { pinSelectedMessages } from "../pinConversation";
import { printSelectedMessages } from "../printConversation";
import { saveSelectedFiles, saveSelectedMessages } from "../saveConversation";
import { starLoadedConversation, toggleListedStar } from "../starConversation";
import {
  deleteListedMessage,
  deleteLoadedConversation,
} from "../deleteConversation";
import { moveListedMessage, moveLoadedConversation } from "../moveConversation";
import { waitToMarkRead } from "../markRead";
import { beginMessageOpen, isCurrentMessageOpen } from "../messageOpen";
import {
  adjacentMessage,
  conversationMessages,
  conversationNeighbor,
  conversationUnreadTarget,
  groupThreads,
  messageAfterRemovals,
  unreadStep,
} from "../threads";

interface Props {
  onOpenSettings: (tab?: "accounts", accountId?: string) => void;
}

function relativeMessage(delta: number): MessageSummary | undefined {
  const state = useAppStore.getState();
  return adjacentMessage(
    state.messages,
    state.settings.groupThreads && (state.mailboxSort ?? "date") === "date",
    state.selectedMessage?.id,
    delta,
  );
}

export function MailShell({ onOpenSettings }: Props) {
  const accounts = useAppStore((state) => state.accounts);
  const activeAccountId = useAppStore((state) => state.activeAccountId);
  const selectAccount = useAppStore((state) => state.selectAccount);
  const setAccounts = useAppStore((state) => state.setAccounts);
  const mailboxes = useAppStore((state) => state.mailboxes);
  const setMailboxes = useAppStore((state) => state.setMailboxes);
  const activeMailboxId = useAppStore((state) => state.activeMailboxId);
  const activeLocalView = useAppStore((state) => state.activeLocalView);
  const selectMailbox = useAppStore((state) => state.selectMailbox);
  const selectLocalView = useAppStore((state) => state.selectLocalView);
  const messages = useAppStore((state) => state.messages);
  const hasMoreMessages = useAppStore((state) => state.hasMoreMessages);
  const setMessages = useAppStore((state) => state.setMessages);
  const drafts = useAppStore((state) => state.drafts);
  const setDrafts = useAppStore((state) => state.setDrafts);
  const outbox = useAppStore((state) => state.outbox);
  const setOutbox = useAppStore((state) => state.setOutbox);
  const snoozed = useAppStore((state) => state.snoozed);
  const setSnoozed = useAppStore((state) => state.setSnoozed);
  const selectedMessage = useAppStore((state) => state.selectedMessage);
  const selectMessage = useAppStore((state) => state.selectMessage);
  const openComposer = useAppStore((state) => state.openComposer);
  const settings = useAppStore((state) => state.settings);
  const setSettings = useAppStore((state) => state.setSettings);
  const setError = useAppStore((state) => state.setError);
  const { update: updateSettings } = useSettingsSave();
  useEffect(() => {
    hydrateRecentMoveMailbox(settings.recentMoveMailboxId);
  }, [settings.recentMoveMailboxId]);
  useEffect(() => {
    const onRecentFolder = (event: Event) => {
      const mailboxId = (event as CustomEvent<number>).detail;
      if (!Number.isFinite(mailboxId) || mailboxId <= 0) return;
      if (useAppStore.getState().settings.recentMoveMailboxId === mailboxId) {
        return;
      }
      void updateSettings({ recentMoveMailboxId: mailboxId });
    };
    window.addEventListener("postal:recent-move-folder", onRecentFolder);
    return () =>
      window.removeEventListener("postal:recent-move-folder", onRecentFolder);
  }, [updateSettings]);
  const sync = useAppStore((state) =>
    activeAccountId ? state.sync[activeAccountId] : undefined,
  );
  const syncByAccount = useAppStore((state) => state.sync);
  const updateReady = useAppStore((state) => state.updateReady);
  const [query, setQuery] = useState("");
  const [recentByAccount, setRecentByAccount] = useState<
    Record<string, string[]>
  >({});
  const recentSearches = activeAccountId
    ? (recentByAccount[activeAccountId] ?? [])
    : [];
  const [submittedQuery, setSubmittedQuery] = useState("");
  useEffect(() => {
    if (!activeAccountId) return;
    let cancelled = false;
    const accountId = activeAccountId;
    void api.listRecentSearches(accountId).then(
      (queries) => {
        if (cancelled) return;
        setRecentByAccount((current) => ({
          ...current,
          [accountId]: queries,
        }));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [activeAccountId]);
  const [allFolders, setAllFolders] = useState(false);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [outboxPreview, setOutboxPreview] = useState<ComposeDraft | null>(null);
  const [accountSwitcherOpen, setAccountSwitcherOpen] = useState(false);
  const [accountCounts, setAccountCounts] = useState<AccountInboxCount[]>([]);
  const [syncingAllAccounts, setSyncingAllAccounts] = useState(false);
  const [syncingAccountIds, setSyncingAccountIds] = useState<Set<string>>(
    () => new Set(),
  );
  const syncingAccountIdsRef = useRef(new Set<string>());
  const syncingAllRef = useRef(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const onDrawerChange = useCallback((matches: boolean) => {
    if (!matches) setSidebarOpen(false);
  }, []);
  const sidebarDrawerViewport = useMediaQuery(
    MEDIA_QUERIES.sidebarDrawer,
    onDrawerChange,
  );
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const folderPaneRef = useRef<HTMLElement>(null);
  const [loadingMessageId, setLoadingMessageId] = useState<number>();
  const [folderDialog, setFolderDialog] = useState<
    | null
    | { mode: "create"; parentId?: number; parentLabel?: string }
    | { mode: "rename"; id: number; name: string; parentLabel?: string }
  >(null);
  const [folderName, setFolderName] = useState("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [moveFolderId, setMoveFolderId] = useState<number | null>(null);
  const movingFolder =
    moveFolderId == null
      ? undefined
      : mailboxes.find((mailbox) => mailbox.id === moveFolderId);
  const [selecting, setSelecting] = useState(false);
  const viewKey = `${activeAccountId ?? ""}:${activeMailboxId ?? ""}`;
  const [viewEpoch, setViewEpoch] = useState(viewKey);
  const [pendingSort, setPendingSort] = useState<MessageListSort | null>(null);
  const [pendingFilter, setPendingFilter] = useState<MessageListFilter | null>(
    null,
  );
  const switchingView = viewEpoch !== viewKey;
  if (switchingView) {
    setViewEpoch(viewKey);
    setPendingSort(null);
    setPendingFilter(null);
  }
  const savedView = mailboxListView(
    settings.mailboxViews,
    activeAccountId,
    activeMailboxId,
    settings.mailboxSort,
    settings.mailboxFilter,
  );
  const savedSort = savedView.sort;
  const savedFilter = savedView.filter;
  if (!switchingView && pendingSort !== null && pendingSort === savedSort) {
    setPendingSort(null);
  }
  if (
    !switchingView &&
    pendingFilter !== null &&
    pendingFilter === savedFilter
  ) {
    setPendingFilter(null);
  }
  const listSort = switchingView ? savedSort : (pendingSort ?? savedSort);
  const listFilter = switchingView
    ? savedFilter
    : (pendingFilter ?? savedFilter);
  useEffect(() => {
    useAppStore.setState({ mailboxSort: listSort });
  }, [listSort]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const selectionAnchor = useRef<number | undefined>(undefined);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selectionSnoozeOpen, setSelectionSnoozeOpen] = useState(false);
  const [mailboxMoreOpen, setMailboxMoreOpen] = useState(false);
  const mailboxMoreRef = useRef<HTMLDivElement>(null);
  // Close the mailbox menu and give focus back to its button.
  function closeMailboxMore() {
    setMailboxMoreOpen(false);
    mailboxMoreRef.current
      ?.querySelector<HTMLButtonElement>("button[aria-haspopup='menu']")
      ?.focus();
  }
  const toolbarRef = useRef<HTMLElement>(null);
  const newFolderButtonRef = useRef<HTMLButtonElement>(null);
  const lastFolderInvoker = useRef<HTMLElement | null>(null);
  const lastAccountRoute = useRef<string | null>(null);
  const lastAccountRouteAttempt = useRef<string | null>(null);
  const paneResizeStartValues = useRef<
    Partial<
      Record<
        "folderPaneWidth" | "messagePaneWidth" | "readerPaneHeight",
        number
      >
    >
  >({});

  const sidebarVisible = settings.sidebarVisible !== false;

  useEffect(() => {
    if (!mailboxMoreOpen) return;
    const menu = mailboxMoreRef.current;
    const trigger = menu?.querySelector<HTMLButtonElement>(
      "button[aria-haspopup='menu']",
    );
    menu
      ?.querySelector<HTMLButtonElement>(
        "[role='menuitem']:not(:disabled), [role='menuitemradio']:not(:disabled)",
      )
      ?.focus();
    const close = (event: MouseEvent) => {
      if (!mailboxMoreRef.current?.contains(event.target as Node)) {
        setMailboxMoreOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") event.preventDefault();
        setMailboxMoreOpen(false);
        trigger?.focus();
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [mailboxMoreOpen]);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    const shell = toolbar?.closest<HTMLElement>(".mail-shell");
    if (!toolbar || !shell) return;

    const updateToolbarHeight = () => {
      const height = Math.ceil(toolbar.getBoundingClientRect().height);
      if (height > 0)
        shell.style.setProperty("--mail-toolbar-height", `${height}px`);
    };
    updateToolbarHeight();
    window.addEventListener("resize", updateToolbarHeight);
    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", updateToolbarHeight);
    }
    const observer = new ResizeObserver(updateToolbarHeight);
    observer.observe(toolbar);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateToolbarHeight);
    };
  }, []);

  function toggleSidebar() {
    void updateSettings({ sidebarVisible: !sidebarVisible });
  }

  function openFolderDialog(
    dialog:
      | { mode: "create"; parentId?: number; parentLabel?: string }
      | { mode: "rename"; id: number; name: string; parentLabel?: string },
  ) {
    lastFolderInvoker.current =
      dialog.mode === "create"
        ? newFolderButtonRef.current
        : (document.activeElement as HTMLElement | null);
    setFolderName(dialog.mode === "rename" ? dialog.name : "");
    setFolderDialog(dialog);
  }

  function closeFolderDialog() {
    setFolderDialog(null);
    setFolderName("");
    lastFolderInvoker.current?.focus();
  }

  function folderDialogKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeFolderDialog();
    }
  }
  const mailboxRequest = useRef(0);
  const messageRequest = useRef(0);
  const pagingRequest = useRef(0);
  const searchRequest = useRef(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const queryRef = useRef(query);
  const submittedQueryRef = useRef("");
  const allFoldersRef = useRef(allFolders);
  useEffect(() => {
    queryRef.current = query;
    allFoldersRef.current = allFolders;
  }, [allFolders, query]);

  function resetListState() {
    selectionAnchor.current = undefined;
    setSelectedIds([]);
    setSelecting(false);
    setSelectionSnoozeOpen(false);
  }

  function clearQuery() {
    queryRef.current = "";
    submittedQueryRef.current = "";
    setQuery("");
    setSubmittedQuery("");
  }

  function showMessageFolder() {
    const message = useAppStore.getState().selectedMessage;
    if (!message) return;
    const state = useAppStore.getState();
    const sameFolder =
      state.activeMailboxId === message.mailboxId && !state.activeLocalView;
    clearQuery();
    resetListState();
    if (sameFolder) {
      void loadMessages();
      return;
    }
    selectMailbox(message.mailboxId);
    selectMessage(message);
  }

  const loadAccountCounts = useCallback(async () => {
    try {
      setAccountCounts(await api.getAccountInboxCounts());
    } catch {
      // Counts are secondary; account mail remains usable without badges.
    }
  }, []);

  const previousAccountId = useRef(activeAccountId);
  useEffect(() => {
    if (previousAccountId.current === activeAccountId) return;
    previousAccountId.current = activeAccountId;
    mailboxRequest.current += 1;
    messageRequest.current += 1;
    pagingRequest.current += 1;
    beginMessageOpen();
    searchRequest.current += 1;
    clearQuery();
    setFolderDialog(null);
    setFolderName("");
    setAllFolders(false);
    resetListState();
  }, [activeAccountId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadAccountCounts(), 0);
    return () => window.clearTimeout(timer);
  }, [accounts, loadAccountCounts]);

  const loadAccountData = useCallback(async () => {
    if (!activeAccountId) return;
    const accountId = activeAccountId;
    const request = ++mailboxRequest.current;
    try {
      const [mailboxesResult, draftsResult, outboxResult, snoozedResult] =
        await Promise.allSettled([
          api.listMailboxes(accountId),
          api.listDrafts(accountId),
          api.listOutbox(accountId),
          api.listSnoozed(accountId),
        ]);
      if (
        request !== mailboxRequest.current ||
        useAppStore.getState().activeAccountId !== accountId
      )
        return;
      if (mailboxesResult.status === "fulfilled")
        setMailboxes(mailboxesResult.value);
      if (draftsResult.status === "fulfilled") setDrafts(draftsResult.value);
      if (outboxResult.status === "fulfilled") setOutbox(outboxResult.value);
      if (snoozedResult.status === "fulfilled") setSnoozed(snoozedResult.value);
      const failed = [
        mailboxesResult,
        draftsResult,
        outboxResult,
        snoozedResult,
      ].find((result) => result.status === "rejected");
      if (failed?.status === "rejected") setError(String(failed.reason));
    } catch (cause) {
      if (request === mailboxRequest.current) setError(String(cause));
    }
  }, [
    activeAccountId,
    setDrafts,
    setError,
    setMailboxes,
    setOutbox,
    setSnoozed,
  ]);

  const { scheduledSendInFlight, sendScheduledNow } = useScheduledOutbox(
    activeAccountId,
    outbox,
    sync,
    loadAccountData,
    setError,
  );

  const {
    loadMessages,
    loadMoreMessages,
    runSearch,
    canDownloadOlder,
    loadingMessages,
  } = useMailboxMessages({
    listFilter,
    listSort,
    submittedQuery,
    setSubmittedQuery,
    setRecentByAccount,
    messageRequestRef: messageRequest,
    pagingRequestRef: pagingRequest,
    searchRequestRef: searchRequest,
    queryRef,
    submittedQueryRef,
    allFoldersRef,
  });

  function searchAccount(text: string | undefined) {
    const viewing = useAppStore.getState();
    if (!text || !viewing.activeAccountId) return;
    if (viewing.activeLocalView) {
      const mailboxId =
        viewing.selectedMessage?.mailboxId ??
        viewing.mailboxes.find((box) => box.role === "inbox")?.id;
      if (mailboxId == null) return;
      selectMailbox(mailboxId);
      if (useAppStore.getState().activeLocalView) return;
    }
    resetListState();
    queryRef.current = text;
    allFoldersRef.current = true;
    setQuery(text);
    setAllFolders(true);
    void runSearch();
  }

  function searchAddress(field: "from" | "to", address: string) {
    searchAccount(addressSearchQuery(field, address));
  }

  function searchFromSender(address: string) {
    searchAddress("from", address);
  }

  function searchSubject(subject: string) {
    searchAccount(subjectSearchQuery(subject));
  }

  const refreshAccount = useCallback(
    async (accountId: string) => {
      if (syncingAccountIdsRef.current.has(accountId)) return;
      syncingAccountIdsRef.current.add(accountId);
      setSyncingAccountIds(new Set(syncingAccountIdsRef.current));
      try {
        await api.syncAccount(accountId);
        if (useAppStore.getState().activeAccountId === accountId) {
          await loadAccountData();
          if (submittedQueryRef.current) await runSearch();
          else await loadMessages();
        }
      } catch (cause) {
        if (useAppStore.getState().activeAccountId === accountId) {
          setError(String(cause));
        }
      } finally {
        syncingAccountIdsRef.current.delete(accountId);
        setSyncingAccountIds(new Set(syncingAccountIdsRef.current));
      }
    },
    [loadAccountData, loadMessages, runSearch, setError],
  );

  const refresh = useCallback(async () => {
    if (activeAccountId) await refreshAccount(activeAccountId);
  }, [activeAccountId, refreshAccount]);

  // Same progress and error handling as one account; counts come from STATUS.
  const refreshAllAccounts = useCallback(async () => {
    if (syncingAllRef.current) return;
    syncingAllRef.current = true;
    setSyncingAllAccounts(true);
    const ids = useAppStore.getState().accounts.map((account) => account.id);
    // Only claim accounts no single refresh already owns.
    const claimed = ids.filter((id) => !syncingAccountIdsRef.current.has(id));
    for (const id of claimed) syncingAccountIdsRef.current.add(id);
    setSyncingAccountIds(new Set(syncingAccountIdsRef.current));
    try {
      const synced = await api.syncAllAccounts();
      const failed = ids.filter((id) => !synced.includes(id)).length;
      if (failed > 0) setError(strings.mail.refreshAllPartial(failed));
      await loadAccountCounts();
      if (useAppStore.getState().activeAccountId) {
        await loadAccountData();
        if (submittedQueryRef.current) await runSearch();
        else await loadMessages();
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      for (const id of claimed) syncingAccountIdsRef.current.delete(id);
      setSyncingAccountIds(new Set(syncingAccountIdsRef.current));
      syncingAllRef.current = false;
      setSyncingAllAccounts(false);
    }
  }, [loadAccountCounts, loadAccountData, loadMessages, runSearch, setError]);

  async function refreshList() {
    if (submittedQueryRef.current) await runSearch();
    else await loadMessages();
  }

  async function submitFolderDialog() {
    if (!activeAccountId || folderBusy) return;
    const name = folderName.trim();
    if (!name) return;
    setFolderBusy(true);
    try {
      if (folderDialog?.mode === "rename") {
        await api.renameFolder(activeAccountId, folderDialog.id, name);
      } else {
        const parentId =
          folderDialog?.mode === "create" ? folderDialog.parentId : undefined;
        if (parentId == null) await api.createFolder(activeAccountId, name);
        else await api.createFolder(activeAccountId, name, parentId);
        if (
          parentId != null &&
          mailboxIsPinned(
            useAppStore.getState().settings.collapsedMailboxes,
            activeAccountId,
            parentId,
          )
        ) {
          void updateSettings({
            collapsedMailboxes: unpinMailbox(
              useAppStore.getState().settings.collapsedMailboxes,
              activeAccountId,
              parentId,
            ),
          });
        }
      }
      closeFolderDialog();
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setFolderBusy(false);
    }
  }

  async function submitMoveFolder(parentId: number | null) {
    if (!activeAccountId || moveFolderId == null || folderBusy) return;
    const accountId = activeAccountId;
    const mailboxId = moveFolderId;
    setFolderBusy(true);
    try {
      if (parentId == null) await api.moveFolder(accountId, mailboxId);
      else await api.moveFolder(accountId, mailboxId, parentId);
      setMoveFolderId(null);
      if (
        parentId != null &&
        mailboxIsPinned(
          useAppStore.getState().settings.collapsedMailboxes,
          accountId,
          parentId,
        )
      ) {
        void updateSettings({
          collapsedMailboxes: unpinMailbox(
            useAppStore.getState().settings.collapsedMailboxes,
            accountId,
            parentId,
          ),
        });
      }
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setFolderBusy(false);
    }
  }

  async function deleteFolderById(id: number, label: string) {
    if (!activeAccountId) return;
    const confirmed = await api.showNativeConfirm(
      strings.appName,
      strings.mail.deleteFolderQuestion(label),
    );
    if (!confirmed) return;
    try {
      await api.deleteFolder(activeAccountId, id);
      const latest = useAppStore.getState();
      if (
        mailboxIsPinned(latest.settings.pinnedMailboxes, activeAccountId, id)
      ) {
        void updateSettings({
          pinnedMailboxes: unpinMailbox(
            latest.settings.pinnedMailboxes,
            activeAccountId,
            id,
          ),
        });
      }
      if (latest.settings.recentMoveMailboxId === id) {
        void updateSettings({ recentMoveMailboxId: null });
      }
      if (
        mailboxIsPinned(latest.settings.hiddenMailboxes, activeAccountId, id)
      ) {
        void updateSettings({
          hiddenMailboxes: unpinMailbox(
            latest.settings.hiddenMailboxes,
            activeAccountId,
            id,
          ),
        });
      }
      if (
        mailboxIsPinned(latest.settings.collapsedMailboxes, activeAccountId, id)
      ) {
        void updateSettings({
          collapsedMailboxes: unpinMailbox(
            latest.settings.collapsedMailboxes,
            activeAccountId,
            id,
          ),
        });
      }
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function emptyTrashFolders() {
    if (!activeAccountId) return;
    const confirmed = await api.showNativeConfirm(
      strings.appName,
      strings.mail.emptyTrashQuestion,
    );
    if (!confirmed) return;
    try {
      await api.emptyTrash(activeAccountId);
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function emptyJunkFolders() {
    if (!activeAccountId) return;
    const confirmed = await api.showNativeConfirm(
      strings.appName,
      strings.mail.emptyJunkQuestion,
    );
    if (!confirmed) return;
    try {
      await api.emptyJunk(activeAccountId);
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
    }
  }

  function archiveFocused(message: MessageSummary, conversation: boolean) {
    const current = useAppStore.getState();
    const mailbox = current.mailboxes.find(
      (box) => box.id === message.mailboxId,
    );
    const toInbox = mailbox?.role === "archive";
    const loaded = conversation
      ? conversationMessages(current.messages, message)
      : [];
    const members = loaded.length > 1 ? loaded : [message];
    const removed = new Set(members.map((item) => item.id));
    const after = (next?: MessageSummary, openWasMoved?: boolean) => {
      setSelectedIds((ids) => ids.filter((id) => !removed.has(id)));
      if (!openWasMoved) return;
      if (next) void chooseMessage(next);
      else {
        beginMessageOpen();
        selectMessage(undefined);
      }
    };
    if (members.length > 1) {
      if (toInbox) {
        const inbox = current.mailboxes.find(
          (box) => box.accountId === message.accountId && box.role === "inbox",
        );
        if (!inbox) {
          setError(strings.mail.noInbox);
          return;
        }
        void moveLoadedConversation(message, inbox.id, after);
        return;
      }
      void moveLoadedConversation(message, "archive", after);
      return;
    }
    void moveListedMessage(message, toInbox ? "inbox" : "archive", after);
  }

  function trashFocused(message: MessageSummary, conversation: boolean) {
    const current = useAppStore.getState();
    const mailbox = current.mailboxes.find(
      (box) => box.id === message.mailboxId,
    );
    const loaded = conversation
      ? conversationMessages(current.messages, message)
      : [];
    const members = loaded.length > 1 ? loaded : [message];
    const removed = new Set(members.map((item) => item.id));
    const after = (next?: MessageSummary, openWasMoved?: boolean) => {
      setSelectedIds((ids) => ids.filter((id) => !removed.has(id)));
      if (!openWasMoved) return;
      if (next) void chooseMessage(next);
      else {
        beginMessageOpen();
        selectMessage(undefined);
      }
    };
    if (mailbox?.role === "trash") {
      if (members.length > 1) {
        void deleteLoadedConversation(message, after);
        return;
      }
      void deleteListedMessage(message, after);
      return;
    }
    if (members.length > 1) {
      void moveLoadedConversation(message, "trash", after);
      return;
    }
    void moveListedMessage(message, "trash", after);
  }

  function junkFocused(message: MessageSummary, conversation: boolean) {
    const current = useAppStore.getState();
    const mailbox = current.mailboxes.find(
      (box) => box.id === message.mailboxId,
    );
    const toInbox = mailbox?.role === "junk";
    const loaded = conversation
      ? conversationMessages(current.messages, message)
      : [];
    const members = loaded.length > 1 ? loaded : [message];
    const removed = new Set(members.map((item) => item.id));
    const after = (next?: MessageSummary, openWasMoved?: boolean) => {
      setSelectedIds((ids) => ids.filter((id) => !removed.has(id)));
      if (!openWasMoved) return;
      if (next) void chooseMessage(next);
      else {
        beginMessageOpen();
        selectMessage(undefined);
      }
    };
    if (members.length > 1) {
      if (toInbox) {
        const inbox = current.mailboxes.find(
          (box) => box.accountId === message.accountId && box.role === "inbox",
        );
        if (!inbox) {
          setError(strings.mail.noInbox);
          return;
        }
        void moveLoadedConversation(message, inbox.id, after);
        return;
      }
      void moveLoadedConversation(message, "junk", after);
      return;
    }
    void moveListedMessage(message, toInbox ? "inbox" : "junk", after);
  }

  async function replyFocused(
    message: MessageSummary,
    mode: "reply" | "replyAll",
  ) {
    const accountId = message.accountId;
    try {
      const detail = await api.getMessage(accountId, message.id);
      const state = useAppStore.getState();
      if (state.activeAccountId !== accountId) return;
      const account = state.accounts.find((item) => item.id === accountId);
      openComposer({
        sourceMessage: detail,
        composeMode:
          mode === "reply"
            ? preferredReplyMode(
                detail,
                state.settings.replyToAll,
                account?.email ?? "",
                account?.aliases ?? [],
              )
            : mode,
      });
    } catch (cause) {
      setError(String(cause));
    }
  }

  function toggleSelectIds(ids: number[]) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    setSelecting(true);
    selectionAnchor.current = unique[0];
    setSelectedIds((prev) => {
      const chosen = new Set(unique);
      if (unique.every((id) => prev.includes(id))) {
        return prev.filter((id) => !chosen.has(id));
      }
      const next = [...prev];
      for (const id of unique) {
        if (next.includes(id)) continue;
        if (next.length >= 200) {
          setError(strings.mail.bulkTooMany);
          break;
        }
        next.push(id);
      }
      return next;
    });
  }

  function toggleSelectMessage(id: number) {
    selectionAnchor.current = id;
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((item) => item !== id);
      if (prev.length >= 200) {
        setError(strings.mail.bulkTooMany);
        return prev;
      }
      return [...prev, id];
    });
  }

  function selectMessageRange(targetId: number, fallbackAnchorId?: number) {
    if (
      selectionAnchor.current === undefined &&
      fallbackAnchorId !== undefined
    ) {
      selectionAnchor.current = fallbackAnchorId;
    }
    const result = rangeSelection(
      listedMessages.map((message) => message.id),
      selectionAnchor.current,
      targetId,
    );
    if (!result) return;
    if (result.capped) setError(strings.mail.bulkTooMany);
    setSelectedIds(result.ids);
  }

  async function bulkFlags(isRead?: boolean, isStarred?: boolean) {
    if (!activeAccountId || selectedIds.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    try {
      const outcome = await api.setMessagesFlags(
        activeAccountId,
        selectedIds,
        isRead,
        isStarred,
      );
      if (outcome.failed > 0)
        setError(strings.mail.bulkPartial(outcome.failed));
      setSelectedIds([]);
      setSelecting(false);
      await refreshList();
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBulkBusy(false);
    }
  }

  async function deleteSelectedTrash() {
    if (!activeAccountId || selectedIds.length === 0 || bulkBusy) return;
    const mailbox = mailboxes.find((item) => item.id === activeMailboxId);
    if (mailbox?.role !== "trash") return;
    if (selectedIds.length > 200) {
      setError(strings.mail.bulkTooMany);
      return;
    }
    const ids = selectedIds.slice();
    const confirmed = await api.showNativeConfirm(
      strings.mail.deleteForever,
      strings.mail.deleteForeverQuestion(ids.length),
    );
    if (!confirmed) return;
    const latest = useAppStore.getState();
    if (
      latest.activeAccountId !== activeAccountId ||
      latest.activeMailboxId !== activeMailboxId
    )
      return;
    setBulkBusy(true);
    try {
      await api.deleteTrashMessages(activeAccountId, ids);
      const open = useAppStore.getState().selectedMessage;
      if (open && ids.includes(open.id)) selectMessage(undefined);
      setSelectedIds([]);
      setSelecting(false);
      await refreshList();
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkMove(role: "archive" | "trash" | "junk" | "inbox") {
    if (!activeAccountId || selectedIds.length === 0 || bulkBusy) return;
    const destination = mailboxes.find(
      (mailbox) =>
        mailbox.accountId === activeAccountId && mailbox.role === role,
    );
    if (!destination) {
      setError(strings.mail.noTargetFolder);
      return;
    }
    await bulkMoveTo(destination.id);
  }

  async function bulkMoveTo(mailboxId: number) {
    if (!activeAccountId || selectedIds.length === 0 || bulkBusy) return;
    const destination = mailboxes.find(
      (mailbox) =>
        mailbox.accountId === activeAccountId && mailbox.id === mailboxId,
    );
    if (!destination) {
      setError(strings.mail.noTargetFolder);
      return;
    }
    setBulkBusy(true);
    try {
      const movedIds = selectedIds;
      const outcome = await api.moveMessagesToMailbox(
        activeAccountId,
        movedIds,
        destination.id,
      );
      if (outcome.failed > 0)
        setError(strings.mail.bulkPartial(outcome.failed));
      // The bulk event names no message, so close a moved open message here.
      const open = useAppStore.getState().selectedMessage;
      if (open && movedIds.includes(open.id)) selectMessage(undefined);
      setSelectedIds([]);
      setSelecting(false);
      await refreshList();
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBulkBusy(false);
    }
  }

  async function pinSelection(pinned: boolean) {
    if (!activeAccountId || selectedIds.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    try {
      await pinSelectedMessages(activeAccountId, selectedIds, pinned);
    } finally {
      setBulkBusy(false);
    }
  }

  async function snoozeSelection(untilIso: string) {
    if (!activeAccountId || selectedIds.length === 0 || bulkBusy) return;
    if (selectedIds.length > 200) {
      setError(strings.mail.bulkTooMany);
      return;
    }
    const accountId = activeAccountId;
    const ids = selectedIds.slice();
    const removed = new Set(ids);
    const current = useAppStore.getState();
    const open = current.selectedMessage;
    const openRemoved = Boolean(
      open && removed.has(open.id) && open.accountId === accountId,
    );
    const next =
      openRemoved && open
        ? messageAfterRemovals(
            current.messages,
            current.settings.groupThreads &&
              (current.mailboxSort ?? "date") === "date",
            removed,
            open.id,
          )
        : undefined;
    setBulkBusy(true);
    try {
      await api.snoozeMessages(accountId, ids, untilIso);
    } catch (cause) {
      setError(String(cause));
      setBulkBusy(false);
      return;
    }
    if (openRemoved) selectMessage(undefined);
    setSelectionSnoozeOpen(false);
    setSelectedIds([]);
    setSelecting(false);
    const request = openRemoved ? beginMessageOpen() : undefined;
    try {
      await loadAccountData();
      await refreshList();
    } catch (cause) {
      setError(String(cause));
      return;
    } finally {
      setBulkBusy(false);
    }
    if (request === undefined || !isCurrentMessageOpen(request)) return;
    const after = useAppStore.getState();
    if (after.activeAccountId !== accountId || after.activeLocalView) return;
    const summary = next
      ? after.messages.find((item) => item.id === next.id)
      : undefined;
    if (summary) await chooseMessage(summary);
  }

  async function bulkCopyTo(mailboxId: number) {
    if (!activeAccountId || selectedIds.length === 0 || bulkBusy) return;
    const destination = mailboxes.find(
      (mailbox) =>
        mailbox.accountId === activeAccountId && mailbox.id === mailboxId,
    );
    if (!destination) {
      setError(strings.mail.noTargetFolder);
      return;
    }
    setBulkBusy(true);
    try {
      const outcome = await api.copyMessagesToMailbox(
        activeAccountId,
        selectedIds,
        destination.id,
      );
      if (outcome.failed > 0)
        setError(strings.mail.bulkPartial(outcome.failed));
      else if (outcome.queued > 0) setError(strings.mail.copyQueued);
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBulkBusy(false);
    }
  }

  async function dropMessages(mailboxId: number, payload: string) {
    if (!activeAccountId || bulkBusy) return;
    const ids = readMessageDrag(payload, activeAccountId);
    if (!ids) return;
    const known = ids.filter((id) =>
      messages.some((message) => message.id === id),
    );
    if (known.length === 0) return;
    if (known.length > 200) {
      setError(strings.mail.bulkTooMany);
      return;
    }
    const destination = mailboxes.find(
      (mailbox) =>
        mailbox.accountId === activeAccountId && mailbox.id === mailboxId,
    );
    if (!destination || destination.id === activeMailboxId) return;
    const open = useAppStore.getState().selectedMessage;
    const releaseDragged = (id: number) => {
      setSelectedIds((current) => {
        const next = current.filter((item) => item !== id);
        if (next.length === 0) setSelecting(false);
        return next;
      });
    };
    if (known.length === 1 && open?.id === known[0]) {
      releaseDragged(known[0]);
      window.dispatchEvent(
        new CustomEvent("postal:move-mailbox", { detail: destination.id }),
      );
      return;
    }
    setBulkBusy(true);
    try {
      if (known.length === 1) {
        await api.moveMessageToMailbox(
          activeAccountId,
          known[0],
          destination.id,
        );
        releaseDragged(known[0]);
      } else {
        const outcome = await api.moveMessagesToMailbox(
          activeAccountId,
          known,
          destination.id,
        );
        if (outcome.failed > 0)
          setError(strings.mail.bulkPartial(outcome.failed));
        setSelectedIds([]);
        setSelecting(false);
      }
      if (open && known.includes(open.id)) selectMessage(undefined);
      await refreshList();
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBulkBusy(false);
    }
  }

  async function markMailboxReadById(mailboxId: number) {
    if (!activeAccountId || bulkBusy) return;
    const accountId = activeAccountId;
    setBulkBusy(true);
    try {
      const outcome = await api.markMailboxRead(accountId, mailboxId);
      if (outcome.failed > 0)
        setError(strings.mail.bulkPartial(outcome.failed));
      const latest = useAppStore.getState();
      if (
        latest.activeAccountId === accountId &&
        latest.activeMailboxId === mailboxId &&
        !latest.activeLocalView
      ) {
        await refreshList();
      }
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBulkBusy(false);
    }
  }

  async function markAllRead() {
    if (!activeMailboxId) return;
    await markMailboxReadById(activeMailboxId);
  }

  const chooseMessage = useCallback(
    async (summary: MessageSummary) => {
      const accountId = activeAccountId;
      const mailboxId = activeMailboxId;
      if (!accountId || !mailboxId) return false;
      const request = beginMessageOpen();
      setLoadingMessageId(summary.id);
      try {
        const detail = await api.getMessage(accountId, summary.id);
        const current = useAppStore.getState();
        if (
          !isCurrentMessageOpen(request) ||
          current.activeAccountId !== accountId ||
          current.activeMailboxId !== mailboxId
        )
          return false;
        selectMessage(detail);
        const readyToMark = !summary.isRead
          ? await waitToMarkRead(
              useAppStore.getState().settings.markRead,
              () => {
                const latest = useAppStore.getState();
                return (
                  isCurrentMessageOpen(request) &&
                  latest.activeAccountId === accountId &&
                  latest.activeMailboxId === mailboxId &&
                  !latest.activeLocalView &&
                  latest.selectedMessage?.id === summary.id
                );
              },
            )
          : false;
        if (readyToMark) {
          await api.setMessageFlags(accountId, summary.id, true, undefined);
          const latest = useAppStore.getState();
          if (
            isCurrentMessageOpen(request) &&
            latest.activeAccountId === accountId &&
            latest.activeMailboxId === mailboxId &&
            !latest.activeLocalView
          ) {
            setMessages(
              latest.messages.map((message) =>
                message.id === summary.id
                  ? { ...message, isRead: true }
                  : message,
              ),
              latest.messageCursor,
              latest.hasMoreMessages,
            );
            if (latest.selectedMessage?.id === summary.id)
              selectMessage({ ...detail, isRead: true });
            await loadAccountData();
          }
        }
      } catch (cause) {
        if (!isCurrentMessageOpen(request)) return false;
        const detail = String(cause);
        setError(detail);
        if (isOversizeError(cause)) {
          selectMessage({
            ...summary,
            to: [],
            cc: [],
            replyTo: null,
            textBody: "",
            htmlBody: null,
            remoteImagesBlocked: false,
            attachments: [],
          });
        }
      } finally {
        if (isCurrentMessageOpen(request)) setLoadingMessageId(undefined);
      }
      return useAppStore.getState().selectedMessage?.id === summary.id;
    },
    [
      activeAccountId,
      activeMailboxId,
      loadAccountData,
      selectMessage,
      setError,
      setMessages,
    ],
  );

  const restoreFolder = useRef("");
  const restoredFor = useRef("");
  useEffect(() => {
    const folderKey =
      activeAccountId && activeMailboxId && !activeLocalView
        ? `${activeAccountId}:${activeMailboxId}`
        : "";
    if (restoreFolder.current !== folderKey) {
      restoreFolder.current = folderKey;
      restoredFor.current = "";
    }
    if (
      !folderKey ||
      !activeAccountId ||
      !activeMailboxId ||
      activeLocalView ||
      submittedQuery ||
      loadingMessages ||
      messages.length === 0 ||
      restoredFor.current === folderKey
    ) {
      return;
    }
    restoredFor.current = folderKey;
    if (selectedMessage) return;
    const messageId = rememberedOpenMessage(activeAccountId, activeMailboxId);
    const summary = messages.find((item) => item.id === messageId);
    // An unread message was left unread on purpose; reopening would mark it read.
    if (summary?.isRead) void chooseMessage(summary);
  }, [
    activeAccountId,
    activeLocalView,
    activeMailboxId,
    chooseMessage,
    loadingMessages,
    messages,
    selectedMessage,
    submittedQuery,
  ]);

  async function openEarlierMessage(summary: MessageSummary) {
    const accountId = useAppStore.getState().activeAccountId;
    const detail = useAppStore.getState().selectedMessage;
    if (!accountId || !detail || detail.id !== summary.id) return;
    const headerId = earlierHeaderId(detail);
    if (!headerId) return;
    let found: MessageSummary | null;
    try {
      found = await api.findCachedMessage(accountId, headerId);
    } catch (cause) {
      setError(String(cause));
      return;
    }
    if (!found || found.id === summary.id) {
      setError(strings.reader.earlierMessageMissing);
      return;
    }
    clearQuery();
    resetListState();
    const viewing = useAppStore.getState();
    if (
      found.mailboxId === viewing.activeMailboxId &&
      !viewing.activeLocalView
    ) {
      void chooseMessage(found);
      return;
    }
    selectMailbox(found.mailboxId);
    const mailboxId = found.mailboxId;
    const request = beginMessageOpen();
    setLoadingMessageId(found.id);
    try {
      const opened = await api.getMessage(accountId, found.id);
      const current = useAppStore.getState();
      if (
        !isCurrentMessageOpen(request) ||
        current.activeAccountId !== accountId ||
        current.activeMailboxId !== mailboxId
      )
        return;
      selectMessage(opened);
      const readyToMark = !found.isRead
        ? await waitToMarkRead(useAppStore.getState().settings.markRead, () => {
            const latest = useAppStore.getState();
            return (
              isCurrentMessageOpen(request) &&
              latest.activeAccountId === accountId &&
              latest.activeMailboxId === mailboxId &&
              !latest.activeLocalView &&
              latest.selectedMessage?.id === found.id
            );
          })
        : false;
      if (readyToMark) {
        await api.setMessageFlags(accountId, found.id, true, undefined);
        const latest = useAppStore.getState();
        if (
          isCurrentMessageOpen(request) &&
          latest.activeAccountId === accountId &&
          latest.activeMailboxId === mailboxId &&
          latest.selectedMessage?.id === found.id
        )
          selectMessage({ ...opened, isRead: true });
      }
    } catch (cause) {
      if (isCurrentMessageOpen(request)) setError(String(cause));
    } finally {
      if (isCurrentMessageOpen(request)) setLoadingMessageId(undefined);
    }
  }

  useEffect(() => {
    void loadAccountData();
  }, [loadAccountData]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadMessages(), 0);
    return () => window.clearTimeout(timer);
  }, [loadMessages]);

  const loadersRef = useRef({ loadAccountData, loadMessages, runSearch });
  useEffect(() => {
    loadersRef.current = { loadAccountData, loadMessages, runSearch };
  });

  useMailEvents({
    loadAccountCounts,
    loadersRef,
    submittedQueryRef,
    setError,
  });

  useMailShortcuts({
    accounts,
    selectAccount,
    setAccountSwitcherOpen,
    openComposer,
    refresh,
    refreshAll: refreshAllAccounts,
    onOpenSettings,
    updateSettings,
    searchInput,
    chooseMessage,
    relativeMessage,
  });

  useEffect(() => {
    if (!activeAccountId) return;
    const routeKey = JSON.stringify([activeAccountId, activeMailboxId ?? null]);
    if (lastAccountRoute.current !== routeKey) {
      lastAccountRoute.current = routeKey;
      lastAccountRouteAttempt.current = null;
    }
    if (
      settings.lastAccountId === activeAccountId &&
      settings.lastMailboxId === (activeMailboxId ?? null)
    )
      return;
    const attemptKey = JSON.stringify([
      routeKey,
      settings.lastAccountId ?? null,
      settings.lastMailboxId ?? null,
    ]);
    if (lastAccountRouteAttempt.current === attemptKey) return;
    const timer = window.setTimeout(() => {
      lastAccountRouteAttempt.current = attemptKey;
      void updateSettings({
        lastAccountId: activeAccountId,
        lastMailboxId: activeMailboxId ?? null,
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [activeAccountId, activeMailboxId, settings, updateSettings]);

  function resizePane(
    key: "folderPaneWidth" | "messagePaneWidth" | "readerPaneHeight",
    value: number,
    persist: boolean,
  ) {
    const previous = useAppStore.getState().settings;
    const limits = {
      folderPaneWidth: [210, 420],
      messagePaneWidth: [300, 720],
      readerPaneHeight: [240, 800],
    } as const;
    const [minimum, maximum] = limits[key];
    const next = {
      ...previous,
      [key]: Math.round(Math.min(maximum, Math.max(minimum, value))),
    };
    if (!persist) {
      paneResizeStartValues.current[key] ??= previous[key];
      setSettings(next);
      return;
    }

    const rollbackValue = paneResizeStartValues.current[key] ?? previous[key];
    delete paneResizeStartValues.current[key];
    setSettings(next);
    void updateSettings({ [key]: next[key] }, undefined, {
      rollback: { [key]: rollbackValue },
    });
  }

  const {
    duplicateDraft,
    discardListedDraft,
    continueDraft,
    openDraft,
    retryAllQueued,
    retryQueued,
    retrySentCopy,
    retryArchiveAfterSend,
    unsnoozeById,
    handleSnoozedMessage,
    handleConversationSnoozed,
    chooseSnoozed,
    previewQueued,
    editQueued,
    discardQueued,
  } = useLocalListActions({
    activeAccountId,
    loadAccountData,
    refreshList,
    chooseMessage,
    setLoadingMessageId,
    setOutboxPreview,
    scheduledSendInFlight,
    selectMessage,
    openComposer,
    setDrafts,
    setError,
  });

  useEffect(() => {
    const onAction = (event: Event) =>
      handleContextAction(event, {
        activeAccountId,
        refreshAccount,
        selectAccount,
        onOpenSettings,
        openComposer,
        searchAddress,
        searchFromSender,
        searchSubject,
        chooseMessage,
        selectMessage,
        openEarlierMessage,
        selectionAnchor,
        setSelecting,
        setSelectedIds,
        setError,
        messageRequest,
        searchRequest,
        clearQuery,
        resetListState,
        selectMailbox,
        selectLocalView,
        setSidebarOpen,
        loadMessages,
        markMailboxReadById,
        emptyTrashFolders,
        emptyJunkFolders,
        updateSettings,
        openFolderDialog,
        setMoveFolderId,
        deleteFolderById,
        openDraft,
        duplicateDraft,
        discardListedDraft,
        previewQueued,
        editQueued,
        retryQueued,
        retrySentCopy,
        retryArchiveAfterSend,
        sendScheduledNow,
        scheduledSendInFlight,
        discardQueued,
        chooseSnoozed,
        unsnoozeById,
      });
    window.addEventListener(CONTEXT_ACTION_EVENT, onAction);
    return () => window.removeEventListener(CONTEXT_ACTION_EVENT, onAction);
  });

  useOverlayFocus({
    sidebarOpen,
    setSidebarOpen,
    sidebarDrawerViewport,
    folderPaneRef,
    sidebarToggleRef,
    selectedMessage,
    settings,
  });

  const activeMailbox = useMemo(
    () => mailboxes.find((box) => box.id === activeMailboxId),
    [activeMailboxId, mailboxes],
  );
  const activeAccount = useMemo(
    () => accounts.find((account) => account.id === activeAccountId),
    [activeAccountId, accounts],
  );
  const busy = activeAccountId ? syncingAccountIds.has(activeAccountId) : false;
  function openRoleMailbox(role: "inbox" | "sent") {
    closeMailboxMore();
    const mailbox = mailboxByRole(mailboxes, role);
    if (!mailbox) {
      setError(role === "inbox" ? strings.mail.noInbox : strings.mail.noSent);
      return;
    }
    if (mailbox.id === activeMailboxId && !activeLocalView) return;
    selectMailbox(mailbox.id);
  }

  function roleMailboxOpen(role: "inbox" | "sent") {
    return (
      mailboxByRole(mailboxes, role)?.id === activeMailboxId && !activeLocalView
    );
  }

  const heading = activeLocalView
    ? activeLocalView === "drafts"
      ? strings.mail.drafts
      : activeLocalView === "snoozed"
        ? strings.mail.snoozed
        : strings.mail.outbox
    : activeMailbox
      ? folderLabel(activeMailbox)
      : strings.mail.mail;
  const listedMessages =
    activeLocalView || submittedQuery || listFilter === "all"
      ? messages
      : messages.filter(
          (message) =>
            matchesListFilter(message, listFilter) ||
            (selectedMessage?.id === message.id &&
              selectedMessage.mailboxId === message.mailboxId),
        );
  const canFoldConversations =
    settings.groupThreads &&
    listSort === "date" &&
    !selecting &&
    groupThreads(listedMessages).some((group) => group.items.length > 1);
  const openAccount =
    accounts.length > 1
      ? accounts.find((account) => account.id === activeAccountId)
      : undefined;
  const accountLabel = openAccount?.displayName || openAccount?.email;
  const shownCount = activeLocalView
    ? activeLocalView === "drafts"
      ? drafts.length
      : activeLocalView === "snoozed"
        ? snoozed.length
        : outbox.length
    : listedMessages.length;
  const shellClass = `mail-shell pane-${settings.readingPane} ${sidebarOpen ? "sidebar-open" : ""} ${sidebarVisible ? "" : "sidebar-collapsed"} ${selectedMessage ? "message-open" : ""}`;

  const shellStyle = {
    "--folder-pane-width": `${settings.folderPaneWidth}px`,
    "--message-pane-width": `${settings.messagePaneWidth}px`,
    "--reader-pane-height": `${settings.readerPaneHeight}px`,
  } as CSSProperties;

  return (
    <main className={shellClass} style={shellStyle}>
      <MailToolbar
        toolbarRef={toolbarRef}
        sidebarToggleRef={sidebarToggleRef}
        sidebarDrawerViewport={sidebarDrawerViewport}
        sidebarOpen={sidebarOpen}
        sidebarVisible={sidebarVisible}
        busy={busy}
        accountCount={accounts.length}
        syncingAll={syncingAllAccounts}
        onRefreshAll={() => void refreshAllAccounts()}
        updateReady={updateReady}
        inputRef={searchInput}
        query={query}
        recentSearches={recentSearches}
        onPickRecent={(text) => {
          queryRef.current = text;
          setQuery(text);
          void runSearch();
        }}
        onForgetRecent={(text) => {
          if (!activeAccountId) return;
          const accountId = activeAccountId;
          void api.forgetRecentSearch(accountId, text).then(
            (queries) => {
              setRecentByAccount((current) => ({
                ...current,
                [accountId]: queries,
              }));
            },
            () => undefined,
          );
        }}
        onClearRecent={() => {
          if (!activeAccountId) return;
          const accountId = activeAccountId;
          setRecentByAccount((current) => ({ ...current, [accountId]: [] }));
          void api.forgetRecentSearches(accountId).catch(() => undefined);
        }}
        activeLocalView={activeLocalView}
        allFolders={allFolders}
        onToggleSidebar={() => {
          if (sidebarDrawerViewport) setSidebarOpen((open) => !open);
          else toggleSidebar();
        }}
        onRefresh={() => void refresh()}
        onCompose={() => openComposer()}
        onSubmit={() => void runSearch()}
        onQueryChange={(value) => {
          queryRef.current = value;
          setQuery(value);
          if (!value.trim() && submittedQueryRef.current) {
            submittedQueryRef.current = "";
            searchRequest.current += 1;
            setSubmittedQuery("");
            void loadMessages();
          }
        }}
        onToggleScope={() => {
          const next = !allFolders;
          allFoldersRef.current = next;
          setAllFolders(next);
          if (queryRef.current.trim()) void runSearch();
        }}
        onApplyUpdate={() => void applyPendingUpdate()}
        onOpenSettings={() => onOpenSettings()}
      />

      <button
        className="sidebar-scrim"
        type="button"
        aria-label={strings.mail.closeMailboxes}
        onClick={() => setSidebarOpen(false)}
      />
      <Sidebar
        folderPaneRef={folderPaneRef}
        accounts={accounts}
        activeAccount={activeAccount}
        accountCounts={accountCounts}
        syncByAccount={syncByAccount}
        activeSync={sync}
        accountSwitcherOpen={accountSwitcherOpen}
        syncingAllAccounts={syncingAllAccounts}
        onAccountSwitcherOpenChange={setAccountSwitcherOpen}
        onSelectAccount={selectAccount}
        onRefreshAllAccounts={() => void refreshAllAccounts()}
        onAddAccount={() => setAddAccountOpen(true)}
        onOpenSettings={onOpenSettings}
        onCloseSidebar={() => setSidebarOpen(false)}
        activeLocalView={activeLocalView}
        draftsCount={drafts.length}
        outboxCount={outbox.length}
        snoozedCount={snoozed.length}
        onSelectLocalView={(view) => {
          messageRequest.current += 1;
          searchRequest.current += 1;
          clearQuery();
          resetListState();
          selectLocalView(view);
          setSidebarOpen(false);
        }}
        mailboxes={mailboxes}
        pinnedMailboxes={settings.pinnedMailboxes ?? []}
        hiddenMailboxes={settings.hiddenMailboxes ?? []}
        collapsedMailboxIds={(settings.collapsedMailboxes ?? [])
          .filter((entry) => entry.accountId === activeAccountId)
          .map((entry) => entry.mailboxId)}
        unreadFoldersOnly={settings.unreadFoldersOnly}
        onUnreadFoldersOnlyChange={(unreadOnly) =>
          void updateSettings({ unreadFoldersOnly: unreadOnly })
        }
        onCollapseFolders={() => {
          if (!activeAccountId) return;
          const next = collapseFolders(
            settings.collapsedMailboxes ?? [],
            activeAccountId,
            parentMailboxIds(mailboxes),
          );
          if (next) void updateSettings({ collapsedMailboxes: next });
        }}
        onExpandFolders={() => {
          if (!activeAccountId) return;
          const next = expandFolders(
            settings.collapsedMailboxes ?? [],
            activeAccountId,
            parentMailboxIds(mailboxes),
          );
          if (next) void updateSettings({ collapsedMailboxes: next });
        }}
        onToggleCollapsed={(mailboxId, collapsed) => {
          if (!activeAccountId) return;
          const current = settings.collapsedMailboxes ?? [];
          if (
            collapsed &&
            mailboxIsPinned(current, activeAccountId, mailboxId)
          ) {
            return;
          }
          const next = collapsed
            ? pinMailbox(current, activeAccountId, mailboxId, 200)
            : unpinMailbox(current, activeAccountId, mailboxId);
          if (!next) return;
          void updateSettings({ collapsedMailboxes: next });
        }}
        activeMailboxId={activeMailboxId}
        folderIcons={folderIcons}
        folderDialog={folderDialog}
        folderName={folderName}
        folderBusy={folderBusy}
        newFolderButtonRef={newFolderButtonRef}
        onFolderClick={(mailbox) => {
          const sameMailbox =
            mailbox.id === activeMailboxId && !activeLocalView;
          if (!sameMailbox) messageRequest.current += 1;
          searchRequest.current += 1;
          clearQuery();
          resetListState();
          selectMailbox(mailbox.id);
          setSidebarOpen(false);
          if (sameMailbox) void loadMessages();
        }}
        onFolderRename={(mailbox) => {
          openFolderDialog({
            mode: "rename",
            id: mailbox.id,
            name: folderLabel(mailbox),
            parentLabel: folderParentLabel(mailbox),
          });
        }}
        onFolderDelete={(mailbox) => {
          void deleteFolderById(mailbox.id, mailbox.displayName);
        }}
        onFolderDialogKeyDown={folderDialogKeyDown}
        onFolderNameChange={setFolderName}
        onFolderDialogSubmit={() => void submitFolderDialog()}
        onFolderDialogClose={closeFolderDialog}
        onOpenFolderDialog={openFolderDialog}
        activeMailbox={activeMailbox}
        onEmptyTrash={() => void emptyTrashFolders()}
        onEmptyJunk={() => void emptyJunkFolders()}
        onDropMessages={(mailboxId, payload) => {
          void dropMessages(mailboxId, payload);
        }}
      />

      <PaneSplitter
        className="folder-splitter"
        label={strings.mail.resizeFolders}
        controls="folder-pane message-pane"
        orientation="vertical"
        value={settings.folderPaneWidth}
        min={210}
        max={420}
        onChange={(value, persist) =>
          resizePane("folderPaneWidth", value, persist)
        }
      />

      <section
        className={`message-pane${selecting ? " selecting" : ""}`}
        id="message-pane"
        aria-label={heading}
        data-list={activeLocalView ? "local" : undefined}
      >
        <MessagePaneHeader
          heading={heading}
          accountLabel={accountLabel || undefined}
          shownCount={shownCount}
          folderTotal={
            !activeLocalView && !submittedQuery && listFilter === "all"
              ? activeMailbox?.totalCount
              : undefined
          }
          unreadCount={
            !activeLocalView && !submittedQuery && listFilter === "all"
              ? activeMailbox?.unreadCount
              : undefined
          }
          activeLocalView={activeLocalView}
          query={query}
          submittedQuery={submittedQuery}
          selecting={selecting}
          bulkBusy={bulkBusy}
          mailboxMoreOpen={mailboxMoreOpen}
          mailboxMoreRef={mailboxMoreRef}
          onToggleSelecting={() => {
            selectionAnchor.current = undefined;
            setSelecting((value) => !value);
            setSelectedIds([]);
            setSelectionSnoozeOpen(false);
          }}
          onOpenMore={setMailboxMoreOpen}
          onMarkAllRead={() => {
            closeMailboxMore();
            void markAllRead();
          }}
          onExpandConversations={
            canFoldConversations
              ? () => {
                  closeMailboxMore();
                  window.dispatchEvent(
                    new Event("postal:expand-conversations"),
                  );
                }
              : undefined
          }
          onCollapseConversations={
            canFoldConversations
              ? () => {
                  closeMailboxMore();
                  window.dispatchEvent(
                    new Event("postal:collapse-conversations"),
                  );
                }
              : undefined
          }
          onGoToInbox={() => openRoleMailbox("inbox")}
          goToInboxDisabled={roleMailboxOpen("inbox")}
          onGoToSent={() => openRoleMailbox("sent")}
          goToSentDisabled={roleMailboxOpen("sent")}
          onNextUnread={() => {
            closeMailboxMore();
            const next = unreadStep(
              listedMessages,
              settings.groupThreads && listSort === "date",
              selectedMessage?.id,
              1,
            );
            if (next) void chooseMessage(next);
          }}
          nextUnreadDisabled={
            !listedMessages.some((message) => !message.isRead)
          }
          onNextUnreadMailbox={() => {
            closeMailboxMore();
            const next = nextUnreadMailbox(mailboxes, activeMailboxId);
            if (!next) {
              setError(strings.mail.noOtherUnreadMailbox);
              return;
            }
            selectMailbox(next.id);
          }}
          nextUnreadMailboxDisabled={
            !nextUnreadMailbox(mailboxes, activeMailboxId)
          }
          onPreviousUnreadMailbox={() => {
            closeMailboxMore();
            const previous = previousUnreadMailbox(mailboxes, activeMailboxId);
            if (!previous) {
              setError(strings.mail.noOtherUnreadMailbox);
              return;
            }
            selectMailbox(previous.id);
          }}
          previousUnreadMailboxDisabled={
            !previousUnreadMailbox(mailboxes, activeMailboxId)
          }
          listFilter={listFilter}
          onListFilter={(filter) => {
            setPendingFilter(filter);
            if (!activeAccountId || activeMailboxId == null) return;
            void updateSettings({
              mailboxViews: rememberMailboxView(
                useAppStore.getState().settings.mailboxViews,
                activeAccountId,
                activeMailboxId,
                listSort,
                filter,
              ),
            });
          }}
          listSort={listSort}
          onListSort={(sort) => {
            closeMailboxMore();
            setPendingSort(sort);
            useAppStore.setState({ mailboxSort: sort });
            if (!activeAccountId || activeMailboxId == null) return;
            void updateSettings({
              mailboxViews: rememberMailboxView(
                useAppStore.getState().settings.mailboxViews,
                activeAccountId,
                activeMailboxId,
                sort,
                listFilter,
              ),
            });
          }}
          selection={{
            count: selectedIds.length,
            mailboxRole: activeMailbox?.role,
            onSelectAll: () => {
              closeMailboxMore();
              const ids = listedMessages.map((message) => message.id);
              selectionAnchor.current = ids[0];
              if (ids.length > 200) {
                setError(strings.mail.bulkTooMany);
                setSelectedIds(ids.slice(0, 200));
                return;
              }
              setSelectedIds(ids);
            },
            onSelectUnread: () => {
              closeMailboxMore();
              const ids = listedMessages
                .filter((message) => !message.isRead)
                .map((message) => message.id);
              if (ids.length === 0) return;
              selectionAnchor.current = ids[0];
              if (ids.length > 200) {
                setError(strings.mail.bulkTooMany);
                setSelectedIds(ids.slice(0, 200));
                return;
              }
              setSelectedIds(ids);
            },
            selectUnreadDisabled: !listedMessages.some(
              (message) => !message.isRead,
            ),
            onMarkRead: () => {
              closeMailboxMore();
              void bulkFlags(true, undefined);
            },
            onMarkUnread: () => {
              closeMailboxMore();
              void bulkFlags(false, undefined);
            },
            onStar: () => {
              closeMailboxMore();
              void bulkFlags(undefined, true);
            },
            onUnstar: () => {
              closeMailboxMore();
              void bulkFlags(undefined, false);
            },
            onPin: () => {
              closeMailboxMore();
              void pinSelection(true);
            },
            onUnpin: () => {
              closeMailboxMore();
              void pinSelection(false);
            },
            pinDisabled: !messages.some(
              (message) => selectedIds.includes(message.id) && !message.pinned,
            ),
            unpinDisabled: !messages.some(
              (message) => selectedIds.includes(message.id) && message.pinned,
            ),
            onJunk: () => {
              closeMailboxMore();
              void bulkMove("junk");
            },
            onNotJunk: () => {
              closeMailboxMore();
              void bulkMove("inbox");
            },
            moveDestinations: mailboxes
              .filter(
                (mailbox) =>
                  mailbox.accountId === activeAccountId &&
                  mailbox.id !== activeMailbox?.id &&
                  mailbox.role !== "archive" &&
                  mailbox.role !== "junk" &&
                  mailbox.role !== "trash",
              )
              .map((mailbox) => ({
                id: mailbox.id,
                name: folderPathLabel(mailbox),
                role: mailbox.role,
              })),
            onMoveTo: (mailboxId) => {
              closeMailboxMore();
              void bulkMoveTo(mailboxId);
            },
            onCopyTo: (mailboxId) => {
              closeMailboxMore();
              void bulkCopyTo(mailboxId);
            },
            onSnooze: () => {
              closeMailboxMore();
              setSelectionSnoozeOpen(true);
            },
            onSaveFiles: () => {
              closeMailboxMore();
              if (!activeAccountId) return;
              void saveSelectedFiles(activeAccountId, selectedIds);
            },
            onSaveMessages: () => {
              closeMailboxMore();
              if (!activeAccountId) return;
              void saveSelectedMessages(activeAccountId, selectedIds);
            },
            saveFilesDisabled: !messages.some(
              (message) =>
                selectedIds.includes(message.id) && message.hasAttachments,
            ),
            onPrint: () => {
              closeMailboxMore();
              if (!activeAccountId) return;
              void printSelectedMessages(activeAccountId, selectedIds);
            },
            onCopyText: () => {
              closeMailboxMore();
              if (!activeAccountId) return;
              void copySelectedMessageText(activeAccountId, selectedIds);
            },
            onForward: () => {
              closeMailboxMore();
              if (!activeAccountId) return;
              void forwardSelectedMessages(activeAccountId, selectedIds);
            },
          }}
          onClearSearch={() => {
            messageRequest.current += 1;
            searchRequest.current += 1;
            clearQuery();
            void loadMessages();
          }}
        />
        {selecting && !activeLocalView ? (
          <BulkBar
            selectedCount={selectedIds.length}
            busy={bulkBusy}
            onArchive={() =>
              void (activeMailbox?.role === "archive"
                ? bulkMove("inbox")
                : bulkMove("archive"))
            }
            archiveLabel={
              activeMailbox?.role === "archive"
                ? strings.reader.moveToInbox
                : undefined
            }
            onTrash={() =>
              void (activeMailbox?.role === "trash"
                ? deleteSelectedTrash()
                : bulkMove("trash"))
            }
            trashLabel={
              activeMailbox?.role === "trash"
                ? strings.mail.deleteForever
                : undefined
            }
          />
        ) : null}
        {selectionSnoozeOpen && selecting && !activeLocalView ? (
          <SnoozePanel
            label={strings.mail.snoozeSelected}
            onSnooze={(untilIso) => void snoozeSelection(untilIso)}
            onClose={() => setSelectionSnoozeOpen(false)}
          />
        ) : null}
        {activeLocalView === "drafts" ? (
          <DraftList
            drafts={drafts.filter((draft) =>
              matchesLocalQuery(
                `${draft.subject} ${draft.recipients} ${draft.preview ?? ""} ${draft.fromAddress ?? ""} ${
                  draft.sourceKind === "forward"
                    ? strings.mail.draftForward
                    : draft.sourceKind === "redirect"
                      ? strings.mail.draftRedirect
                      : draft.sourceKind === "reply" ||
                          draft.sourceKind === "reply_all"
                        ? strings.mail.draftReply
                        : ""
                }`,
                query,
              ),
            )}
            accountEmail={
              accounts.find((account) => account.id === activeAccountId)
                ?.email ?? ""
            }
            emptyLabel={
              query.trim() && drafts.length > 0
                ? strings.mail.noDraftMatch
                : undefined
            }
            onOpen={openDraft}
          />
        ) : activeLocalView === "snoozed" ? (
          <SnoozedList
            items={snoozed.filter((item) =>
              matchesLocalQuery(
                `${item.message.subject} ${item.message.senderName} ${item.message.senderAddress}`,
                query,
              ),
            )}
            emptyLabel={
              query.trim() && snoozed.length > 0
                ? strings.mail.noSnoozedMatch
                : undefined
            }
            onOpen={chooseSnoozed}
            onUnsnooze={unsnoozeById}
          />
        ) : activeLocalView === "outbox" ? (
          <OutboxList
            items={outbox.filter((item) =>
              matchesLocalQuery(
                `${item.subject} ${item.recipients} ${item.preview ?? ""} ${outboxDetail(item) ?? ""}`,
                query,
              ),
            )}
            emptyLabel={
              query.trim() && outbox.length > 0
                ? strings.mail.noOutboxMatch
                : undefined
            }
            sendingIds={scheduledSendInFlight}
            onOpen={previewQueued}
            onRetry={retryQueued}
            onRetryAll={retryAllQueued}
            onRetryCopy={retrySentCopy}
            onRetryArchive={retryArchiveAfterSend}
            onSendNow={sendScheduledNow}
            onEdit={editQueued}
            onDiscard={discardQueued}
          />
        ) : (
          <MessageList
            key={`${activeAccountId}:${activeMailboxId ?? ""}:${activeLocalView ?? ""}:${submittedQuery}:${listFilter}:${listSort}`}
            scrollKey={`${activeAccountId}:${activeMailboxId ?? ""}:${activeLocalView ?? ""}:${submittedQuery}:${listFilter}:${listSort}`}
            messages={listedMessages}
            chronological={listSort === "date" || listSort === "dateOldest"}
            oldestFirst={listSort === "dateOldest"}
            emptyLabel={
              listFilter === "unread"
                ? strings.mail.noUnread
                : listFilter === "starred"
                  ? strings.mail.noStarred
                  : listFilter === "attachments"
                    ? strings.mail.noAttachments
                    : listFilter === "pinned"
                      ? strings.mail.noPinned
                      : listFilter === "toMe"
                        ? strings.mail.noToMe
                        : listFilter === "invitations"
                          ? strings.mail.noInvitations
                          : undefined
            }
            selectedId={selectedMessage?.id}
            loading={loadingMessages}
            loadingMessageId={loadingMessageId}
            onChoose={async (summary) => {
              await chooseMessage(summary);
            }}
            hasMore={hasMoreMessages || canDownloadOlder}
            onLoadMore={loadMoreMessages}
            loadMoreLabel={
              hasMoreMessages ? undefined : strings.mail.loadOlderFromServer
            }
            searchQuery={submittedQuery}
            showFolders={Boolean(submittedQuery) && allFolders}
            selecting={selecting}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelectMessage}
            onCheckFocused={toggleSelectIds}
            onArchiveFocused={archiveFocused}
            onTrashFocused={trashFocused}
            onJunkFocused={junkFocused}
            onReplyFocused={(message, mode) => {
              void replyFocused(message, mode);
            }}
            onSelectDay={(ids) => {
              if (ids.length === 0) return;
              selectionAnchor.current = ids[0];
              setSelecting(true);
              if (ids.length > 200) {
                setError(strings.mail.bulkTooMany);
                setSelectedIds(ids.slice(0, 200));
                return;
              }
              setSelectedIds(ids);
            }}
            onRangeSelect={selectMessageRange}
            onToggleStar={(message) => {
              void toggleListedStar(message.id);
            }}
            onToggleConversationStar={(message, starred) => {
              void starLoadedConversation(message, starred);
            }}
            onToggleRead={(message) => {
              void toggleListedRead(message.id);
            }}
            onToggleConversationRead={(message, isRead) => {
              void (isRead
                ? markLoadedConversationRead(message)
                : markLoadedConversationUnread(message));
            }}
            onClearSearch={() => {
              clearQuery();
              void loadMessages();
            }}
            onSearchAllFolders={
              submittedQuery && !allFolders
                ? () => {
                    allFoldersRef.current = true;
                    setAllFolders(true);
                    void runSearch();
                  }
                : undefined
            }
          />
        )}
      </section>

      {settings.readingPane === "right" ? (
        <PaneSplitter
          className="reader-splitter"
          label={strings.mail.resizeMessages}
          controls="message-pane reader-pane"
          orientation="vertical"
          value={settings.messagePaneWidth}
          min={300}
          max={720}
          onChange={(value, persist) =>
            resizePane("messagePaneWidth", value, persist)
          }
        />
      ) : settings.readingPane === "bottom" ? (
        <PaneSplitter
          className="reader-bottom-splitter"
          label={strings.mail.resizeReader}
          controls="message-pane reader-pane"
          orientation="horizontal-reverse"
          value={settings.readerPaneHeight}
          min={240}
          max={800}
          onChange={(value, persist) =>
            resizePane("readerPaneHeight", value, persist)
          }
        />
      ) : null}

      <ErrorBoundary
        className="reader-pane crash-recovery"
        id="reader-pane"
        help={strings.app.readerCrashHelp}
        resetKey={selectedMessage?.id}
      >
        <MessageReader
          onSnoozed={handleSnoozedMessage}
          onConversationSnoozed={handleConversationSnoozed}
          onPrevious={
            relativeMessage(-1)
              ? () => {
                  const previous = relativeMessage(-1);
                  if (previous) void chooseMessage(previous);
                }
              : undefined
          }
          onNext={
            relativeMessage(1)
              ? () => {
                  const next = relativeMessage(1);
                  if (next) void chooseMessage(next);
                }
              : undefined
          }
          onOlderInConversation={
            selectedMessage &&
            conversationNeighbor(messages, selectedMessage, 1)
              ? () => {
                  const current = useAppStore.getState().selectedMessage;
                  const older = current
                    ? conversationNeighbor(
                        useAppStore.getState().messages,
                        current,
                        1,
                      )
                    : undefined;
                  if (older) void chooseMessage(older);
                }
              : undefined
          }
          searchQuery={submittedQuery}
          onNewerInConversation={
            selectedMessage &&
            conversationNeighbor(messages, selectedMessage, -1)
              ? () => {
                  const current = useAppStore.getState().selectedMessage;
                  const newer = current
                    ? conversationNeighbor(
                        useAppStore.getState().messages,
                        current,
                        -1,
                      )
                    : undefined;
                  if (newer) void chooseMessage(newer);
                }
              : undefined
          }
          onOpenInConversation={(item) => {
            void chooseMessage(item);
          }}
          onUnreadInConversation={
            selectedMessage &&
            conversationUnreadTarget(messages, selectedMessage)
              ? () => {
                  const current = useAppStore.getState().selectedMessage;
                  const unread = current
                    ? conversationUnreadTarget(
                        useAppStore.getState().messages,
                        current,
                      )
                    : undefined;
                  if (unread) void chooseMessage(unread);
                }
              : undefined
          }
          onShowInFolder={
            selectedMessage &&
            (submittedQuery ||
              activeLocalView ||
              selectedMessage.mailboxId !== activeMailboxId)
              ? showMessageFolder
              : undefined
          }
          onContinueDraft={(id) => void continueDraft(id)}
          onMessagesFromSender={searchFromSender}
          onMessagesWithSubject={searchSubject}
        />
      </ErrorBoundary>
      <SentNoticeToast />
      {outboxPreview ? (
        <OutboxPreviewDialog
          draft={outboxPreview}
          onClose={() => setOutboxPreview(null)}
        />
      ) : null}
      {movingFolder ? (
        <MoveFolderDialog
          mailbox={movingFolder}
          mailboxes={mailboxes}
          busy={folderBusy}
          onMove={(parentId) => void submitMoveFolder(parentId)}
          onClose={() => setMoveFolderId(null)}
        />
      ) : null}
      {addAccountOpen ? (
        <AddAccountDialog
          onClose={() => setAddAccountOpen(false)}
          onComplete={async () => {
            try {
              const previousIds = new Set(
                accounts.map((account) => account.id),
              );
              const loaded = await api.listAccounts();
              setAccounts(loaded);
              const added = loaded.find(
                (account) => !previousIds.has(account.id),
              );
              if (added) selectAccount(added.id);
            } catch {
              // The account is already saved; listing is best-effort.
            }
            setAddAccountOpen(false);
          }}
        />
      ) : null}
    </main>
  );
}
