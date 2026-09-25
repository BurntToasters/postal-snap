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
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useMailShortcuts } from "../hooks/useMailShortcuts";
import { useScheduledOutbox } from "../hooks/useScheduledOutbox";
import { api } from "../api";
import {
  CONTEXT_ACTION_EVENT,
  type ContextMenuActionDetail,
} from "../contextMenu";
import { strings } from "../i18n";
import { folderLabel } from "../i18n/mail";
import { useAppStore } from "../store";
import type { AccountInboxCount, MessageSummary } from "../types";
import { applyPendingUpdate } from "../update";
import { MessageReader } from "./MessageReader";
import { AddAccountDialog, SentNoticeToast } from "./mail/mailDialogs";
import { Sidebar } from "./mail/sidebar";
import { DraftList, OutboxList, SnoozedList } from "./mail/localLists";
import {
  isOversizeError,
  matchesLocalQuery,
  mergeSearchResults,
} from "./mail/mailSearch";
import { folderIcons } from "./mail/folderIcons";
import { MessageList } from "./mail/messageList";
import { MailToolbar } from "./mail/mailToolbar";
import { BulkBar, MessagePaneHeader } from "./mail/messagePaneChrome";
import { PaneSplitter } from "./mail/paneSplitter";

import { MEDIA_QUERIES } from "../breakpoints";

interface Props {
  onOpenSettings: (tab?: "accounts") => void;
}

function relativeMessage(delta: number): MessageSummary | undefined {
  const state = useAppStore.getState();
  const items = state.messages;
  if (items.length === 0) return undefined;
  const currentId = state.selectedMessage?.id;
  const index = items.findIndex((item) => item.id === currentId);
  const nextIndex =
    index === -1
      ? delta > 0
        ? 0
        : items.length - 1
      : Math.max(0, Math.min(items.length - 1, index + delta));
  const next = items[nextIndex];
  if (!next || next.id === currentId) return undefined;
  return next;
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
  const messageCursor = useAppStore((state) => state.messageCursor);
  const hasMoreMessages = useAppStore((state) => state.hasMoreMessages);
  const setMessages = useAppStore((state) => state.setMessages);
  const appendMessages = useAppStore((state) => state.appendMessages);
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
  const sync = useAppStore((state) =>
    activeAccountId ? state.sync[activeAccountId] : undefined,
  );
  const syncByAccount = useAppStore((state) => state.sync);
  const updateReady = useAppStore((state) => state.updateReady);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [allFolders, setAllFolders] = useState(false);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [accountSwitcherOpen, setAccountSwitcherOpen] = useState(false);
  const [accountCounts, setAccountCounts] = useState<AccountInboxCount[]>([]);
  const [syncingAllAccounts, setSyncingAllAccounts] = useState(false);
  const [syncingAccountIds, setSyncingAccountIds] = useState<Set<string>>(
    () => new Set(),
  );
  const syncingAccountIdsRef = useRef(new Set<string>());
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
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingMessageId, setLoadingMessageId] = useState<number>();
  const [folderDialog, setFolderDialog] = useState<
    null | { mode: "create" } | { mode: "rename"; id: number; name: string }
  >(null);
  const [folderName, setFolderName] = useState("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [mailboxMoreOpen, setMailboxMoreOpen] = useState(false);
  const mailboxMoreRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLElement>(null);
  const newFolderButtonRef = useRef<HTMLButtonElement>(null);
  const lastFolderInvoker = useRef<HTMLElement | null>(null);

  const sidebarVisible = settings.sidebarVisible !== false;

  useEffect(() => {
    if (!mailboxMoreOpen) return;
    const menu = mailboxMoreRef.current;
    const trigger = menu?.querySelector<HTMLButtonElement>(
      "button[aria-haspopup='menu']",
    );
    menu
      ?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")
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
    const next = {
      ...useAppStore.getState().settings,
      sidebarVisible: !sidebarVisible,
    };
    setSettings(next);
    void api
      .saveSettings(next)
      .then(setSettings)
      .catch((cause) => setError(String(cause)));
  }

  function openFolderDialog(
    dialog: { mode: "create" } | { mode: "rename"; id: number; name: string },
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
  const detailRequest = useRef(0);
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
    setSelectedIds([]);
    setSelecting(false);
  }

  function clearQuery() {
    queryRef.current = "";
    submittedQueryRef.current = "";
    setQuery("");
    setSubmittedQuery("");
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
    detailRequest.current += 1;
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

  async function refreshAllAccounts() {
    if (syncingAllAccounts) return;
    setSyncingAllAccounts(true);
    try {
      await api.syncAllAccounts();
      await Promise.all([loadAccountCounts(), loadAccountData()]);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSyncingAllAccounts(false);
    }
  }

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

  const loadMessages = useCallback(async () => {
    if (
      !activeAccountId ||
      !activeMailboxId ||
      activeLocalView ||
      submittedQueryRef.current
    ) {
      messageRequest.current += 1;
      setLoadingMessages(false);
      return;
    }
    const accountId = activeAccountId;
    const mailboxId = activeMailboxId;
    const request = ++messageRequest.current;
    pagingRequest.current += 1;
    searchRequest.current += 1;
    setLoadingMessages(true);
    try {
      const loaded = await api.listMessages(accountId, mailboxId);
      const current = useAppStore.getState();
      if (
        request !== messageRequest.current ||
        current.activeAccountId !== accountId ||
        current.activeMailboxId !== mailboxId ||
        current.activeLocalView
      )
        return;
      setMessages(loaded.items, loaded.nextCursor ?? undefined, loaded.hasMore);
    } catch (cause) {
      if (request === messageRequest.current) setError(String(cause));
    } finally {
      if (request === messageRequest.current) setLoadingMessages(false);
    }
  }, [
    activeAccountId,
    activeLocalView,
    activeMailboxId,
    setError,
    setMessages,
  ]);

  async function loadMoreMessages() {
    if (
      !activeAccountId ||
      !activeMailboxId ||
      activeLocalView ||
      !messageCursor ||
      loadingMessages
    )
      return;
    const accountId = activeAccountId;
    const mailboxId = activeMailboxId;
    const request = ++pagingRequest.current;
    setLoadingMessages(true);
    try {
      const page = await api.listMessages(accountId, mailboxId, messageCursor);
      const current = useAppStore.getState();
      if (
        request === pagingRequest.current &&
        current.activeAccountId === accountId &&
        current.activeMailboxId === mailboxId &&
        !current.activeLocalView &&
        !submittedQueryRef.current
      )
        appendMessages(page.items, page.nextCursor ?? undefined, page.hasMore);
    } catch (cause) {
      if (request === pagingRequest.current) setError(String(cause));
    } finally {
      if (request === pagingRequest.current) setLoadingMessages(false);
    }
  }

  function searchStillCurrent(
    request: number,
    accountId: string,
    mailboxId?: number,
    text?: string,
    searchAllFolders?: boolean,
  ) {
    const current = useAppStore.getState();
    return (
      request === searchRequest.current &&
      current.activeAccountId === accountId &&
      current.activeMailboxId === mailboxId &&
      !current.activeLocalView &&
      (text === undefined || queryRef.current.trim() === text) &&
      (searchAllFolders === undefined ||
        allFoldersRef.current === searchAllFolders)
    );
  }

  const runSearch = useCallback(async () => {
    if (!activeAccountId || activeLocalView) return;
    const text = queryRef.current.trim();
    const searchAllFolders = allFoldersRef.current;
    const request = ++searchRequest.current;
    messageRequest.current += 1;
    pagingRequest.current += 1;
    if (!text) {
      submittedQueryRef.current = "";
      setSubmittedQuery("");
      await loadMessages();
      return;
    }
    submittedQueryRef.current = text;
    setSubmittedQuery(text);
    const accountId = activeAccountId;
    const mailboxId = activeMailboxId;
    const search = {
      accountId,
      mailboxId,
      text,
      allFolders: searchAllFolders,
      limit: 250,
    };
    setLoadingMessages(true);
    try {
      const cached = await api.searchCached(search);
      if (
        searchStillCurrent(
          request,
          accountId,
          mailboxId,
          search.text,
          search.allFolders,
        )
      )
        setMessages(cached, undefined, false);
      const server = await api.searchServer(search);
      if (
        searchStillCurrent(
          request,
          accountId,
          mailboxId,
          search.text,
          search.allFolders,
        )
      )
        setMessages(mergeSearchResults(cached, server), undefined, false);
    } catch (cause) {
      if (
        searchStillCurrent(
          request,
          accountId,
          mailboxId,
          search.text,
          search.allFolders,
        )
      )
        setError(strings.mail.partialSearch(String(cause)));
    } finally {
      if (request === searchRequest.current) setLoadingMessages(false);
    }
  }, [
    activeAccountId,
    activeLocalView,
    activeMailboxId,
    loadMessages,
    setError,
    setMessages,
  ]);

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
        await api.createFolder(activeAccountId, name);
      }
      closeFolderDialog();
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

  function toggleSelectMessage(id: number) {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((item) => item !== id);
      if (prev.length >= 200) {
        setError(strings.mail.bulkTooMany);
        return prev;
      }
      return [...prev, id];
    });
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
    setBulkBusy(true);
    try {
      const outcome = await api.moveMessagesToMailbox(
        activeAccountId,
        selectedIds,
        destination.id,
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

  async function markAllRead() {
    if (!activeAccountId || !activeMailboxId || bulkBusy) return;
    setBulkBusy(true);
    try {
      const outcome = await api.markMailboxRead(
        activeAccountId,
        activeMailboxId,
      );
      if (outcome.failed > 0)
        setError(strings.mail.bulkPartial(outcome.failed));
      await refreshList();
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBulkBusy(false);
    }
  }

  const chooseMessage = useCallback(
    async (summary: MessageSummary) => {
      const accountId = activeAccountId;
      const mailboxId = activeMailboxId;
      if (!accountId || !mailboxId) return false;
      const request = ++detailRequest.current;
      setLoadingMessageId(summary.id);
      try {
        const detail = await api.getMessage(accountId, summary.id);
        const current = useAppStore.getState();
        if (
          request !== detailRequest.current ||
          current.activeAccountId !== accountId ||
          current.activeMailboxId !== mailboxId
        )
          return false;
        selectMessage(detail);
        if (!summary.isRead) {
          await api.setMessageFlags(accountId, summary.id, true, undefined);
          const latest = useAppStore.getState();
          if (
            request === detailRequest.current &&
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
        if (request !== detailRequest.current) return false;
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
        if (request === detailRequest.current) setLoadingMessageId(undefined);
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

  useEffect(() => {
    let active = true;
    const unsubs: Array<() => void> = [];
    void api
      .onFolderCountsChanged(({ accountId }) => {
        void loadAccountCounts();
        if (accountId === useAppStore.getState().activeAccountId)
          void loadersRef.current.loadAccountData();
      })
      .then((fn) => {
        if (active) unsubs.push(fn);
        else fn();
      });
    void api
      .onMessageChanged(({ accountId, messageId, kind }) => {
        const store = useAppStore.getState();
        if (accountId !== store.activeAccountId) return;
        if (submittedQueryRef.current) void loadersRef.current.runSearch();
        else void loadersRef.current.loadMessages();
        if (
          messageId &&
          store.selectedMessage?.id === messageId &&
          kind === "moved"
        ) {
          store.selectMessage(undefined);
        }
      })
      .then((fn) => {
        if (active) unsubs.push(fn);
        else fn();
      });
    void api
      .onDraftSyncChanged(({ accountId }) => {
        if (accountId === useAppStore.getState().activeAccountId)
          void loadersRef.current.loadAccountData();
      })
      .then((fn) => {
        if (active) unsubs.push(fn);
        else fn();
      });
    void api
      .onOutboxChanged(({ accountId }) => {
        if (accountId === useAppStore.getState().activeAccountId)
          void loadersRef.current.loadAccountData();
      })
      .then((fn) => {
        if (active) unsubs.push(fn);
        else fn();
      });
    void api
      .onOfflineOperationsDropped(({ accountId }) => {
        if (accountId !== useAppStore.getState().activeAccountId) return;
        setError(strings.mail.offlineChangesDropped);
        void loadersRef.current.loadAccountData();
      })
      .then((fn) => {
        if (active) unsubs.push(fn);
        else fn();
      });
    const refreshLocal = (event: Event) => {
      const accountId = (event as CustomEvent<string>).detail;
      if (accountId === useAppStore.getState().activeAccountId)
        void loadersRef.current.loadAccountData();
    };
    window.addEventListener("postal:local-mail-changed", refreshLocal);
    return () => {
      active = false;
      unsubs.forEach((fn) => fn());
      window.removeEventListener("postal:local-mail-changed", refreshLocal);
    };
  }, [loadAccountCounts, setError]);

  useMailShortcuts({
    accounts,
    selectAccount,
    setAccountSwitcherOpen,
    openComposer,
    refresh,
    onOpenSettings,
    settings,
    setSettings,
    setError,
    searchInput,
    chooseMessage,
    relativeMessage,
  });

  useEffect(() => {
    if (!activeAccountId) return;
    if (
      settings.lastAccountId === activeAccountId &&
      settings.lastMailboxId === (activeMailboxId ?? null)
    )
      return;
    const timer = window.setTimeout(() => {
      const next = {
        ...useAppStore.getState().settings,
        lastAccountId: activeAccountId,
        lastMailboxId: activeMailboxId ?? null,
      };
      void api
        .saveSettings(next)
        .then(setSettings)
        .catch((cause) => setError(String(cause)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [activeAccountId, activeMailboxId, setError, setSettings, settings]);

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
    setSettings(next);
    if (persist)
      void api
        .saveSettings(next)
        .then(setSettings)
        .catch((cause) => {
          setSettings(previous);
          setError(String(cause));
        });
  }

  async function openDraft(id: string) {
    if (!activeAccountId) return;
    const accountId = activeAccountId;
    try {
      const draft = await api.getDraft(id, accountId);
      const current = useAppStore.getState();
      if (
        current.activeAccountId !== accountId ||
        current.activeLocalView !== "drafts"
      )
        return;
      openComposer({
        draft,
        draftSummary: current.drafts.find((draft) => draft.id === id),
      });
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function retryQueued(id: string) {
    if (!activeAccountId) return;
    const confirmed = await api.showNativeConfirm(
      strings.mail.retrySending,
      strings.mail.retryWarning,
    );
    if (!confirmed) return;
    try {
      await api.retryOutbox(id, activeAccountId);
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
      await loadAccountData();
    }
  }

  async function retrySentCopy(id: string) {
    if (!activeAccountId) return;
    try {
      await api.retrySentCopy(id, activeAccountId);
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
      await loadAccountData();
    }
  }

  async function unsnoozeById(id: number) {
    if (!activeAccountId) return;
    try {
      await api.unsnoozeMessage(activeAccountId, id);
      await loadAccountData();
      await refreshList();
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function handleSnoozedMessage(accountId: string, messageId: number) {
    const current = useAppStore.getState();
    if (current.activeAccountId !== accountId) return;
    if (
      current.selectedMessage?.id === messageId &&
      current.selectedMessage.accountId === accountId
    ) {
      selectMessage(undefined);
    }
    await loadAccountData();
    await refreshList();
  }

  const chooseSnoozed = useCallback(
    async (summary: MessageSummary) => {
      const accountId = activeAccountId;
      if (!accountId) return;
      const request = ++detailRequest.current;
      setLoadingMessageId(summary.id);
      try {
        const detail = await api.getMessage(accountId, summary.id);
        const current = useAppStore.getState();
        if (
          request !== detailRequest.current ||
          current.activeAccountId !== accountId ||
          current.activeLocalView !== "snoozed"
        )
          return;
        selectMessage(detail);
        if (!summary.isRead) {
          await api.setMessageFlags(accountId, summary.id, true, undefined);
          await loadAccountData();
        }
      } catch (cause) {
        if (request !== detailRequest.current) return;
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
        if (request === detailRequest.current) setLoadingMessageId(undefined);
      }
    },
    [
      activeAccountId,
      loadAccountData,
      selectMessage,
      setError,
      setLoadingMessageId,
    ],
  );

  async function discardQueued(
    id: string,
    state: ReturnType<typeof useAppStore.getState>["outbox"][number]["state"],
  ) {
    if (!activeAccountId) return;
    const question =
      state === "sent_copy_pending"
        ? strings.mail.dismissSentCopy
        : state === "scheduled"
          ? strings.mail.undoSendQuestion
          : strings.mail.discardQueued;
    const confirmed = await api.showNativeConfirm(
      strings.composer.discard,
      question,
    );
    if (!confirmed) return;
    try {
      if (state === "scheduled") {
        const draft = await api.restoreOutbox(id, activeAccountId);
        openComposer({ draft });
      } else {
        await api.deleteOutbox(id, activeAccountId);
      }
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
    }
  }

  useEffect(() => {
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent<ContextMenuActionDetail>).detail;
      if (!detail) return;
      const { id, target } = detail;
      const current = useAppStore.getState();
      if (target.kind === "account") {
        if (
          !current.accounts.some((account) => account.id === target.accountId)
        )
          return;
        if (id === "get-mail") void refreshAccount(target.accountId);
        if (id === "account-settings") {
          selectAccount(target.accountId);
          onOpenSettings("accounts");
        }
        return;
      }
      if (target.kind === "message") {
        const summary = current.messages.find(
          (row) => row.id === target.messageId,
        );
        if (!summary) return;
        void (async () => {
          const opened = await chooseMessage(summary);
          if (!opened) return;
          if (id === "toggle-read" && !summary.isRead) return;
          if (id === "snooze") {
            window.dispatchEvent(new Event("postal:open-snooze"));
            return;
          }
          if (id.startsWith("move-mailbox:")) {
            window.dispatchEvent(
              new CustomEvent("postal:move-mailbox", {
                detail: Number(id.slice("move-mailbox:".length)),
              }),
            );
            return;
          }
          window.dispatchEvent(
            new CustomEvent("postal:menu-action", { detail: id }),
          );
        })();
        return;
      }
      if (target.kind === "folder") {
        const mailbox = current.mailboxes.find(
          (box) => box.id === target.mailboxId,
        );
        if (!mailbox) return;
        if (id === "open") {
          const sameMailbox =
            mailbox.id === current.activeMailboxId && !current.activeLocalView;
          if (!sameMailbox) messageRequest.current += 1;
          searchRequest.current += 1;
          clearQuery();
          resetListState();
          selectMailbox(mailbox.id);
          setSidebarOpen(false);
          if (sameMailbox) void loadMessages();
          return;
        }
        if (id === "empty-trash") {
          void emptyTrashFolders();
          return;
        }
        if (id === "empty-junk") {
          void emptyJunkFolders();
          return;
        }
        if (id === "rename-folder") {
          openFolderDialog({
            mode: "rename",
            id: mailbox.id,
            name: mailbox.displayName,
          });
          return;
        }
        if (id === "delete-folder") {
          void deleteFolderById(mailbox.id, mailbox.displayName);
        }
        return;
      }
      if (target.kind === "local-nav" && id === "open") {
        messageRequest.current += 1;
        searchRequest.current += 1;
        clearQuery();
        resetListState();
        selectLocalView(target.view);
        setSidebarOpen(false);
        return;
      }
      if (target.kind === "draft" && id === "open") {
        void openDraft(target.draftId);
        return;
      }
      if (target.kind === "outbox") {
        const row = current.outbox.find(
          (entry) => entry.id === target.outboxId,
        );
        if (!row) return;
        if (id === "retry") void retryQueued(row.id);
        if (id === "retry-copy") void retrySentCopy(row.id);
        if (id === "send-now") void sendScheduledNow(row.id);
        if (id === "discard") {
          if (row.state === "sending") return;
          if (scheduledSendInFlight?.has(`${row.accountId}:${row.id}`)) return;
          void discardQueued(row.id, row.state);
        }
        return;
      }
      if (target.kind === "snoozed") {
        const row = current.snoozed.find(
          (entry) => entry.message.id === target.messageId,
        );
        if (!row) return;
        if (id === "open") void chooseSnoozed(row.message);
        if (id === "unsnooze") void unsnoozeById(row.message.id);
      }
    };
    window.addEventListener(CONTEXT_ACTION_EVENT, onAction);
    return () => window.removeEventListener(CONTEXT_ACTION_EVENT, onAction);
  });

  useEffect(() => {
    if (!sidebarOpen) return;
    const pane = folderPaneRef.current;
    const toggle = sidebarToggleRef.current;
    const previous = document.activeElement as HTMLElement | null;
    const firstFocusable = pane?.querySelector<HTMLElement>(
      "button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
    );
    window.setTimeout(() => firstFocusable?.focus(), 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (previous && document.contains(previous)) previous.focus();
      else toggle?.focus();
    };
  }, [sidebarOpen]);

  useEffect(() => {
    if (!sidebarOpen || !sidebarDrawerViewport) return;
    const shell = document.querySelector(".mail-shell");
    const inertTargets = shell
      ? [...shell.children].filter(
          (child) =>
            child !== folderPaneRef.current &&
            !child.classList.contains("sidebar-scrim") &&
            !child.classList.contains("folder-pane"),
        )
      : [];
    for (const target of inertTargets) {
      target.setAttribute("inert", "");
    }
    return () => {
      for (const target of inertTargets) {
        target.removeAttribute("inert");
      }
    };
  }, [sidebarDrawerViewport, sidebarOpen]);

  const narrowViewport = useMediaQuery(MEDIA_QUERIES.narrowViewport);
  const readerOverlay =
    Boolean(selectedMessage) &&
    (settings.readingPane === "hidden" || narrowViewport);

  useEffect(() => {
    if (!readerOverlay) return;
    const shell = document.querySelector(".mail-shell");
    if (!shell) return;
    const inertTargets = [...shell.children].filter(
      (child) => child.id !== "reader-pane",
    );
    for (const target of inertTargets) {
      target.setAttribute("inert", "");
    }
    return () => {
      for (const target of inertTargets) {
        target.removeAttribute("inert");
      }
    };
  }, [readerOverlay]);

  const activeMailbox = useMemo(
    () => mailboxes.find((box) => box.id === activeMailboxId),
    [activeMailboxId, mailboxes],
  );
  const activeAccount = useMemo(
    () => accounts.find((account) => account.id === activeAccountId),
    [activeAccountId, accounts],
  );
  const busy = activeAccountId ? syncingAccountIds.has(activeAccountId) : false;
  const heading = activeLocalView
    ? activeLocalView === "drafts"
      ? strings.mail.drafts
      : activeLocalView === "snoozed"
        ? strings.mail.snoozed
        : strings.mail.outbox
    : activeMailbox
      ? folderLabel(activeMailbox)
      : strings.mail.mail;
  const shownCount = activeLocalView
    ? activeLocalView === "drafts"
      ? drafts.length
      : activeLocalView === "snoozed"
        ? snoozed.length
        : outbox.length
    : messages.length;
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
        updateReady={updateReady}
        inputRef={searchInput}
        query={query}
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
            name: mailbox.displayName,
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

      <section className="message-pane" id="message-pane" aria-label={heading}>
        <MessagePaneHeader
          heading={heading}
          shownCount={shownCount}
          activeLocalView={activeLocalView}
          query={query}
          submittedQuery={submittedQuery}
          selecting={selecting}
          bulkBusy={bulkBusy}
          mailboxMoreOpen={mailboxMoreOpen}
          mailboxMoreRef={mailboxMoreRef}
          onToggleSelecting={() => {
            setSelecting((value) => !value);
            setSelectedIds([]);
          }}
          onOpenMore={setMailboxMoreOpen}
          onMarkAllRead={() => {
            setMailboxMoreOpen(false);
            mailboxMoreRef.current
              ?.querySelector<HTMLButtonElement>("button[aria-haspopup='menu']")
              ?.focus();
            void markAllRead();
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
            mailboxRole={activeMailbox?.role}
            onMarkRead={() => void bulkFlags(true, undefined)}
            onMarkUnread={() => void bulkFlags(false, undefined)}
            onArchive={() => void bulkMove("archive")}
            onNotJunk={() => void bulkMove("inbox")}
            onJunk={() => void bulkMove("junk")}
            onTrash={() => void bulkMove("trash")}
          />
        ) : null}
        {activeLocalView === "drafts" ? (
          <DraftList
            drafts={drafts.filter((draft) =>
              matchesLocalQuery(`${draft.subject} ${draft.recipients}`, query),
            )}
            onOpen={openDraft}
          />
        ) : activeLocalView === "snoozed" ? (
          <SnoozedList
            items={snoozed}
            onOpen={chooseSnoozed}
            onUnsnooze={unsnoozeById}
          />
        ) : activeLocalView === "outbox" ? (
          <OutboxList
            items={outbox.filter((item) =>
              matchesLocalQuery(`${item.subject} ${item.recipients}`, query),
            )}
            sendingIds={scheduledSendInFlight}
            onRetry={retryQueued}
            onRetryCopy={retrySentCopy}
            onSendNow={sendScheduledNow}
            onDiscard={discardQueued}
          />
        ) : (
          <MessageList
            key={`${activeAccountId}:${activeMailboxId ?? ""}:${activeLocalView ?? ""}:${submittedQuery}`}
            messages={messages}
            selectedId={selectedMessage?.id}
            loading={loadingMessages}
            loadingMessageId={loadingMessageId}
            onChoose={async (summary) => {
              await chooseMessage(summary);
            }}
            hasMore={hasMoreMessages}
            onLoadMore={loadMoreMessages}
            searchQuery={submittedQuery}
            selecting={selecting}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelectMessage}
            onClearSearch={() => {
              clearQuery();
              void loadMessages();
            }}
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

      <MessageReader onSnoozed={handleSnoozedMessage} />
      <SentNoticeToast />
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
