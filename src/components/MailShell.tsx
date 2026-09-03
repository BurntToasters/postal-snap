import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Archive,
  ChevronDown,
  FileText,
  Inbox,
  MailPlus,
  Menu,
  PanelLeft,
  Paperclip,
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
import { strings } from "../i18n";
import { formatMessageDate } from "../format";
import { applySettings } from "../settings";
import { useAppStore } from "../store";
import type { MailboxRole, MessageSummary } from "../types";
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
  const [query, setQuery] = useState("");
  const [allFolders, setAllFolders] = useState(false);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingMessageId, setLoadingMessageId] = useState<number>();
  const mailboxRequest = useRef(0);
  const messageRequest = useRef(0);
  const detailRequest = useRef(0);
  const searchRequest = useRef(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const queryRef = useRef(query);
  const allFoldersRef = useRef(allFolders);
  useEffect(() => {
    queryRef.current = query;
    allFoldersRef.current = allFolders;
  }, [allFolders, query]);

  const loadAccountData = useCallback(async () => {
    if (!activeAccountId) return;
    const accountId = activeAccountId;
    const request = ++mailboxRequest.current;
    try {
      const [mailboxesResult, draftsResult, outboxResult] =
        await Promise.allSettled([
          api.listMailboxes(accountId),
          api.listDrafts(accountId),
          api.listOutbox(accountId),
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
      const failed = [mailboxesResult, draftsResult, outboxResult].find(
        (result) => result.status === "rejected",
      );
      if (failed?.status === "rejected") setError(String(failed.reason));
    } catch (cause) {
      if (request === mailboxRequest.current) setError(String(cause));
    }
  }, [activeAccountId, setDrafts, setError, setMailboxes, setOutbox]);

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
      await loadMessages();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [activeAccountId, busy, loadAccountData, loadMessages, setBusy, setError]);

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
    const request = messageRequest.current;
    setLoadingMessages(true);
    try {
      const page = await api.listMessages(accountId, mailboxId, messageCursor);
      const current = useAppStore.getState();
      if (
        request === messageRequest.current &&
        current.activeAccountId === accountId &&
        current.activeMailboxId === mailboxId &&
        !current.activeLocalView &&
        !queryRef.current.trim()
      )
        appendMessages(page.items, page.nextCursor ?? undefined, page.hasMore);
    } catch (cause) {
      if (request === messageRequest.current) setError(String(cause));
    } finally {
      if (request === messageRequest.current) setLoadingMessages(false);
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
        setMessages(server, undefined, false);
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
        if (request === detailRequest.current) setError(String(cause));
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
    const timer = window.setTimeout(() => void loadMessages(), 0);
    return () => window.clearTimeout(timer);
  }, [loadMessages]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    void api
      .onFolderCountsChanged(({ accountId }) => {
        if (accountId === useAppStore.getState().activeAccountId)
          void loadAccountData();
      })
      .then((fn) => unsubs.push(fn));
    void api
      .onMessageChanged(({ accountId }) => {
        if (accountId !== useAppStore.getState().activeAccountId) return;
        if (queryRef.current.trim()) void runSearch();
        else void loadMessages();
      })
      .then((fn) => unsubs.push(fn));
    const refreshLocal = (event: Event) => {
      const accountId = (event as CustomEvent<string>).detail;
      if (accountId === useAppStore.getState().activeAccountId)
        void loadAccountData();
    };
    window.addEventListener("postal:local-mail-changed", refreshLocal);
    return () => {
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
        const delta = action === "text-larger" ? 0.1 : -0.1;
        const next = {
          ...settings,
          textScale: Math.min(2, Math.max(0.85, settings.textScale + delta)),
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

      if (
        event.key === "Delete" ||
        event.key === "Backspace" ||
        (mod && event.key === "Backspace")
      ) {
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
    if (!window.confirm(strings.mail.retryWarning)) return;
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

  async function discardQueued(
    id: string,
    state: ReturnType<typeof useAppStore.getState>["outbox"][number]["state"],
  ) {
    if (!activeAccountId) return;
    if (
      !window.confirm(
        state === "sent_copy_pending"
          ? strings.mail.dismissSentCopy
          : strings.mail.discardQueued,
      )
    )
      return;
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
      : strings.mail.outbox
    : (activeMailbox?.displayName ?? strings.mail.mail);
  const shownCount = activeLocalView
    ? activeLocalView === "drafts"
      ? drafts.length
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
        >
          <PanelLeft />
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
        >
          <RefreshCw className={busy ? "spinning" : ""} />
          <span>{strings.mail.getMail}</span>
        </button>
        <button
          className="primary-button compose-button"
          type="button"
          onClick={() => openComposer()}
        >
          <MailPlus />
          <span>{strings.mail.compose}</span>
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
              selectLocalView("outbox");
              setSidebarOpen(false);
            }}
          />
          <p className="sidebar-section-title">{strings.mail.mailboxes}</p>
          {mailboxes.map((mailbox) => {
            const Icon = folderIcons[mailbox.role];
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
                  selectMailbox(mailbox.id);
                  setSidebarOpen(false);
                  if (sameMailbox) void loadMessages();
                }}
              />
            );
          })}
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
        orientation="vertical"
        value={settings.folderPaneWidth}
        onChange={(value, persist) =>
          resizePane("folderPaneWidth", value, persist)
        }
      />

      <section className="message-pane" aria-label={heading}>
        <div className="pane-heading">
          <span>
            <h1>{heading}</h1>
            <small>{strings.mail.itemCount(shownCount)}</small>
          </span>
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
        {activeLocalView === "drafts" ? (
          <DraftList drafts={drafts} onOpen={openDraft} />
        ) : activeLocalView === "outbox" ? (
          <OutboxList
            items={outbox}
            onRetry={retryQueued}
            onRetryCopy={retrySentCopy}
            onDiscard={discardQueued}
          />
        ) : (
          <MessageList
            messages={messages}
            selectedId={selectedMessage?.id}
            loading={loadingMessages}
            loadingMessageId={loadingMessageId}
            onChoose={chooseMessage}
            hasMore={hasMoreMessages}
            onLoadMore={loadMoreMessages}
          />
        )}
      </section>

      {settings.readingPane === "right" ? (
        <PaneSplitter
          className="reader-splitter"
          label={strings.mail.resizeMessages}
          orientation="vertical"
          value={settings.messagePaneWidth}
          onChange={(value, persist) =>
            resizePane("messagePaneWidth", value, persist)
          }
        />
      ) : settings.readingPane === "bottom" ? (
        <PaneSplitter
          className="reader-bottom-splitter"
          label={strings.mail.resizeReader}
          orientation="horizontal-reverse"
          value={settings.readerPaneHeight}
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
  orientation,
  value,
  onChange,
}: {
  className: string;
  label: string;
  orientation: "vertical" | "horizontal-reverse";
  value: number;
  onChange: (value: number, persist: boolean) => void;
}) {
  return (
    <div
      className={`pane-splitter ${className}`}
      role="separator"
      aria-label={label}
      aria-orientation={orientation === "vertical" ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      onKeyDown={(event) => {
        const decrement =
          orientation === "vertical" ? "ArrowLeft" : "ArrowDown";
        const increment = orientation === "vertical" ? "ArrowRight" : "ArrowUp";
        if (event.key !== decrement && event.key !== increment) return;
        event.preventDefault();
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
}: {
  icon: typeof Inbox;
  label: string;
  count: number;
  active: boolean;
  tone?: "warning";
  onClick: () => void;
}) {
  return (
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
  );
}

function MessageList({
  messages,
  selectedId,
  loading,
  loadingMessageId,
  onChoose,
  hasMore,
  onLoadMore,
}: {
  messages: MessageSummary[];
  selectedId?: number;
  loading: boolean;
  loadingMessageId?: number;
  onChoose: (message: MessageSummary) => Promise<void>;
  hasMore: boolean;
  onLoadMore: () => Promise<void>;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const selected = listRef.current?.querySelector<HTMLElement>(
      "[role='option'][aria-selected='true']",
    );
    if (!selected) return;
    selected.scrollIntoView?.({ block: "nearest" });
    if (listRef.current?.contains(document.activeElement)) selected.focus();
  }, [selectedId]);

  if (loading && messages.length === 0)
    return (
      <div className="list-state" role="status">
        {strings.mail.loadingMessages}
      </div>
    );
  if (messages.length === 0)
    return <div className="list-state">{strings.mail.emptyMailbox}</div>;
  return (
    <div
      ref={listRef}
      className="message-list"
      role="listbox"
      aria-label={strings.mail.messages}
      aria-busy={loading}
    >
      {messages.map((message, index) => (
        <button
          key={message.id}
          type="button"
          role="option"
          aria-selected={selectedId === message.id}
          tabIndex={
            selectedId === message.id || (!selectedId && index === 0) ? 0 : -1
          }
          aria-label={`${message.senderName || message.senderAddress}, ${message.subject || strings.common.noSubject}`}
          className={`message-row ${message.isRead ? "read" : "unread"} ${selectedId === message.id ? "selected" : ""}`}
          onClick={() => void onChoose(message)}
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
            if (next && next.id !== message.id) void onChoose(next);
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
      ))}
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

function DraftList({
  drafts,
  onOpen,
}: {
  drafts: ReturnType<typeof useAppStore.getState>["drafts"];
  onOpen: (id: string) => Promise<void>;
}) {
  if (drafts.length === 0)
    return <div className="list-state">{strings.mail.noDrafts}</div>;
  return (
    <div className="local-mail-list">
      {drafts.map((draft) => (
        <button
          key={draft.id}
          type="button"
          className="local-mail-row"
          onClick={() => void onOpen(draft.id)}
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
  onDiscard,
}: {
  items: ReturnType<typeof useAppStore.getState>["outbox"];
  onRetry: (id: string) => Promise<void>;
  onRetryCopy: (id: string) => Promise<void>;
  onDiscard: (
    id: string,
    state: ReturnType<typeof useAppStore.getState>["outbox"][number]["state"],
  ) => Promise<void>;
}) {
  if (items.length === 0)
    return <div className="list-state">{strings.mail.noQueued}</div>;
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
            <small className="status-label">
              {item.state === "queued"
                ? strings.mail.waitingSend
                : item.state === "sending"
                  ? strings.mail.sending
                  : item.state === "sent_copy_pending"
                    ? strings.mail.sentCopyPending
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
            ) : null}
            <button
              type="button"
              className="danger-button"
              onClick={() => void onDiscard(item.id, item.state)}
            >
              {item.state === "sent_copy_pending"
                ? strings.mail.dismissWarning
                : strings.common.discard}
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
