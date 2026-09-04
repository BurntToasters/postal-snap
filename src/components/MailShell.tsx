import {
  useCallback,
  useEffect,
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
  PanelLeft,
  Paperclip,
  Pencil,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldAlert,
  Star,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { api } from "../api";
import { PostalError } from "../errors";
import { strings } from "../i18n";
import { formatMessageDate } from "../format";
import { applySettings } from "../settings";
import { useAppStore } from "../store";
import { groupThreads } from "../threads";
import type { MailboxRole, MessageSummary } from "../types";
import { promptToRestartForUpdate } from "../update";
import { AppMark } from "./AppMark";
import { MessageReader } from "./MessageReader";
import { SetupWizard } from "./SetupWizard";
import { useDialogFocus } from "./useDialogFocus";

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
  const [allFolders, setAllFolders] = useState(false);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
  const newFolderButtonRef = useRef<HTMLButtonElement>(null);
  const lastFolderInvoker = useRef<HTMLElement | null>(null);

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
  const allFoldersRef = useRef(allFolders);
  useEffect(() => {
    queryRef.current = query;
    allFoldersRef.current = allFolders;
  }, [allFolders, query]);

  function resetListState() {
    setSelectedIds([]);
    setSelecting(false);
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
      queryRef.current.trim()
    )
      return;
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

  const refresh = useCallback(async () => {
    if (!activeAccountId || busy) return;
    setBusy(true);
    try {
      await api.syncAccount(activeAccountId);
      await loadAccountData();
      await refreshList();
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
    refreshList,
    setBusy,
    setError,
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
        !queryRef.current.trim()
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
      await loadMessages();
      return;
    }
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

  async function refreshList() {
    if (queryRef.current.trim()) await runSearch();
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

  async function bulkMove(role: "archive" | "trash" | "junk") {
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
    const due = outbox
      .filter((item) => item.state === "scheduled" && item.sendAt)
      .map((item) => new Date(item.sendAt as string).getTime() - Date.now())
      .filter((ms) => Number.isFinite(ms));
    if (due.length === 0 || !activeAccountId) return;
    const wait = Math.min(...due);
    if (wait <= 0) {
      const overdue = outbox.find(
        (item) =>
          item.state === "scheduled" &&
          item.sendAt &&
          new Date(item.sendAt).getTime() <= Date.now(),
      );
      if (overdue && activeAccountId) {
        const id = overdue.id;
        const account = activeAccountId;
        void api
          .sendScheduledOutbox(id, account)
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
      if (ready && current.activeAccountId) {
        void api
          .sendScheduledOutbox(ready.id, current.activeAccountId)
          .catch((cause) => setError(String(cause)))
          .finally(() => void loadAccountData());
      } else {
        void loadAccountData();
      }
    }, wait);
    return () => window.clearTimeout(timer);
  }, [outbox, activeAccountId, loadAccountData, setError]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadMessages(), 0);
    return () => window.clearTimeout(timer);
  }, [loadMessages]);

  useEffect(() => {
    let active = true;
    const unsubs: Array<() => void> = [];
    void api
      .onFolderCountsChanged(({ accountId }) => {
        if (accountId === useAppStore.getState().activeAccountId)
          void loadAccountData();
      })
      .then((fn) => {
        if (active) unsubs.push(fn);
        else fn();
      });
    void api
      .onMessageChanged(({ accountId }) => {
        if (accountId !== useAppStore.getState().activeAccountId) return;
        if (queryRef.current.trim()) void runSearch();
        else void loadMessages();
      })
      .then((fn) => {
        if (active) unsubs.push(fn);
        else fn();
      });
    void api
      .onDraftSyncChanged(({ accountId }) => {
        if (accountId === useAppStore.getState().activeAccountId)
          void loadAccountData();
      })
      .then((fn) => {
        if (active) unsubs.push(fn);
        else fn();
      });
    void api
      .onOutboxChanged(({ accountId }) => {
        if (accountId === useAppStore.getState().activeAccountId)
          void loadAccountData();
      })
      .then((fn) => {
        if (active) unsubs.push(fn);
        else fn();
      });
    const refreshLocal = (event: Event) => {
      const accountId = (event as CustomEvent<string>).detail;
      if (accountId === useAppStore.getState().activeAccountId)
        void loadAccountData();
    };
    window.addEventListener("postal:local-mail-changed", refreshLocal);
    return () => {
      active = false;
      unsubs.forEach((fn) => fn());
      window.removeEventListener("postal:local-mail-changed", refreshLocal);
    };
  }, [loadAccountData, loadMessages, runSearch]);

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
    };
    const keyboard = (event: KeyboardEvent) => {
      if (document.querySelector(".modal-layer")) return;
      const target = event.target as HTMLElement | null;
      const isEditing = Boolean(
        target?.matches("input,textarea,select,[contenteditable='true']"),
      );
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (mod && !event.shiftKey && key === "n") {
        event.preventDefault();
        openComposer();
        return;
      }
      if ((mod && event.shiftKey && key === "m") || event.key === "F5") {
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
      if (
        (event.key === "/" && !mod) ||
        (mod && !event.shiftKey && key === "f")
      ) {
        event.preventDefault();
        searchInput.current?.focus();
        searchInput.current?.select();
        return;
      }
      if (isEditing) return;

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
        const next = relativeMessage(1);
        if (next) {
          event.preventDefault();
          void chooseMessage(next);
        }
      } else if (event.key === "ArrowUp" || event.key === "k") {
        const previous = relativeMessage(-1);
        if (previous) {
          event.preventDefault();
          void chooseMessage(previous);
        }
      } else if (event.key === "Home") {
        const first = useAppStore.getState().messages[0];
        if (first) {
          event.preventDefault();
          void chooseMessage(first);
        }
      } else if (event.key === "End") {
        const items = useAppStore.getState().messages;
        const last = items[items.length - 1];
        if (last) {
          event.preventDefault();
          void chooseMessage(last);
        }
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
    const limits = {
      folderPaneWidth: [210, 420],
      messagePaneWidth: [300, 720],
      readerPaneHeight: [240, 800],
    } as const;
    const [minimum, maximum] = limits[key];
    const next = {
      ...useAppStore.getState().settings,
      [key]: Math.round(Math.min(maximum, Math.max(minimum, value))),
    };
    setSettings(next);
    if (persist)
      void api
        .saveSettings(next)
        .then(setSettings)
        .catch((cause) => setError(String(cause)));
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
      await api.sendScheduledOutbox(id, activeAccountId);
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
      await api.deleteOutbox(id, activeAccountId);
      await loadAccountData();
    } catch (cause) {
      setError(String(cause));
    }
  }

  const activeMailbox = useMemo(
    () => mailboxes.find((box) => box.id === activeMailboxId),
    [activeMailboxId, mailboxes],
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
  const shellClass = `mail-shell pane-${settings.readingPane} ${sidebarOpen ? "sidebar-open" : ""} ${selectedMessage ? "message-open" : ""}`;

  const shellStyle = {
    "--folder-pane-width": `${settings.folderPaneWidth}px`,
    "--message-pane-width": `${settings.messagePaneWidth}px`,
    "--reader-pane-height": `${settings.readerPaneHeight}px`,
  } as CSSProperties;

  return (
    <main className={shellClass} style={shellStyle}>
      <header className="app-toolbar">
        <button
          className="icon-button sidebar-toggle"
          type="button"
          onClick={() => setSidebarOpen((open) => !open)}
          aria-label={
            sidebarOpen
              ? strings.mail.hideMailboxes
              : strings.mail.showMailboxes
          }
          aria-expanded={sidebarOpen}
          aria-controls="folder-pane"
        >
          <PanelLeft aria-hidden="true" />
        </button>
        <div className="app-brand" aria-label={strings.appName}>
          <AppMark size={28} />
          <strong>{strings.appName}</strong>
        </div>
        <button
          className="toolbar-button get-mail-button"
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          aria-label={strings.mail.getMail}
        >
          <RefreshCw aria-hidden="true" className={busy ? "spinning" : ""} />
          <span aria-hidden="false">{strings.mail.getMail}</span>
        </button>
        <button
          className="primary-button compose-button"
          type="button"
          onClick={() => openComposer()}
          aria-label={strings.mail.compose}
        >
          <MailPlus aria-hidden="true" />
          <span aria-hidden="false">{strings.mail.compose}</span>
        </button>
        <form
          className="search-box"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch();
          }}
        >
          <Search aria-hidden="true" />
          <input
            ref={searchInput}
            value={query}
            onChange={(event) => {
              queryRef.current = event.target.value;
              setQuery(event.target.value);
            }}
            placeholder={
              activeLocalView
                ? strings.mail.searchMailboxOnly
                : strings.mail.search
            }
            aria-label={strings.mail.search}
            disabled={Boolean(activeLocalView)}
          />
          {!activeLocalView ? (
            <label className="search-scope">
              <input
                type="checkbox"
                checked={allFolders}
                onChange={(event) => {
                  allFoldersRef.current = event.target.checked;
                  setAllFolders(event.target.checked);
                }}
              />
              {strings.mail.allFolders}
            </label>
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
          className="icon-button"
          type="button"
          onClick={onOpenSettings}
          aria-label={strings.mail.settings}
        >
          <Settings />
        </button>
      </header>

      <button
        className="sidebar-scrim"
        type="button"
        aria-label={strings.mail.closeMailboxes}
        onClick={() => setSidebarOpen(false)}
      />
      <aside
        id="folder-pane"
        className="folder-pane"
        aria-label={strings.mail.accountsAndMailboxes}
      >
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
        <label className="account-select-label">
          <span>{strings.mail.account}</span>
          <span className="account-select-wrap">
            <select
              value={activeAccountId}
              onChange={(event) => {
                mailboxRequest.current += 1;
                messageRequest.current += 1;
                detailRequest.current += 1;
                searchRequest.current += 1;
                queryRef.current = "";
                setQuery("");
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
            onClick={() => {
              messageRequest.current += 1;
              searchRequest.current += 1;
              queryRef.current = "";
              setQuery("");
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
              queryRef.current = "";
              setQuery("");
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
            onClick={() => {
              messageRequest.current += 1;
              searchRequest.current += 1;
              queryRef.current = "";
              setQuery("");
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
                onClick={() => {
                  const sameMailbox =
                    mailbox.id === activeMailboxId && !activeLocalView;
                  if (!sameMailbox) messageRequest.current += 1;
                  searchRequest.current += 1;
                  queryRef.current = "";
                  setQuery("");
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
          {mailboxes.some(
            (mailbox) => mailbox.role === "trash" && mailbox.totalCount > 0,
          ) ? (
            <button
              type="button"
              className="add-account-button"
              onClick={() => void emptyTrashFolders()}
            >
              <Trash2 aria-hidden="true" /> {strings.mail.emptyTrash}
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
                  className="toolbar-button"
                  onClick={() => void markAllRead()}
                  disabled={bulkBusy}
                >
                  <MailOpen aria-hidden="true" /> {strings.mail.markAllRead}
                </button>
                <button
                  type="button"
                  className="toolbar-button"
                  aria-pressed={selecting}
                  onClick={() => {
                    setSelecting((value) => !value);
                    setSelectedIds([]);
                  }}
                >
                  {selecting ? strings.mail.doneSelecting : strings.mail.select}
                </button>
              </>
            ) : null}
            {query && !activeLocalView ? (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  messageRequest.current += 1;
                  searchRequest.current += 1;
                  queryRef.current = "";
                  setQuery("");
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
            <button
              type="button"
              disabled={selectedIds.length === 0 || bulkBusy}
              onClick={() => void bulkMove("junk")}
            >
              <ShieldAlert aria-hidden="true" /> {strings.reader.junk}
            </button>
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
          <DraftList drafts={drafts} onOpen={openDraft} />
        ) : activeLocalView === "snoozed" ? (
          <SnoozedList
            items={snoozed}
            onOpen={chooseSnoozed}
            onUnsnooze={unsnoozeById}
          />
        ) : activeLocalView === "outbox" ? (
          <OutboxList
            items={outbox}
            onRetry={retryQueued}
            onRetryCopy={retrySentCopy}
            onSendNow={sendScheduledNow}
            onDiscard={discardQueued}
          />
        ) : (
          <MessageList
            key={`${activeAccountId}:${activeMailboxId ?? ""}:${activeLocalView ?? ""}:${query.trim()}`}
            messages={messages}
            selectedId={selectedMessage?.id}
            loading={loadingMessages}
            loadingMessageId={loadingMessageId}
            onChoose={chooseMessage}
            hasMore={hasMoreMessages}
            onLoadMore={loadMoreMessages}
            searchQuery={query.trim()}
            selecting={selecting}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelectMessage}
            onClearSearch={() => {
              queryRef.current = "";
              setQuery("");
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

      <MessageReader />
      {addAccountOpen ? (
        <AddAccountDialog
          onClose={() => setAddAccountOpen(false)}
          onComplete={async () => {
            const previousIds = new Set(accounts.map((account) => account.id));
            const loaded = await api.listAccounts();
            setAccounts(loaded);
            const added = loaded.find(
              (account) => !previousIds.has(account.id),
            );
            if (added) selectAccount(added.id);
            setAddAccountOpen(false);
          }}
        />
      ) : null}
    </main>
  );
}

function PaneSplitter({
  className,
  label,
  controls,
  orientation,
  value,
  min,
  max,
  onChange,
}: {
  className: string;
  label: string;
  controls?: string;
  orientation: "vertical" | "horizontal-reverse";
  value: number;
  min: number;
  max: number;
  onChange: (value: number, persist: boolean) => void;
}) {
  return (
    <div
      className={`pane-splitter ${className}`}
      role="separator"
      aria-label={label}
      aria-controls={controls}
      aria-orientation={orientation === "vertical" ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={strings.mail.paneSize(Math.round(value))}
      tabIndex={0}
      onKeyDown={(event) => {
        const decrement =
          orientation === "vertical" ? "ArrowLeft" : "ArrowDown";
        const increment = orientation === "vertical" ? "ArrowRight" : "ArrowUp";
        if (
          event.key === "Home" ||
          event.key === "End" ||
          event.key === "PageUp" ||
          event.key === "PageDown" ||
          event.key === decrement ||
          event.key === increment
        ) {
          event.preventDefault();
        } else {
          return;
        }
        if (event.key === "Home") {
          onChange(min, true);
          return;
        }
        if (event.key === "End") {
          onChange(max, true);
          return;
        }
        if (event.key === "PageUp" || event.key === "PageDown") {
          onChange(value + (event.key === "PageUp" ? 64 : -64), true);
          return;
        }
        onChange(value + (event.key === increment ? 16 : -16), true);
      }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        const start =
          orientation === "vertical" ? event.clientX : event.clientY;
        const initial = value;
        const target = event.currentTarget;
        const move = (moveEvent: PointerEvent) => {
          const current =
            orientation === "vertical" ? moveEvent.clientX : moveEvent.clientY;
          const delta = current - start;
          onChange(
            initial + (orientation === "vertical" ? delta : -delta),
            false,
          );
        };
        const finish = (upEvent: PointerEvent) => {
          const current =
            orientation === "vertical" ? upEvent.clientX : upEvent.clientY;
          const delta = current - start;
          target.releasePointerCapture(upEvent.pointerId);
          target.removeEventListener("pointermove", move);
          target.removeEventListener("pointerup", finish);
          onChange(
            initial + (orientation === "vertical" ? delta : -delta),
            true,
          );
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", finish);
      }}
    />
  );
}

function FolderButton({
  icon: Icon,
  label,
  count,
  active,
  tone,
  onClick,
  onRename,
  onDelete,
}: {
  icon: typeof Inbox;
  label: string;
  count: number;
  active: boolean;
  tone?: "warning";
  onClick: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="folder-row">
      <button
        type="button"
        className={`folder ${active ? "active" : ""} ${tone ?? ""}`}
        onClick={onClick}
        aria-current={active ? "page" : undefined}
      >
        <Icon aria-hidden="true" />
        <span>{label}</span>
        {count > 0 ? <strong>{count > 999 ? "999+" : count}</strong> : null}
      </button>
      {onRename ? (
        <button
          type="button"
          className="icon-button folder-action"
          onClick={onRename}
          aria-label={`${strings.mail.rename} ${label}`}
          title={`${strings.mail.rename} ${label}`}
        >
          <Pencil aria-hidden="true" />
        </button>
      ) : null}
      {onDelete ? (
        <button
          type="button"
          className="icon-button folder-action"
          onClick={onDelete}
          aria-label={`${strings.mail.deleteFolder}: ${label}`}
          title={`${strings.mail.deleteFolder}: ${label}`}
        >
          <Trash2 aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function isOversizeError(cause: unknown): boolean {
  if (cause instanceof PostalError) return cause.code === "limitExceeded";
  return /too large|exceeds.*safety limit/i.test(String(cause));
}

function mergeSearchResults(
  localItems: MessageSummary[],
  serverItems: MessageSummary[],
): MessageSummary[] {
  // Cached FTS uses AND of up to 12 terms ranked by bm25; server uses IMAP
  // TEXT phrase matching. Keep cached rank order, then append server-only
  // body matches newest-first so server hits are not filtered through FTS.
  const seen = new Set<number>();
  const merged: MessageSummary[] = [];
  for (const item of localItems) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  const serverOnly = serverItems
    .filter((item) => !seen.has(item.id))
    .sort(
      (a, b) =>
        new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
    );
  for (const item of serverOnly) {
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

function MessageList({
  messages,
  selectedId,
  loading,
  loadingMessageId,
  onChoose,
  hasMore,
  onLoadMore,
  searchQuery,
  onClearSearch,
  selecting,
  selectedIds,
  onToggleSelect,
}: {
  messages: MessageSummary[];
  selectedId?: number;
  loading: boolean;
  loadingMessageId?: number;
  onChoose: (message: MessageSummary) => Promise<void>;
  hasMore: boolean;
  onLoadMore: () => Promise<void>;
  searchQuery?: string;
  onClearSearch?: () => void;
  selecting?: boolean;
  selectedIds?: number[];
  onToggleSelect?: (id: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [expandedThreads, setExpandedThreads] = useState<string[]>([]);

  function toggleThread(key: string) {
    setExpandedThreads((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key],
    );
  }

  useEffect(() => {
    const selected = listRef.current?.querySelector<HTMLElement>(
      "[role='option'][aria-selected='true']",
    );
    if (!selected) return;
    selected.scrollIntoView?.({ block: "nearest" });
    if (listRef.current?.contains(document.activeElement)) selected.focus();
  }, [selectedId]);

  // The open message's thread stays expanded without storing it:
  // deriving keeps render pure and survives list reloads.
  const selectedThreadKey = selectedId
    ? groupThreads(messages).find(
        (group) =>
          group.items.length > 1 &&
          group.items.some((item) => item.id === selectedId),
      )?.key
    : undefined;
  const effectiveExpanded =
    selectedThreadKey && !expandedThreads.includes(selectedThreadKey)
      ? [...expandedThreads, selectedThreadKey]
      : expandedThreads;

  if (loading && messages.length === 0)
    return (
      <div className="list-state" role="status">
        {strings.mail.loadingMessages}
      </div>
    );
  if (messages.length === 0) {
    if (searchQuery) {
      return (
        <div className="list-state" role="status">
          <p>{strings.mail.noSearchResults(searchQuery)}</p>
          {onClearSearch ? (
            <button
              type="button"
              className="secondary-button"
              onClick={onClearSearch}
            >
              {strings.mail.clearSearch}
            </button>
          ) : null}
        </div>
      );
    }
    return (
      <div className="list-state" role="status" aria-live="polite">
        {strings.mail.emptyMailbox}
      </div>
    );
  }
  function renderRow(message: MessageSummary, index: number) {
    const checked = selecting && (selectedIds ?? []).includes(message.id);
    const rowLabel = [
      message.isRead ? strings.mail.read : strings.mail.unread,
      message.isStarred ? strings.mail.starred : null,
      message.senderName || message.senderAddress,
      message.subject || strings.common.noSubject,
      formatMessageDate(message.receivedAt),
      message.hasAttachments ? strings.mail.hasAttachments : null,
    ]
      .filter(Boolean)
      .join(", ");
    return (
      <div key={message.id} className="message-row-wrap">
        {selecting ? (
          <input
            type="checkbox"
            className="message-select"
            checked={checked}
            onChange={() => onToggleSelect?.(message.id)}
            aria-label={strings.mail.selectMessage(
              message.subject || strings.common.noSubject,
            )}
          />
        ) : null}
        <button
          type="button"
          role="option"
          aria-selected={selecting ? checked : selectedId === message.id}
          tabIndex={
            selecting
              ? 0
              : selectedId === message.id || (!selectedId && index === 0)
                ? 0
                : -1
          }
          aria-label={rowLabel}
          className={`message-row ${message.isRead ? "read" : "unread"} ${!selecting && selectedId === message.id ? "selected" : ""} ${checked ? "checked" : ""}`}
          onClick={() =>
            selecting ? onToggleSelect?.(message.id) : void onChoose(message)
          }
          onKeyDown={(event) => {
            if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            event.stopPropagation();
            const nextIndex =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? messages.length - 1
                  : Math.max(
                      0,
                      Math.min(
                        messages.length - 1,
                        index + (event.key === "ArrowDown" ? 1 : -1),
                      ),
                    );
            const next = messages[nextIndex];
            if (!next || next.id === message.id) return;
            if (selecting) {
              const list = event.currentTarget.closest("[role='listbox']");
              list
                ?.querySelectorAll<HTMLElement>("[role='option']")
                ?.[nextIndex]?.focus();
              return;
            }
            void onChoose(next);
          }}
        >
          <span
            className="unread-dot"
            aria-label={
              message.isRead ? strings.mail.read : strings.mail.unread
            }
          />
          <span className="message-sender">
            {message.senderName || message.senderAddress}
          </span>
          <time className="message-date" dateTime={message.receivedAt}>
            {formatMessageDate(message.receivedAt)}
          </time>
          <span className="message-subject">
            {message.isStarred ? (
              <Star fill="currentColor" aria-label={strings.mail.starred} />
            ) : null}
            <span>{message.subject || strings.common.noSubject}</span>
            {message.hasAttachments ? (
              <Paperclip aria-label={strings.mail.hasAttachments} />
            ) : null}
          </span>
          <span className="message-preview">
            {loadingMessageId === message.id
              ? strings.mail.downloadingMessage
              : message.preview || strings.mail.openToDownload}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="message-list">
      <div
        ref={listRef}
        role="listbox"
        aria-label={strings.mail.messages}
        aria-busy={loading}
      >
        {selecting
          ? messages.map((message, index) => renderRow(message, index))
          : groupThreads(messages).map((group) => {
              if (group.items.length === 1) {
                return renderRow(group.newest, messages.indexOf(group.newest));
              }
              const expanded = effectiveExpanded.includes(group.key);
              return (
                <div key={group.key} className="thread-group">
                  <button
                    type="button"
                    className={`message-row thread-header ${group.newest.id === selectedId ? "selected" : ""}`}
                    aria-expanded={expanded}
                    onClick={() => toggleThread(group.key)}
                    aria-label={[
                      strings.mail.conversation,
                      group.newest.subject || strings.common.noSubject,
                      strings.mail.threadMessages(group.items.length),
                      group.unread > 0
                        ? strings.mail.threadUnread(group.unread)
                        : null,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  >
                    <span
                      className="unread-dot"
                      aria-hidden="true"
                      data-unread={group.unread > 0}
                    />
                    <span className="message-sender">
                      {group.newest.senderName || group.newest.senderAddress}
                    </span>
                    <time
                      className="message-date"
                      dateTime={group.newest.receivedAt}
                    >
                      {formatMessageDate(group.newest.receivedAt)}
                    </time>
                    <span className="message-subject">
                      <span>
                        {group.newest.subject || strings.common.noSubject}
                      </span>
                      <strong className="thread-count">
                        {group.items.length}
                      </strong>
                    </span>
                    <span className="message-preview">
                      {group.newest.preview || strings.mail.openToDownload}
                    </span>
                  </button>
                  {expanded
                    ? group.items.map((message) =>
                        renderRow(message, messages.indexOf(message)),
                      )
                    : null}
                </div>
              );
            })}
      </div>
      {hasMore ? (
        <button
          type="button"
          className="load-more-button"
          onClick={() => void onLoadMore()}
          disabled={loading}
        >
          {loading ? strings.mail.loadingOlder : strings.mail.loadOlder}
        </button>
      ) : null}
    </div>
  );
}

function AddAccountDialog({
  onClose,
  onComplete,
}: {
  onClose: () => void;
  onComplete: () => Promise<void>;
}) {
  const dialogRef = useDialogFocus(onClose);
  return (
    <div className="modal-layer setup-modal">
      <button
        type="button"
        className="modal-backdrop"
        aria-label={strings.mail.closeAddAccount}
        onClick={onClose}
      />
      <section
        className="setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={strings.mail.addEmailAccount}
        ref={dialogRef}
      >
        <SetupWizard onComplete={onComplete} />
      </section>
    </div>
  );
}

function SnoozedList({
  items,
  onOpen,
  onUnsnooze,
}: {
  items: ReturnType<typeof useAppStore.getState>["snoozed"];
  onOpen: (message: MessageSummary) => Promise<void>;
  onUnsnooze: (id: number) => Promise<void>;
}) {
  if (items.length === 0)
    return (
      <div className="list-state" role="status" aria-live="polite">
        {strings.mail.noSnoozed}
      </div>
    );
  return (
    <div className="local-mail-list">
      {items.map((item) => (
        <div key={item.message.id} className="message-row-wrap">
          <button
            type="button"
            className="local-mail-row snoozed-row"
            onClick={() => void onOpen(item.message)}
            aria-label={[
              item.message.isRead ? strings.mail.read : strings.mail.unread,
              item.message.senderName || item.message.senderAddress,
              item.message.subject || strings.common.noSubject,
              strings.mail.snoozedUntil(formatMessageDate(item.snoozedUntil)),
            ].join(", ")}
          >
            <Clock aria-hidden="true" />
            <span>
              <strong>
                {item.message.subject || strings.common.noSubject}
              </strong>
              <small>
                {item.message.senderName || item.message.senderAddress}
              </small>
              <small>
                {strings.mail.snoozedUntil(
                  formatMessageDate(item.snoozedUntil),
                )}
              </small>
            </span>
            <time dateTime={item.message.receivedAt}>
              {formatMessageDate(item.message.receivedAt)}
            </time>
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void onUnsnooze(item.message.id)}
            aria-label={`${strings.mail.unsnooze}: ${item.message.subject || strings.common.noSubject}`}
            title={strings.mail.unsnooze}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}

function DraftList({
  drafts,
  onOpen,
}: {
  drafts: ReturnType<typeof useAppStore.getState>["drafts"];
  onOpen: (id: string) => Promise<void>;
}) {
  if (drafts.length === 0)
    return (
      <div className="list-state" role="status" aria-live="polite">
        {strings.mail.noDrafts}
      </div>
    );
  return (
    <div className="local-mail-list">
      {drafts.map((draft) => (
        <button
          key={draft.id}
          type="button"
          className="local-mail-row"
          onClick={() => void onOpen(draft.id)}
          aria-label={
            draft.syncDetail
              ? `${draft.subject || strings.common.noSubject} — ${draft.syncDetail}`
              : undefined
          }
        >
          <FileText aria-hidden="true" />
          <span>
            <strong>{draft.subject || strings.common.noSubject}</strong>
            <small>{draft.recipients || strings.mail.noRecipientYet}</small>
            <small
              className={`draft-sync-state ${draft.syncState}`}
              title={draft.syncDetail ?? undefined}
            >
              {draft.syncState === "synced"
                ? strings.mail.savedServer
                : draft.syncState === "conflict"
                  ? strings.mail.recoveredConflict
                  : draft.syncState === "localOnly"
                    ? strings.mail.savedLocal
                    : strings.mail.savingServer}
            </small>
          </span>
          <time dateTime={draft.updatedAt}>
            {formatMessageDate(draft.updatedAt)}
          </time>
        </button>
      ))}
    </div>
  );
}

function OutboxList({
  items,
  onRetry,
  onRetryCopy,
  onSendNow,
  onDiscard,
}: {
  items: ReturnType<typeof useAppStore.getState>["outbox"];
  onRetry: (id: string) => Promise<void>;
  onRetryCopy: (id: string) => Promise<void>;
  onSendNow: (id: string) => Promise<void>;
  onDiscard: (
    id: string,
    state: ReturnType<typeof useAppStore.getState>["outbox"][number]["state"],
  ) => Promise<void>;
}) {
  const hasScheduled = items.some((item) => item.state === "scheduled");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasScheduled) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasScheduled]);
  if (items.length === 0)
    return (
      <div className="list-state" role="status" aria-live="polite">
        {strings.mail.noQueued}
      </div>
    );
  return (
    <div className="local-mail-list">
      {items.map((item) => (
        <article key={item.id} className="attention-row">
          {item.state === "needs_attention" ? (
            <TriangleAlert aria-hidden="true" />
          ) : (
            <Send aria-hidden="true" />
          )}
          <span>
            <strong>{item.subject || strings.common.noSubject}</strong>
            <small>{item.recipients || strings.mail.noRecipient}</small>
            <small>{item.detail}</small>
            {item.state === "scheduled" && item.sendAt ? (
              <small className="status-label">
                {strings.mail.sendIn(
                  Math.max(
                    0,
                    Math.round((new Date(item.sendAt).getTime() - now) / 1000),
                  ),
                )}
              </small>
            ) : null}
            <small className="status-label">
              {item.state === "queued"
                ? strings.mail.waitingSend
                : item.state === "sending"
                  ? strings.mail.sending
                  : item.state === "sent_copy_pending"
                    ? strings.mail.sentCopyPending
                    : item.state === "scheduled"
                      ? strings.mail.scheduledWaiting
                      : strings.mail.needsAttention}
            </small>
          </span>
          <div>
            {item.state === "needs_attention" ? (
              <button type="button" onClick={() => void onRetry(item.id)}>
                {strings.mail.retrySending}
              </button>
            ) : item.state === "sent_copy_pending" ? (
              <button type="button" onClick={() => void onRetryCopy(item.id)}>
                {strings.mail.saveSentCopy}
              </button>
            ) : item.state === "scheduled" ? (
              <button type="button" onClick={() => void onSendNow(item.id)}>
                {strings.mail.sendNow}
              </button>
            ) : null}
            <button
              type="button"
              className="danger-button"
              onClick={() => void onDiscard(item.id, item.state)}
            >
              {item.state === "sent_copy_pending"
                ? strings.mail.dismissWarning
                : item.state === "scheduled"
                  ? strings.mail.undoSend
                  : strings.common.discard}
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
