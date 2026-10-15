import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { api } from "../../api";
import {
  addressMailbox,
  sameSenderMessages,
  senderRuleNeedle,
  type ContextMenuActionDetail,
} from "../../contextMenu";
import { strings } from "../../i18n";
import {
  folderLabel,
  folderParentLabel,
  folderPathLabel,
} from "../../i18n/mail";
import { useAppStore } from "../../store";
import type { MessageSummary } from "../../types";
import { useScheduledOutbox } from "../../hooks/useScheduledOutbox";
import { useSettingsSave } from "../settings/useSettingsSave";
import { readableMessageText } from "../reader/readerUtils";
import { copyLoadedConversation } from "../../copyConversation";
import {
  markLoadedConversationRead,
  markLoadedConversationUnread,
} from "../../markConversation";
import { hideMailbox, pinMailbox, unpinMailbox } from "../../pinnedMailboxes";
import { rememberMoveMailboxId } from "../../recentMailbox";
import { copyLoadedConversationText } from "../../copyMessageText";
import { forwardLoadedConversation } from "../../forwardConversation";
import { pinLoadedMessages } from "../../pinConversation";
import { printLoadedConversation } from "../../printConversation";
import { saveLoadedConversationFiles } from "../../saveConversation";
import { starLoadedConversation } from "../../starConversation";
import { deleteLoadedConversation } from "../../deleteConversation";
import {
  moveLoadedConversation,
  type ConversationMoveRole,
} from "../../moveConversation";
import { beginMessageOpen } from "../../messageOpen";
import { conversationMessages } from "../../threads";

type AppState = ReturnType<typeof useAppStore.getState>;
type Scheduled = ReturnType<typeof useScheduledOutbox>;
type OutboxState = AppState["outbox"][number]["state"];

export interface ContextActionCtx {
  activeAccountId: AppState["activeAccountId"];
  refreshAccount: (accountId: string) => Promise<void>;
  selectAccount: AppState["selectAccount"];
  onOpenSettings: (tab?: "accounts", accountId?: string) => void;
  openComposer: AppState["openComposer"];
  searchAddress: (field: "from" | "to", address: string) => void;
  searchFromSender: (address: string) => void;
  searchSubject: (subject: string) => void;
  chooseMessage: (summary: MessageSummary) => Promise<boolean>;
  selectMessage: AppState["selectMessage"];
  openEarlierMessage: (summary: MessageSummary) => Promise<void>;
  selectionAnchor: MutableRefObject<number | undefined>;
  setSelecting: Dispatch<SetStateAction<boolean>>;
  setSelectedIds: Dispatch<SetStateAction<number[]>>;
  setError: AppState["setError"];
  messageRequest: MutableRefObject<number>;
  searchRequest: MutableRefObject<number>;
  clearQuery: () => void;
  resetListState: () => void;
  selectMailbox: AppState["selectMailbox"];
  selectLocalView: AppState["selectLocalView"];
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  loadMessages: () => Promise<void>;
  markMailboxReadById: (mailboxId: number) => Promise<void>;
  emptyTrashFolders: () => Promise<void>;
  emptyJunkFolders: () => Promise<void>;
  updateSettings: ReturnType<typeof useSettingsSave>["update"];
  openFolderDialog: (
    dialog:
      | { mode: "create"; parentId?: number; parentLabel?: string }
      | { mode: "rename"; id: number; name: string; parentLabel?: string },
  ) => void;
  setMoveFolderId: Dispatch<SetStateAction<number | null>>;
  deleteFolderById: (id: number, label: string) => Promise<void>;
  openDraft: (id: string) => Promise<void>;
  duplicateDraft: (id: string) => Promise<void>;
  discardListedDraft: (id: string) => Promise<void>;
  previewQueued: (id: string) => Promise<void>;
  editQueued: (id: string, state: OutboxState) => Promise<void>;
  retryQueued: (id: string) => Promise<void>;
  retrySentCopy: (id: string) => Promise<void>;
  retryArchiveAfterSend: (id: string) => Promise<void>;
  sendScheduledNow: Scheduled["sendScheduledNow"];
  scheduledSendInFlight: Scheduled["scheduledSendInFlight"];
  discardQueued: (id: string, state: OutboxState) => Promise<void>;
  chooseSnoozed: (summary: MessageSummary) => Promise<void>;
  unsnoozeById: (id: number) => Promise<void>;
}

export function handleContextAction(event: Event, ctx: ContextActionCtx) {
  const {
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
  } = ctx;
  const detail = (event as CustomEvent<ContextMenuActionDetail>).detail;
  if (!detail) return;
  const { id, target } = detail;
  const current = useAppStore.getState();
  if (target.kind === "account") {
    if (!current.accounts.some((account) => account.id === target.accountId))
      return;
    if (id === "get-mail") void refreshAccount(target.accountId);
    if (id === "account-settings") {
      selectAccount(target.accountId);
      onOpenSettings("accounts", activeAccountId);
    }
    return;
  }
  if (target.kind === "address") {
    if (id === "compose-to-address") {
      const mailbox = addressMailbox(target.address);
      if (mailbox) openComposer({ prefill: { to: [mailbox] } });
    }
    if (id === "messages-from-sender") searchAddress("from", target.address);
    if (id === "messages-to-address") searchAddress("to", target.address);
    if (id === "create-address-rule") {
      const mailbox = addressMailbox(target.address);
      const contains = mailbox ? senderRuleNeedle(mailbox) : undefined;
      const accountId =
        current.selectedMessage?.accountId ?? current.activeAccountId;
      if (!contains || !accountId) return;
      const sender = current.selectedMessage?.senderAddress ?? "";
      const field =
        sender.toLowerCase() === contains.toLowerCase() ? "from" : "to";
      window.dispatchEvent(
        new CustomEvent("postal:create-rule", {
          detail: { accountId, contains, field },
        }),
      );
    }
    return;
  }
  if (target.kind === "message") {
    const summary = current.messages.find((row) => row.id === target.messageId);
    if (!summary) return;
    if (id === "compose-to-sender") {
      const mailbox = addressMailbox(summary.senderAddress);
      if (mailbox) openComposer({ prefill: { to: [mailbox] } });
      return;
    }
    if (id === "messages-from-sender") {
      searchFromSender(summary.senderAddress);
      return;
    }
    if (id === "messages-with-subject") {
      searchSubject(summary.subject);
      return;
    }
    if (
      id === "archive-conversation" ||
      id === "trash-conversation" ||
      id === "junk-conversation" ||
      id === "move-conversation-inbox"
    ) {
      const role: ConversationMoveRole =
        id === "trash-conversation"
          ? "trash"
          : id === "junk-conversation"
            ? "junk"
            : id === "move-conversation-inbox"
              ? "inbox"
              : "archive";
      void moveLoadedConversation(summary, role, (next, openWasMoved) => {
        if (!openWasMoved) return;
        if (next) void chooseMessage(next);
        else {
          beginMessageOpen();
          selectMessage(undefined);
        }
      });
      return;
    }
    if (id.startsWith("move-conversation:")) {
      const mailboxId = Number(id.slice("move-conversation:".length));
      if (!Number.isFinite(mailboxId)) return;
      rememberMoveMailboxId(current.mailboxes, mailboxId);
      void moveLoadedConversation(summary, mailboxId, (next, openWasMoved) => {
        if (!openWasMoved) return;
        if (next) void chooseMessage(next);
        else {
          beginMessageOpen();
          selectMessage(undefined);
        }
      });
      return;
    }
    if (id === "delete-conversation") {
      void deleteLoadedConversation(summary, (next, openWasDeleted) => {
        if (!openWasDeleted) return;
        if (next) void chooseMessage(next);
        else {
          beginMessageOpen();
          selectMessage(undefined);
        }
      });
      return;
    }
    if (id === "open-earlier") {
      void openEarlierMessage(summary);
      return;
    }
    if (id === "select-from-sender") {
      const ids = sameSenderMessages(
        current.messages,
        summary.senderAddress,
      ).map((item) => item.id);
      if (ids.length < 2) return;
      selectionAnchor.current = ids[0];
      setSelecting(true);
      if (ids.length > 200) {
        setError(strings.mail.bulkTooMany);
        setSelectedIds(ids.slice(0, 200));
        return;
      }
      setSelectedIds(ids);
      return;
    }
    if (id === "select-conversation") {
      const ids = conversationMessages(current.messages, summary).map(
        (item) => item.id,
      );
      if (ids.length < 2) return;
      selectionAnchor.current = ids[0];
      setSelecting(true);
      if (ids.length > 200) {
        setError(strings.mail.bulkTooMany);
        setSelectedIds(ids.slice(0, 200));
        return;
      }
      setSelectedIds(ids);
      return;
    }
    if (id === "forward-conversation") {
      void forwardLoadedConversation(summary);
      return;
    }
    if (id === "print-conversation") {
      void printLoadedConversation(summary);
      return;
    }
    if (id.startsWith("copy-conversation:")) {
      const mailboxId = Number(id.slice("copy-conversation:".length));
      if (Number.isFinite(mailboxId)) {
        rememberMoveMailboxId(current.mailboxes, mailboxId);
        void copyLoadedConversation(summary, mailboxId);
      }
      return;
    }
    if (id === "save-conversation-files") {
      void saveLoadedConversationFiles(summary);
      return;
    }
    if (id === "copy-conversation-text") {
      void copyLoadedConversationText(summary);
      return;
    }
    if (id === "copy-subject") {
      const subject = summary.subject.trim();
      if (subject)
        void navigator.clipboard.writeText(subject).catch(() => undefined);
      return;
    }
    if (id === "copy-sender-address") {
      const address = addressMailbox(summary.senderAddress);
      if (address)
        void navigator.clipboard.writeText(address).catch(() => undefined);
      return;
    }
    if (id === "copy-message-text") {
      void (async () => {
        try {
          const loaded = await api.getMessage(summary.accountId, summary.id);
          const text = readableMessageText(loaded);
          if (text) await navigator.clipboard.writeText(text);
        } catch {
          // The message stays in place when the body or clipboard is unavailable.
        }
      })();
      return;
    }
    if (id === "star-conversation" || id === "unstar-conversation") {
      void starLoadedConversation(summary, id === "star-conversation");
      return;
    }
    if (id === "pin" || id === "unpin") {
      void pinLoadedMessages(summary, id === "pin");
      return;
    }
    if (id === "pin-conversation" || id === "unpin-conversation") {
      void pinLoadedMessages(summary, id === "pin-conversation", true);
      return;
    }
    if (id === "mark-conversation-read") {
      void markLoadedConversationRead(summary);
      return;
    }
    if (id === "mark-conversation-unread") {
      void markLoadedConversationUnread(summary);
      return;
    }
    void (async () => {
      const opened = await chooseMessage(summary);
      if (!opened) return;
      if (id === "toggle-read" && !summary.isRead) return;
      if (id === "snooze") {
        window.dispatchEvent(new Event("postal:open-snooze"));
        return;
      }
      if (id === "snooze-conversation") {
        window.dispatchEvent(new Event("postal:open-snooze-conversation"));
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
      if (id.startsWith("copy-mailbox:")) {
        window.dispatchEvent(
          new CustomEvent("postal:copy-mailbox", {
            detail: Number(id.slice("copy-mailbox:".length)),
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
    if (id === "get-mail") {
      const accountId = current.activeAccountId;
      if (accountId) void refreshAccount(accountId);
      return;
    }
    if (id === "mark-all-read") {
      if (mailbox.unreadCount === 0) return;
      void markMailboxReadById(mailbox.id);
      return;
    }
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
    if (id === "hide-folder" || id === "show-folder") {
      const accountId = current.activeAccountId;
      if (!accountId) return;
      if (id === "show-folder") {
        void updateSettings({
          hiddenMailboxes: unpinMailbox(
            current.settings.hiddenMailboxes,
            accountId,
            mailbox.id,
          ),
        });
        return;
      }
      const next = hideMailbox(
        current.settings.hiddenMailboxes,
        accountId,
        mailbox,
      );
      if (!next) return;
      void updateSettings({
        hiddenMailboxes: next,
        pinnedMailboxes: unpinMailbox(
          current.settings.pinnedMailboxes,
          accountId,
          mailbox.id,
        ),
      });
      return;
    }
    if (id === "pin-folder" || id === "unpin-folder") {
      const accountId = current.activeAccountId;
      if (!accountId) return;
      const next =
        id === "pin-folder"
          ? pinMailbox(current.settings.pinnedMailboxes, accountId, mailbox.id)
          : unpinMailbox(
              current.settings.pinnedMailboxes,
              accountId,
              mailbox.id,
            );
      if (next) void updateSettings({ pinnedMailboxes: next });
      return;
    }
    if (id === "new-subfolder") {
      if (!mailbox.delimiter) return;
      openFolderDialog({
        mode: "create",
        parentId: mailbox.id,
        parentLabel: folderPathLabel(mailbox),
      });
      return;
    }
    if (id === "move-folder") {
      if (mailbox.role !== "other") return;
      setMoveFolderId(mailbox.id);
      return;
    }
    if (id === "rename-folder") {
      openFolderDialog({
        mode: "rename",
        id: mailbox.id,
        name: folderLabel(mailbox),
        parentLabel: folderParentLabel(mailbox),
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
  if (target.kind === "draft" && id === "duplicate-draft") {
    void duplicateDraft(target.draftId);
    return;
  }
  if (target.kind === "draft" && id === "delete-draft") {
    void discardListedDraft(target.draftId);
    return;
  }
  if (target.kind === "outbox") {
    const row = current.outbox.find((entry) => entry.id === target.outboxId);
    if (!row) return;
    if (id === "open") void previewQueued(row.id);
    if (id === "edit") void editQueued(row.id, row.state);
    if (id === "retry") void retryQueued(row.id);
    if (id === "retry-copy") void retrySentCopy(row.id);
    if (id === "retry-archive") void retryArchiveAfterSend(row.id);
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
}
