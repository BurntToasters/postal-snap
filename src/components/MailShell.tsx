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
import {
  Archive,
  ChevronDown,
  Clock,
  FileText,
  FolderPlus,
  Inbox,
  Mail,
  MailOpen,
  MailPlus,
  Menu,
  MoreHorizontal,
  PanelLeft,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { api } from "../api";
import { strings } from "../i18n";
import { applySettings } from "../settings";
import { useAppStore } from "../store";
import type { MailboxRole, MessageSummary, ReadingPane } from "../types";
import { promptToRestartForUpdate } from "../update";
import { MessageReader } from "./MessageReader";
import { AddAccountDialog, SentNoticeToast } from "./mail/mailDialogs";
import { FolderButton } from "./mail/folderButton";
import { DraftList, OutboxList, SnoozedList } from "./mail/localLists";
import {
  isOversizeError,
  matchesLocalQuery,
  mergeSearchResults,
} from "./mail/mailSearch";
import { MessageList } from "./mail/messageList";
import { PaneSplitter } from "./mail/paneSplitter";

const SIDEBAR_DRAWER_QUERY = "(max-width: 1049px)";

interface Props {
  onOpenSettings: () => void;
}

const folderIcons: Record<MailboxRole, typeof Inbox> = {
  inbox: Inbox,
  sent: Send,
  drafts: FileText,
  archive: Archive,
  trash: Trash2,
  junk: ShieldAlert,
  other: Menu,
};

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
  const setBusy = useAppStore((state) => state.setBusy);
  const busy = useAppStore((state) => state.busy);
  const setError = useAppStore((state) => state.setError);
  const sync = useAppStore((state) =>
    activeAccountId ? state.sync[activeAccountId] : undefined,
  );
  const updateReady = useAppStore((state) => state.updateReady);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [allFolders, setAllFolders] = useState(false);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarDrawerViewport, setSidebarDrawerViewport] = useState(() =>
    typeof window.matchMedia === "function"
      ? window.matchMedia(SIDEBAR_DRAWER_QUERY).matches
      : false,
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
  const scheduledOutboxInFlight = useRef(new Set<string>());
  const [scheduledSendInFlight, setScheduledSendInFlight] = useState<
    Set<string>
  >(() => new Set());
  const searchInput = useRef<HTMLInputElement>(null);
  const queryRef = useRef(query);
  const submittedQueryRef = useRef("");
  const allFoldersRef = useRef(allFolders);
  useEffect(() => {
    queryRef.current = query;
    allFoldersRef.current = allFolders;
  }, [allFolders, query]);

  const beginScheduledSend = useCallback((id: string, accountId: string) => {
    const key = `${accountId}:${id}`;
    if (scheduledOutboxInFlight.current.has(key)) return undefined;
    scheduledOutboxInFlight.current.add(key);
    setScheduledSendInFlight((previous) => new Set(previous).add(key));
    return api.sendScheduledOutbox(id, accountId).finally(() => {
      scheduledOutboxInFlight.current.delete(key);
      setScheduledSendInFlight((previous) => {
        if (!previous.has(key)) return previous;
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
    });
  }, []);

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

  const refresh = useCallback(async () => {
    if (!activeAccountId || busy) return;
    setBusy(true);
    try {
      await api.syncAccount(activeAccountId);
      await loadAccountData();
      if (submittedQueryRef.current) await runSearch();
      else await loadMessages();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [
    activeAccountId,
    busy,
    loadAccountData,
    loadMessages,
    runSearch,
    setBusy,
    setError,
  ]);

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
      if (!accountId || !mailboxId) return;
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
          return;
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
    const account = accounts.find((item) => item.id === activeAccountId);
    if (account?.syncState === "offline" || sync?.phase === "offline") return;
    const due = outbox
      .filter(
        (item) =>
          item.accountId === activeAccountId &&
          item.state === "scheduled" &&
          item.sendAt,
      )
      .map((item) => new Date(item.sendAt as string).getTime() - Date.now())
      .filter((ms) => Number.isFinite(ms));
    if (due.length === 0 || !activeAccountId) return;
    const wait = Math.min(...due);
    if (wait <= 0) {
      const overdue = outbox.find(
        (item) =>
          item.accountId === activeAccountId &&
          item.state === "scheduled" &&
          item.sendAt &&
          new Date(item.sendAt).getTime() <= Date.now(),
      );
      if (overdue && activeAccountId) {
        const id = overdue.id;
        const account = activeAccountId;
        const request = beginScheduledSend(id, account);
        if (request)
          void request
            .catch((cause) => setError(String(cause)))
            .finally(() => void loadAccountData());
      }
      return;
    }
    const timer = window.setTimeout(() => {
      const current = useAppStore.getState();
      const ready = current.outbox.find(
        (item) =>
          item.state === "scheduled" &&
          item.accountId === current.activeAccountId &&
          item.sendAt &&
          new Date(item.sendAt).getTime() <= Date.now(),
      );
      const livePhase = current.activeAccountId
        ? current.sync[current.activeAccountId]?.phase
        : undefined;
      if (
        ready &&
        current.activeAccountId &&
        livePhase !== "offline" &&
        current.accounts.find((item) => item.id === current.activeAccountId)
          ?.syncState !== "offline"
      ) {
        const request = beginScheduledSend(ready.id, current.activeAccountId);
        if (request)
          void request
            .catch((cause) => setError(String(cause)))
            .finally(() => void loadAccountData());
      } else {
        void loadAccountData();
      }
    }, wait);
    return () => window.clearTimeout(timer);
  }, [
    accounts,
    outbox,
    activeAccountId,
    sync,
    beginScheduledSend,
    loadAccountData,
    setError,
  ]);

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
  }, [setError]);

  useEffect(() => {
    const menuAction = (event: Event) => {
      const action = (event as CustomEvent<string>).detail;
      if (action === "compose") openComposer();
      if (action === "get-mail") void refresh();
      if (action === "settings") onOpenSettings();
      if (action === "text-larger" || action === "text-smaller") {
        const scales = [0.85, 1, 1.15, 1.3, 1.5, 2];
        const current = settings.textScale;
        let index = scales.findIndex((s) => Math.abs(s - current) < 0.05);
        if (index === -1) {
          index = scales.findIndex((s) => s >= current);
          if (index === -1) index = scales.length - 1;
        }
        const nextIndex =
          action === "text-larger"
            ? Math.min(scales.length - 1, index + 1)
            : Math.max(0, index - 1);
        const next = {
          ...settings,
          textScale: scales[nextIndex],
        };
        void api
          .saveSettings(next)
          .then((saved) => {
            setSettings(saved);
            applySettings(saved);
          })
          .catch((cause) => setError(String(cause)));
      }
      if (
        action === "reading-pane-right" ||
        action === "reading-pane-bottom" ||
        action === "reading-pane-hidden"
      ) {
        const readingPane: ReadingPane =
          action === "reading-pane-right"
            ? "right"
            : action === "reading-pane-bottom"
              ? "bottom"
              : "hidden";
        const next = { ...settings, readingPane };
        void api
          .saveSettings(next)
          .then((saved) => {
            setSettings(saved);
            applySettings(saved);
          })
          .catch((cause) => setError(String(cause)));
      }
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (document.querySelector(".modal-layer")) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const isEditing = Boolean(
        target?.matches(
          "input,textarea,select,[contenteditable='true'],[role='combobox'],[role='textbox']",
        ),
      );
      const onChromeControl = Boolean(
        target?.closest(
          "button, a, [role='menuitem'], .reader-actions, .format-toolbar, .settings-nav, .bulk-bar",
        ) && !target?.closest(".message-list"),
      );
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (mod && !event.shiftKey && key === "n") {
        event.preventDefault();
        openComposer();
        return;
      }
      if (
        (mod && event.shiftKey && key === "m") ||
        (mod && event.shiftKey && key === "n") ||
        event.key === "F5"
      ) {
        event.preventDefault();
        void refresh();
        return;
      }
      if (mod && !event.shiftKey && key === "r") {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("postal:menu-action", { detail: "reply" }),
        );
        return;
      }
      if (mod && event.shiftKey && key === "r") {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("postal:menu-action", { detail: "reply-all" }),
        );
        return;
      }
      if (mod && event.shiftKey && key === "f") {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("postal:menu-action", { detail: "forward" }),
        );
        return;
      }
      if (mod && !event.shiftKey && key === "e") {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("postal:menu-action", { detail: "archive" }),
        );
        return;
      }
      if (event.ctrlKey && event.metaKey && key === "a") {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("postal:menu-action", { detail: "archive" }),
        );
        return;
      }
      if (mod && event.shiftKey && key === "u") {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("postal:menu-action", { detail: "toggle-read" }),
        );
        return;
      }
      if (mod && event.shiftKey && key === "l") {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("postal:menu-action", { detail: "toggle-star" }),
        );
        return;
      }
      if (mod && event.altKey && key === "f") {
        event.preventDefault();
        window.dispatchEvent(new Event("postal:find-in-message"));
        return;
      }
      if (
        (event.key === "/" && !mod) ||
        (mod && !event.shiftKey && !event.altKey && key === "f")
      ) {
        event.preventDefault();
        searchInput.current?.focus();
        searchInput.current?.select();
        return;
      }
      if (isEditing || onChromeControl) return;
      // List rows own arrows/Space/Home/End/j/k through roving tabindex.
      // The global handler must not double-handle them when focus is in list.
      const inMessageList = Boolean(
        target?.closest('[role="listbox"], [role="tree"]'),
      );

      if (event.key === "Delete" || (mod && event.key === "Backspace")) {
        const state = useAppStore.getState();
        const currentMsg = state.selectedMessage;
        if (currentMsg) {
          const trashBox = state.mailboxes.find((m) => m.role === "trash");
          if (trashBox && trashBox.id !== currentMsg.mailboxId) {
            event.preventDefault();
            window.dispatchEvent(
              new CustomEvent("postal:menu-action", { detail: "trash" }),
            );
          }
        }
      } else if (event.key === "ArrowDown" || event.key === "j") {
        if (inMessageList) return;
        const next = relativeMessage(1);
        if (next) {
          event.preventDefault();
          void chooseMessage(next);
        }
      } else if (event.key === "ArrowUp" || event.key === "k") {
        if (inMessageList) return;
        const previous = relativeMessage(-1);
        if (previous) {
          event.preventDefault();
          void chooseMessage(previous);
        }
      } else if (event.key === "Home") {
        if (inMessageList) return;
        const first = useAppStore.getState().messages[0];
        if (first) {
          event.preventDefault();
          void chooseMessage(first);
        }
      } else if (event.key === "End") {
        if (inMessageList) return;
        const items = useAppStore.getState().messages;
        const last = items[items.length - 1];
        if (last) {
          event.preventDefault();
          void chooseMessage(last);
        }
      } else if (event.key === " " || event.code === "Space") {
        if (inMessageList) return;
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("postal:scroll-reader", {
            detail: event.shiftKey ? -1 : 1,
          }),
        );
      }
    };
    window.addEventListener("postal:menu-action", menuAction);
    window.addEventListener("keydown", keyboard);
    return () => {
      window.removeEventListener("postal:menu-action", menuAction);
      window.removeEventListener("keydown", keyboard);
    };
  }, [
    chooseMessage,
    onOpenSettings,
    openComposer,
    refresh,
    setError,
    setSettings,
    settings,
  ]);

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

  async function sendScheduledNow(id: string) {
    if (!activeAccountId) return;
    try {
      const request = beginScheduledSend(id, activeAccountId);
      if (!request) return;
      const outcome = await request;
      if (outcome.state !== "sent" && outcome.detail) {
        setError(outcome.detail);
      }
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
      await loadAccountData();
    }
  }

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
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(SIDEBAR_DRAWER_QUERY);
    const update = () => {
      setSidebarDrawerViewport(media.matches);
      if (!media.matches) setSidebarOpen(false);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

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

  const [narrowViewport, setNarrowViewport] = useState(() =>
    typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 760px)").matches
      : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setNarrowViewport(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
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
  const heading = activeLocalView
    ? activeLocalView === "drafts"
      ? strings.mail.drafts
      : activeLocalView === "snoozed"
        ? strings.mail.snoozed
        : strings.mail.outbox
    : (activeMailbox?.displayName ?? strings.mail.mail);
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
      <header
        ref={toolbarRef}
        className="app-toolbar"
        data-tauri-drag-region="deep"
      >
        <div className="toolbar-cluster toolbar-leading">
          <button
            ref={sidebarToggleRef}
            className="icon-button sidebar-toggle"
            type="button"
            onClick={() => {
              if (sidebarDrawerViewport) setSidebarOpen((open) => !open);
              else toggleSidebar();
            }}
            aria-label={
              (sidebarDrawerViewport ? sidebarOpen : sidebarVisible)
                ? strings.mail.hideMailboxes
                : strings.mail.showMailboxes
            }
            aria-expanded={sidebarDrawerViewport ? sidebarOpen : sidebarVisible}
            aria-controls="folder-pane"
          >
            <PanelLeft aria-hidden="true" />
          </button>
          <button
            className="toolbar-button get-mail-button"
            type="button"
            aria-keyshortcuts="F5 Meta+Shift+M Meta+Shift+N Control+Shift+M Control+Shift+N"
            onClick={() => void refresh()}
            disabled={busy}
            aria-label={strings.mail.getMail}
          >
            <RefreshCw aria-hidden="true" className={busy ? "spinning" : ""} />
            <span>{strings.mail.getMail}</span>
          </button>
        </div>
        <span className="toolbar-flex-spacer" aria-hidden="true" />
        <div className="toolbar-trailing">
          <button
            className="primary-button compose-button"
            type="button"
            aria-keyshortcuts="Meta+N Control+N"
            onClick={() => openComposer()}
            aria-label={strings.mail.compose}
          >
            <MailPlus aria-hidden="true" />
            <span>{strings.mail.compose}</span>
          </button>
          <form
            className="search-box"
            data-tauri-drag-region="false"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              void runSearch();
            }}
          >
            <Search aria-hidden="true" />
            <input
              ref={searchInput}
              type="search"
              value={query}
              onChange={(event) => {
                const value = event.target.value;
                queryRef.current = value;
                setQuery(value);
                if (!value.trim() && submittedQueryRef.current) {
                  submittedQueryRef.current = "";
                  searchRequest.current += 1;
                  setSubmittedQuery("");
                  void loadMessages();
                }
              }}
              placeholder={
                activeLocalView === "drafts" || activeLocalView === "outbox"
                  ? strings.mail.searchMailboxOnly
                  : activeLocalView
                    ? strings.mail.searchMailboxOnly
                    : strings.mail.search
              }
              aria-label={strings.mail.search}
              aria-keyshortcuts="Meta+F Control+F /"
              disabled={Boolean(
                activeLocalView &&
                activeLocalView !== "drafts" &&
                activeLocalView !== "outbox",
              )}
            />
            {!activeLocalView ? (
              <button
                className="search-scope"
                type="button"
                aria-pressed={allFolders}
                title={
                  allFolders
                    ? strings.mail.thisAccount
                    : strings.mail.thisMailbox
                }
                onClick={() => {
                  const next = !allFolders;
                  allFoldersRef.current = next;
                  setAllFolders(next);
                  if (queryRef.current.trim()) void runSearch();
                }}
              >
                {allFolders
                  ? strings.mail.thisAccount
                  : strings.mail.thisMailbox}
              </button>
            ) : null}
          </form>
          {updateReady ? (
            <button
              type="button"
              className="update-ready-badge"
              onClick={() => void promptToRestartForUpdate(updateReady)}
              title={strings.mail.updateReadyTooltip(updateReady)}
              aria-label={strings.mail.updateReadyBadge}
            >
              <span className="badge-dot" aria-hidden="true" />
              <span>{strings.mail.updateReadyBadge}</span>
            </button>
          ) : null}
          <button
            className="icon-button settings-button"
            type="button"
            onClick={onOpenSettings}
            aria-label={strings.mail.settings}
            title={strings.mail.settings}
          >
            <Settings aria-hidden="true" />
          </button>
        </div>
      </header>

      <button
        className="sidebar-scrim"
        type="button"
        aria-label={strings.mail.closeMailboxes}
        onClick={() => setSidebarOpen(false)}
      />
      <aside
        id="folder-pane"
        ref={folderPaneRef}
        className="folder-pane"
        aria-label={strings.mail.accountsAndMailboxes}
      >
        <div
          className="sidebar-titlebar-drag"
          data-tauri-drag-region
          aria-hidden="true"
        />
        <div className="sidebar-mobile-header">
          <strong>{strings.mail.mailboxes}</strong>
          <button
            type="button"
            className="icon-button"
            onClick={() => setSidebarOpen(false)}
            aria-label={strings.mail.closeMailboxes}
          >
            <X />
          </button>
        </div>
        <div className="account-heading">
          <span className="account-avatar" aria-hidden="true">
            {(activeAccount?.displayName || activeAccount?.email || "?")
              .slice(0, 1)
              .toUpperCase()}
          </span>
          <span>
            <strong>
              {activeAccount?.displayName || strings.mail.account}
            </strong>
            <small>{activeAccount?.email}</small>
          </span>
        </div>
        {accounts.length > 1 ? (
          <label className="account-select-label">
            <span>{strings.mail.account}</span>
            <span className="account-select-wrap">
              <select
                value={activeAccountId ?? ""}
                onChange={(event) => {
                  mailboxRequest.current += 1;
                  messageRequest.current += 1;
                  detailRequest.current += 1;
                  searchRequest.current += 1;
                  clearQuery();
                  setFolderDialog(null);
                  setFolderName("");
                  setAllFolders(false);
                  resetListState();
                  selectAccount(event.target.value);
                }}
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.displayName || account.email}
                  </option>
                ))}
              </select>
              <ChevronDown aria-hidden="true" />
            </span>
          </label>
        ) : null}
        <button
          className="add-account-button"
          type="button"
          onClick={() => setAddAccountOpen(true)}
        >
          <MailPlus /> {strings.mail.addAccount}
        </button>
        <nav className="folder-list" aria-label={strings.mail.mailboxes}>
          <p className="sidebar-section-title">{strings.mail.localFolders}</p>
          <FolderButton
            icon={FileText}
            label={strings.mail.drafts}
            count={drafts.length}
            active={activeLocalView === "drafts"}
            tone="drafts"
            onClick={() => {
              messageRequest.current += 1;
              searchRequest.current += 1;
              clearQuery();
              resetListState();
              selectLocalView("drafts");
              setSidebarOpen(false);
            }}
          />
          <FolderButton
            icon={TriangleAlert}
            label={strings.mail.outbox}
            count={outbox.length}
            active={activeLocalView === "outbox"}
            tone={outbox.length ? "warning" : undefined}
            onClick={() => {
              messageRequest.current += 1;
              searchRequest.current += 1;
              clearQuery();
              resetListState();
              selectLocalView("outbox");
              setSidebarOpen(false);
            }}
          />
          <FolderButton
            icon={Clock}
            label={strings.mail.snoozed}
            count={snoozed.length}
            active={activeLocalView === "snoozed"}
            tone="archive"
            onClick={() => {
              messageRequest.current += 1;
              searchRequest.current += 1;
              clearQuery();
              resetListState();
              selectLocalView("snoozed");
              setSidebarOpen(false);
            }}
          />
          <p className="sidebar-section-title">{strings.mail.mailboxes}</p>
          {mailboxes.map((mailbox) => {
            const Icon = folderIcons[mailbox.role];
            const personal = mailbox.role === "other";
            if (
              folderDialog?.mode === "rename" &&
              folderDialog.id === mailbox.id
            ) {
              return (
                <form
                  key={mailbox.id}
                  className="folder-dialog"
                  onKeyDown={folderDialogKeyDown}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitFolderDialog();
                  }}
                >
                  <label>
                    <span className="visually-hidden">
                      {strings.mail.folderName}
                    </span>
                    <input
                      autoFocus
                      value={folderName}
                      maxLength={128}
                      onChange={(event) => setFolderName(event.target.value)}
                      placeholder={strings.mail.folderName}
                    />
                  </label>
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={folderBusy || !folderName.trim()}
                  >
                    {strings.mail.rename}
                  </button>
                  <button
                    type="button"
                    className="toolbar-button"
                    onClick={() => closeFolderDialog()}
                  >
                    {strings.common.cancel}
                  </button>
                </form>
              );
            }
            return (
              <FolderButton
                key={mailbox.id}
                icon={Icon}
                label={mailbox.displayName}
                count={mailbox.unreadCount}
                active={mailbox.id === activeMailboxId}
                tone={mailbox.role}
                onClick={() => {
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
                onRename={
                  personal
                    ? () => {
                        openFolderDialog({
                          mode: "rename",
                          id: mailbox.id,
                          name: mailbox.displayName,
                        });
                      }
                    : undefined
                }
                onDelete={
                  personal
                    ? () =>
                        void deleteFolderById(mailbox.id, mailbox.displayName)
                    : undefined
                }
              />
            );
          })}
          {folderDialog?.mode === "create" ? (
            <form
              className="folder-dialog"
              onKeyDown={folderDialogKeyDown}
              onSubmit={(event) => {
                event.preventDefault();
                void submitFolderDialog();
              }}
            >
              <label>
                <span className="visually-hidden">
                  {strings.mail.folderName}
                </span>
                <input
                  autoFocus
                  value={folderName}
                  maxLength={128}
                  onChange={(event) => setFolderName(event.target.value)}
                  placeholder={strings.mail.folderName}
                />
              </label>
              <button
                type="submit"
                className="primary-button"
                disabled={folderBusy || !folderName.trim()}
              >
                {strings.mail.createFolder}
              </button>
              <button
                type="button"
                className="toolbar-button"
                onClick={() => closeFolderDialog()}
              >
                {strings.common.cancel}
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="add-account-button"
              ref={newFolderButtonRef}
              onClick={() => {
                openFolderDialog({ mode: "create" });
              }}
            >
              <FolderPlus aria-hidden="true" /> {strings.mail.newFolder}
            </button>
          )}
          {!activeLocalView &&
          activeMailbox?.role === "trash" &&
          activeMailbox.totalCount > 0 ? (
            <button
              type="button"
              className="add-account-button"
              onClick={() => void emptyTrashFolders()}
            >
              <Trash2 aria-hidden="true" /> {strings.mail.emptyTrash}
            </button>
          ) : null}
          {!activeLocalView &&
          activeMailbox?.role === "junk" &&
          activeMailbox.totalCount > 0 ? (
            <button
              type="button"
              className="add-account-button"
              onClick={() => void emptyJunkFolders()}
            >
              <ShieldAlert aria-hidden="true" /> {strings.mail.emptyJunk}
            </button>
          ) : null}
        </nav>
        <div
          className={`sync-indicator ${sync?.phase ?? "idle"}`}
          role="status"
        >
          <span aria-hidden="true" />
          <span>
            {sync?.detail ??
              (sync?.phase === "syncing"
                ? strings.mail.checkingMail
                : strings.mail.mailUpToDate)}
          </span>
        </div>
      </aside>

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
        <div className="pane-heading">
          <span>
            <h1>{heading}</h1>
            <small>{strings.mail.itemCount(shownCount)}</small>
          </span>
          <div className="pane-heading-actions">
            {!activeLocalView ? (
              <>
                <button
                  type="button"
                  className="toolbar-button select-messages-button"
                  aria-pressed={selecting}
                  onClick={() => {
                    setSelecting((value) => !value);
                    setSelectedIds([]);
                  }}
                >
                  {selecting ? strings.mail.doneSelecting : strings.mail.select}
                </button>
                <div className="mailbox-more" ref={mailboxMoreRef}>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => setMailboxMoreOpen((open) => !open)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "ArrowDown" ||
                        event.key === "ArrowUp"
                      ) {
                        event.preventDefault();
                        setMailboxMoreOpen(true);
                      }
                    }}
                    aria-expanded={mailboxMoreOpen}
                    aria-haspopup="menu"
                    aria-controls="mailbox-more-menu"
                    aria-label={strings.mail.moreMailboxActions}
                    title={strings.mail.moreMailboxActions}
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </button>
                  {mailboxMoreOpen ? (
                    <div
                      id="mailbox-more-menu"
                      className="mailbox-more-menu"
                      role="menu"
                      aria-label={strings.mail.moreMailboxActions}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMailboxMoreOpen(false);
                          mailboxMoreRef.current
                            ?.querySelector<HTMLButtonElement>(
                              "button[aria-haspopup='menu']",
                            )
                            ?.focus();
                          void markAllRead();
                        }}
                        disabled={bulkBusy}
                      >
                        <MailOpen aria-hidden="true" />
                        {strings.mail.markAllRead}
                      </button>
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
            {!activeLocalView && (query || submittedQuery) ? (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  messageRequest.current += 1;
                  searchRequest.current += 1;
                  clearQuery();
                  void loadMessages();
                }}
              >
                {strings.mail.clearSearch}
              </button>
            ) : null}
          </div>
        </div>
        {selecting && !activeLocalView ? (
          <div
            className="bulk-bar"
            role="toolbar"
            aria-label={strings.mail.selectedCount(selectedIds.length)}
          >
            <strong>{strings.mail.selectedCount(selectedIds.length)}</strong>
            <button
              type="button"
              disabled={selectedIds.length === 0 || bulkBusy}
              onClick={() => void bulkFlags(true, undefined)}
            >
              <MailOpen aria-hidden="true" /> {strings.reader.markRead}
            </button>
            <button
              type="button"
              disabled={selectedIds.length === 0 || bulkBusy}
              onClick={() => void bulkFlags(false, undefined)}
            >
              <Mail aria-hidden="true" /> {strings.reader.markUnread}
            </button>
            <button
              type="button"
              disabled={selectedIds.length === 0 || bulkBusy}
              onClick={() => void bulkMove("archive")}
            >
              <Archive aria-hidden="true" /> {strings.reader.archive}
            </button>
            {activeMailbox?.role === "junk" ? (
              <button
                type="button"
                disabled={selectedIds.length === 0 || bulkBusy}
                onClick={() => void bulkMove("inbox")}
              >
                <Inbox aria-hidden="true" /> {strings.reader.notJunk}
              </button>
            ) : (
              <button
                type="button"
                disabled={selectedIds.length === 0 || bulkBusy}
                onClick={() => void bulkMove("junk")}
              >
                <ShieldAlert aria-hidden="true" /> {strings.reader.junk}
              </button>
            )}
            <button
              type="button"
              disabled={selectedIds.length === 0 || bulkBusy}
              onClick={() => void bulkMove("trash")}
            >
              <Trash2 aria-hidden="true" /> {strings.reader.trash}
            </button>
          </div>
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
            onChoose={chooseMessage}
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
