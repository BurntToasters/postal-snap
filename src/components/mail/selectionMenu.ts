import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type { Mailbox, MessageSummary } from "../../types";
import { folderPathLabel } from "../../i18n/mail";
import { copySelectedMessageText } from "../../copyMessageText";
import { forwardSelectedMessages } from "../../forwardConversation";
import { printSelectedMessages } from "../../printConversation";
import {
  saveSelectedFiles,
  saveSelectedMessages,
} from "../../saveConversation";
import type { MessagePaneHeader } from "./messagePaneChrome";

type AppState = ReturnType<typeof useAppStore.getState>;
type SelectionMenu = NonNullable<
  Parameters<typeof MessagePaneHeader>[0]["selection"]
>;

export interface SelectionMenuCtx {
  activeAccountId: AppState["activeAccountId"];
  activeMailbox: Mailbox | undefined;
  mailboxes: AppState["mailboxes"];
  messages: AppState["messages"];
  listedMessages: MessageSummary[];
  selectedIds: number[];
  selectionAnchor: MutableRefObject<number | undefined>;
  setSelectedIds: Dispatch<SetStateAction<number[]>>;
  setSelectionSnoozeOpen: Dispatch<SetStateAction<boolean>>;
  setError: AppState["setError"];
  closeMailboxMore: () => void;
  bulkFlags: (isRead?: boolean, isStarred?: boolean) => Promise<void>;
  pinSelection: (pinned: boolean) => Promise<void>;
  bulkMove: (role: "archive" | "trash" | "junk" | "inbox") => Promise<void>;
  bulkMoveTo: (mailboxId: number) => Promise<void>;
  bulkCopyTo: (mailboxId: number) => Promise<void>;
}

export function useSelectionMenu(ctx: SelectionMenuCtx): SelectionMenu {
  const {
    activeAccountId,
    activeMailbox,
    mailboxes,
    messages,
    listedMessages,
    selectedIds,
    selectionAnchor,
    setSelectedIds,
    setSelectionSnoozeOpen,
    setError,
    closeMailboxMore,
    bulkFlags,
    pinSelection,
    bulkMove,
    bulkMoveTo,
    bulkCopyTo,
  } = ctx;
  return {
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
    selectUnreadDisabled: !listedMessages.some((message) => !message.isRead),
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
      (message) => selectedIds.includes(message.id) && message.hasAttachments,
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
  };
}
