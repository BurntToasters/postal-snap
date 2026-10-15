import { useLayoutEffect, useRef, type RefObject } from "react";
import {
  AlignLeft,
  Archive,
  ArrowLeft,
  Bell,
  BellOff,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Clock,
  FolderInput,
  FileText,
  FilePen,
  Inbox,
  ListChecks,
  Filter,
  Copy,
  Download,
  CornerUpRight,
  Forward,
  Paperclip,
  Pin,
  PinOff,
  Mail,
  MailMinus,
  SquarePen,
  MailOpen,
  MoreHorizontal,
  Printer,
  Reply,
  Search,
  ReplyAll,
  ShieldAlert,
  ShieldCheck,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { senderDomain } from "../../blockedSenders";
import { withRecentMoveMailbox } from "../../recentMailbox";
import {
  addressMailbox,
  canMuteConversation,
  senderRuleNeedle,
  subjectRuleNeedle,
  senderSearchQuery,
  subjectSearchQuery,
} from "../../contextMenu";
import { shortcutMod, shortcutShiftMod } from "../../format";
import { strings } from "../../i18n";
import { folderPathLabel } from "../../i18n/mail";
import type { MailboxSummary, MessageDetail, ReadingPane } from "../../types";
import { folderIcons } from "../mail/folderIcons";
import { moveMenuFocus, moveToolbarFocus } from "../toolbarNav";

function withShortcut(label: string, keys: string) {
  return `${label} (${keys})`;
}

export function ReaderToolbar({
  message,
  mailboxes,
  readingPane,
  moreOpen,
  moreMenuRef,
  moreTriggerRef,
  preparingForward,
  isArchiveMailbox,
  isTrashMailbox,
  isJunkMailbox,
  onBack,
  onPrevious,
  onNext,
  listPosition,
  onReply,
  onReplyAll,
  onReplyWithoutQuoting,
  onReplyAllWithoutQuoting,
  onReplyToList,
  onReplyWithAttachments,
  onReplyAllWithAttachments,
  onForward,
  onForwardConversation,
  onForwardAsAttachment,
  onRedirect,
  onEditAsNew,
  onArchive,
  onTrash,
  onPrint,
  onPrintConversation,
  onCopyMessageText,
  onCopySubject,
  onCopySenderAddress,
  onCopyRecipients,
  onCopyConversationText,
  onSaveConversationFiles,
  onToggleRead,
  onMarkConversationRead,
  onMarkConversationUnread,
  onArchiveConversation,
  onTrashConversation,
  onDeleteConversation,
  onJunkConversation,
  onMoveConversationToInbox,
  onToggleStar,
  onPin,
  onPinConversation,
  onUnpinConversation,
  onStarConversation,
  onUnstarConversation,
  onSelectConversation,
  onSelectFromSender,
  onOpenEarlier,
  onOlderInConversation,
  onNewerInConversation,
  onUnreadInConversation,
  onMoveJunk,
  onBlockSender,
  senderBlocked = false,
  onUnblockSender,
  onBlockDomain,
  domainBlocked = false,
  onUnblockDomain,
  onMuteConversation,
  onMoveToInbox,
  onMoveToMailbox,
  onMoveConversationToMailbox,
  onCopyToMailbox,
  onCopyConversationToMailbox,
  onOpenSnooze,
  onSnoozeConversation,
  onCreateRule,
  onCreateSubjectRule,
  onMessagesFromSender,
  onComposeToSender,
  onMessagesWithSubject,
  onUnsubscribe,
  onShowOriginal,
  onSaveEml,
  canViewPlain = false,
  viewingPlain = false,
  onTogglePlain,
  onToggleMore,
  onOpenMore,
  onCloseMore,
  onDismissMore,
  windowDrag,
}: {
  message: MessageDetail;
  mailboxes: MailboxSummary[];
  readingPane: ReadingPane;
  moreOpen: boolean;
  moreMenuRef: RefObject<HTMLDivElement | null>;
  moreTriggerRef: RefObject<HTMLButtonElement | null>;
  preparingForward: boolean;
  isArchiveMailbox: boolean;
  isTrashMailbox: boolean;
  isJunkMailbox: boolean;
  onBack: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  listPosition?: { index: number; total: number };
  onReply: () => void;
  onReplyAll: () => void;
  onReplyWithoutQuoting?: () => void;
  onReplyAllWithoutQuoting?: () => void;
  onReplyToList?: () => void;
  onReplyWithAttachments?: () => void;
  onReplyAllWithAttachments?: () => void;
  onForward: () => void;
  onForwardConversation?: () => void;
  onForwardAsAttachment?: () => void;
  onRedirect?: () => void;
  onEditAsNew?: () => void;
  onArchive: () => void;
  onTrash: () => void;
  onPrint: () => void;
  onPrintConversation?: () => void;
  onCopyMessageText: () => void;
  onCopySubject?: () => void;
  onCopySenderAddress?: () => void;
  onCopyRecipients?: () => void;
  onCopyConversationText?: () => void;
  onSaveConversationFiles?: () => void;
  onToggleRead: () => void;
  onMarkConversationRead?: () => void;
  onMarkConversationUnread?: () => void;
  onArchiveConversation?: () => void;
  onTrashConversation?: () => void;
  onDeleteConversation?: () => void;
  onJunkConversation?: () => void;
  onMoveConversationToInbox?: () => void;
  onToggleStar: () => void;
  onPin?: () => void;
  onPinConversation?: () => void;
  onUnpinConversation?: () => void;
  onStarConversation?: () => void;
  onUnstarConversation?: () => void;
  onSelectConversation?: () => void;
  onSelectFromSender?: () => void;
  onOpenEarlier?: () => void;
  onOlderInConversation?: () => void;
  onNewerInConversation?: () => void;
  onUnreadInConversation?: () => void;
  onMoveJunk: () => void;
  onBlockSender?: () => void;
  senderBlocked?: boolean;
  onUnblockSender?: () => void;
  onBlockDomain?: () => void;
  domainBlocked?: boolean;
  onUnblockDomain?: () => void;
  onMuteConversation?: () => void;
  onMoveToInbox: () => void;
  onMoveToMailbox: (mailboxId: number) => void;
  onMoveConversationToMailbox?: (mailboxId: number) => void;
  onCopyToMailbox?: (mailboxId: number) => void;
  onCopyConversationToMailbox?: (mailboxId: number) => void;
  onOpenSnooze: () => void;
  onSnoozeConversation?: () => void;
  onCreateRule: () => void;
  onCreateSubjectRule?: () => void;
  onMessagesFromSender?: () => void;
  onComposeToSender?: () => void;
  onMessagesWithSubject?: () => void;
  onUnsubscribe: () => void;
  onShowOriginal: () => void;
  onSaveEml?: () => void;
  canViewPlain?: boolean;
  viewingPlain?: boolean;
  onTogglePlain?: () => void;
  onToggleMore: () => void;
  onOpenMore: () => void;
  onCloseMore: () => void;
  onDismissMore: () => void;
  windowDrag?: boolean;
}) {
  // Share natural heights without measuring a previously stretched bar.
  const barRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bar = barRef.current;
    const shell = bar?.closest<HTMLElement>(".mail-shell");
    if (!bar || !shell) return;
    const heading =
      readingPane === "right"
        ? shell.querySelector<HTMLElement>(".message-pane .pane-heading")
        : null;
    const nodes = heading ? [bar, heading] : [bar];
    const update = () => {
      const previous = nodes.map((node) => node.style.minHeight);
      for (const node of nodes)
        node.style.minHeight = "var(--pane-heading-height)";
      const height = Math.ceil(
        Math.max(...nodes.map((node) => node.getBoundingClientRect().height)),
      );
      nodes.forEach((node, index) => {
        node.style.minHeight = previous[index];
      });
      if (height > 0)
        shell.style.setProperty("--reader-bar-height", `${height}px`);
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      return () => shell.style.removeProperty("--reader-bar-height");
    }
    let pendingFrame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (pendingFrame !== undefined) return;
      pendingFrame = window.requestAnimationFrame(() => {
        pendingFrame = undefined;
        update();
      });
    });
    for (const node of nodes) {
      observer.observe(node);
      for (const child of node.children) observer.observe(child);
    }
    return () => {
      observer.disconnect();
      if (pendingFrame !== undefined) window.cancelAnimationFrame(pendingFrame);
      shell.style.removeProperty("--reader-bar-height");
    };
  }, [readingPane]);
  const showNav = listPosition
    ? listPosition.total > 1
    : Boolean(onPrevious || onNext);
  const moveDestinations = withRecentMoveMailbox(
    mailboxes.filter(
      (mailbox) =>
        mailbox.accountId === message.accountId &&
        mailbox.id !== message.mailboxId &&
        mailbox.role !== "archive" &&
        mailbox.role !== "junk" &&
        mailbox.role !== "trash" &&
        !(isArchiveMailbox && mailbox.role === "inbox"),
    ),
  );
  return (
    <div
      ref={barRef}
      className="reader-actions"
      role="toolbar"
      aria-label={strings.reader.actions}
      data-context="chrome"
      data-tauri-drag-region={windowDrag ? "deep" : undefined}
      onKeyDown={moveToolbarFocus}
    >
      <button
        className="mobile-reader-back"
        type="button"
        onClick={onBack}
        aria-label={strings.reader.backToList}
      >
        <ArrowLeft aria-hidden="true" />
        {strings.common.back}
      </button>
      {readingPane === "hidden" ? (
        <button
          className="desktop-reader-close"
          type="button"
          onClick={onBack}
          aria-label={strings.reader.closeMessage}
          title={strings.reader.closeMessage}
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
      <div className="reader-unified-actions">
        {/* Replies, then symbol actions; thread navigation last. */}
        <div className="reader-action-group">
          <button
            type="button"
            onClick={onReply}
            title={withShortcut(strings.reader.reply, `${shortcutMod()}R`)}
            aria-keyshortcuts="Meta+R Control+R"
          >
            <Reply aria-hidden="true" />
            {strings.reader.reply}
          </button>
          <button
            type="button"
            onClick={onReplyAll}
            title={withShortcut(
              strings.reader.replyAll,
              `${shortcutShiftMod()}R`,
            )}
            aria-keyshortcuts="Meta+Shift+R Control+Shift+R"
          >
            <ReplyAll aria-hidden="true" />
            {strings.reader.replyAll}
          </button>
          {onReplyToList ? (
            <button type="button" onClick={onReplyToList}>
              <Reply aria-hidden="true" />
              {strings.reader.replyToList}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onForward}
            disabled={preparingForward}
            title={withShortcut(
              preparingForward
                ? strings.reader.preparing
                : strings.reader.forward,
              `${shortcutShiftMod()}F`,
            )}
            aria-keyshortcuts="Meta+Shift+F Control+Shift+F"
          >
            <Forward aria-hidden="true" />
            {preparingForward
              ? strings.reader.preparing
              : strings.reader.forward}
          </button>
        </div>
        <div className="reader-action-group">
          <button
            type="button"
            onClick={onToggleStar}
            aria-pressed={message.isStarred}
            aria-label={
              message.isStarred
                ? strings.reader.removeStar
                : strings.reader.addStar
            }
            title={withShortcut(
              message.isStarred
                ? strings.reader.removeStar
                : strings.reader.addStar,
              `${shortcutShiftMod()}L`,
            )}
            aria-keyshortcuts="Meta+Shift+L Control+Shift+L"
          >
            <Star
              aria-hidden="true"
              fill={message.isStarred ? "currentColor" : "none"}
            />
          </button>
          <button
            type="button"
            onClick={isArchiveMailbox ? onMoveToInbox : onArchive}
            aria-label={
              isArchiveMailbox
                ? strings.reader.moveToInbox
                : strings.reader.archive
            }
            title={
              isArchiveMailbox
                ? strings.reader.moveToInbox
                : withShortcut(strings.reader.archive, `${shortcutMod()}E`)
            }
            aria-keyshortcuts={
              isArchiveMailbox ? undefined : "Meta+E Control+E"
            }
          >
            {isArchiveMailbox ? (
              <Inbox aria-hidden="true" />
            ) : (
              <Archive aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            onClick={onTrash}
            aria-label={
              isTrashMailbox ? strings.mail.deleteForever : strings.reader.trash
            }
            title={withShortcut(
              isTrashMailbox
                ? strings.mail.deleteForever
                : strings.reader.trash,
              isTrashMailbox ? "Delete" : `${shortcutMod()}⌫`,
            )}
            aria-keyshortcuts={
              isTrashMailbox ? "Delete" : "Meta+Backspace Control+Backspace"
            }
          >
            <Trash2 aria-hidden="true" />
          </button>
          <div className="reader-more" ref={moreMenuRef}>
            <button
              ref={moreTriggerRef}
              type="button"
              onClick={onToggleMore}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  onOpenMore();
                }
              }}
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              aria-controls="reader-more-menu"
              aria-label={strings.reader.moreActions}
              title={strings.reader.moreActions}
            >
              <MoreHorizontal aria-hidden="true" />
            </button>
            {moreOpen ? (
              <div
                id="reader-more-menu"
                className="reader-more-menu app-menu"
                role="menu"
                aria-label={strings.reader.moreActions}
                onKeyDownCapture={moveMenuFocus}
              >
                {onReplyWithoutQuoting ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onReplyWithoutQuoting();
                      onCloseMore();
                    }}
                  >
                    <Reply aria-hidden="true" />
                    {strings.reader.replyWithoutQuoting}
                  </button>
                ) : null}
                {onReplyAllWithoutQuoting ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onReplyAllWithoutQuoting();
                      onCloseMore();
                    }}
                  >
                    <ReplyAll aria-hidden="true" />
                    {strings.reader.replyAllWithoutQuoting}
                  </button>
                ) : null}
                {onReplyWithAttachments ? (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={preparingForward}
                    onClick={() => {
                      onReplyWithAttachments();
                      onCloseMore();
                    }}
                  >
                    <Paperclip aria-hidden="true" />
                    {preparingForward
                      ? strings.reader.preparing
                      : strings.reader.replyWithAttachments}
                  </button>
                ) : null}
                {onReplyAllWithAttachments ? (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={preparingForward}
                    onClick={() => {
                      onReplyAllWithAttachments();
                      onCloseMore();
                    }}
                  >
                    <Paperclip aria-hidden="true" />
                    {preparingForward
                      ? strings.reader.preparing
                      : strings.reader.replyAllWithAttachments}
                  </button>
                ) : null}
                {onRedirect ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onRedirect();
                      onCloseMore();
                    }}
                  >
                    <CornerUpRight aria-hidden="true" />
                    {strings.reader.redirect}
                  </button>
                ) : null}
                {onForwardConversation ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onForwardConversation();
                      onCloseMore();
                    }}
                  >
                    <Forward aria-hidden="true" />
                    {strings.reader.forwardConversation}
                  </button>
                ) : null}
                {onForwardAsAttachment ? (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={preparingForward}
                    onClick={() => {
                      onForwardAsAttachment();
                      onCloseMore();
                    }}
                  >
                    <Paperclip aria-hidden="true" />
                    {preparingForward
                      ? strings.reader.preparing
                      : strings.reader.forwardAsAttachment}
                  </button>
                ) : null}
                {onEditAsNew ? (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={preparingForward}
                    onClick={() => {
                      onEditAsNew();
                      onCloseMore();
                    }}
                  >
                    <FilePen aria-hidden="true" />
                    {preparingForward
                      ? strings.reader.preparing
                      : strings.reader.editAsNew}
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onPrint();
                    onCloseMore();
                  }}
                >
                  <Printer aria-hidden="true" />
                  {strings.reader.print}
                </button>
                {onPrintConversation ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onPrintConversation();
                      onCloseMore();
                    }}
                  >
                    <Printer aria-hidden="true" />
                    {strings.reader.printConversation}
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onCopyMessageText();
                    onCloseMore();
                  }}
                >
                  <Copy aria-hidden="true" />
                  {strings.reader.copyMessageText}
                </button>
                {onCopySubject ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onCopySubject();
                      onCloseMore();
                    }}
                  >
                    <Copy aria-hidden="true" />
                    {strings.reader.copySubject}
                  </button>
                ) : null}
                {onCopySenderAddress ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onCopySenderAddress();
                      onCloseMore();
                    }}
                  >
                    <Copy aria-hidden="true" />
                    {strings.reader.copySenderAddress}
                  </button>
                ) : null}
                {onCopyRecipients ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onCopyRecipients();
                      onCloseMore();
                    }}
                  >
                    <Copy aria-hidden="true" />
                    {strings.reader.copyRecipients}
                  </button>
                ) : null}
                {onCopyConversationText ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onCopyConversationText();
                      onCloseMore();
                    }}
                  >
                    <Copy aria-hidden="true" />
                    {strings.reader.copyConversationText}
                  </button>
                ) : null}
                {onSaveConversationFiles ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onSaveConversationFiles();
                      onCloseMore();
                    }}
                  >
                    <Paperclip aria-hidden="true" />
                    {strings.reader.saveConversationFiles}
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  title={withShortcut(
                    message.isRead
                      ? strings.reader.markUnread
                      : strings.reader.markRead,
                    `${shortcutShiftMod()}U`,
                  )}
                  aria-keyshortcuts="Meta+Shift+U Control+Shift+U"
                  onClick={() => {
                    onToggleRead();
                    onCloseMore();
                  }}
                >
                  {message.isRead ? (
                    <Mail aria-hidden="true" />
                  ) : (
                    <MailOpen aria-hidden="true" />
                  )}
                  {message.isRead
                    ? strings.reader.markUnread
                    : strings.reader.markRead}
                  <kbd aria-hidden="true">{`${shortcutShiftMod()}U`}</kbd>
                </button>
                {onMarkConversationRead ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onMarkConversationRead();
                      onCloseMore();
                    }}
                  >
                    <CheckCheck aria-hidden="true" />
                    {strings.reader.markConversationRead}
                  </button>
                ) : null}
                {onMarkConversationUnread ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onMarkConversationUnread();
                      onCloseMore();
                    }}
                  >
                    <Mail aria-hidden="true" />
                    {strings.reader.markConversationUnread}
                  </button>
                ) : null}
                {onArchiveConversation ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onArchiveConversation();
                      onCloseMore();
                    }}
                  >
                    <Archive aria-hidden="true" />
                    {strings.reader.archiveConversation}
                  </button>
                ) : null}
                {onMoveConversationToInbox ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onMoveConversationToInbox();
                      onCloseMore();
                    }}
                  >
                    <Inbox aria-hidden="true" />
                    {strings.reader.moveConversationToInbox}
                  </button>
                ) : null}
                {onTrashConversation ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onTrashConversation();
                      onCloseMore();
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                    {strings.reader.trashConversation}
                  </button>
                ) : null}
                {onDeleteConversation ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onDeleteConversation();
                      onCloseMore();
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                    {strings.reader.deleteConversation}
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onToggleStar();
                    onCloseMore();
                  }}
                >
                  <Star
                    aria-hidden="true"
                    fill={message.isStarred ? "currentColor" : "none"}
                  />
                  {message.isStarred
                    ? strings.reader.removeStar
                    : strings.reader.addStar}
                </button>
                {onStarConversation ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onStarConversation();
                      onCloseMore();
                    }}
                  >
                    <Star aria-hidden="true" />
                    {strings.reader.starConversation}
                  </button>
                ) : null}
                {onUnstarConversation ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onUnstarConversation();
                      onCloseMore();
                    }}
                  >
                    <Star aria-hidden="true" fill="currentColor" />
                    {strings.reader.unstarConversation}
                  </button>
                ) : null}
                {onPin ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onPin();
                      onCloseMore();
                    }}
                  >
                    {message.pinned ? (
                      <PinOff aria-hidden="true" />
                    ) : (
                      <Pin aria-hidden="true" />
                    )}
                    {message.pinned ? strings.reader.unpin : strings.reader.pin}
                  </button>
                ) : null}
                {onPinConversation ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onPinConversation();
                      onCloseMore();
                    }}
                  >
                    <Pin aria-hidden="true" />
                    {strings.reader.pinConversation}
                  </button>
                ) : null}
                {onUnpinConversation ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onUnpinConversation();
                      onCloseMore();
                    }}
                  >
                    <PinOff aria-hidden="true" />
                    {strings.reader.unpinConversation}
                  </button>
                ) : null}
                {onSelectConversation ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onSelectConversation();
                      onCloseMore();
                    }}
                  >
                    <ListChecks aria-hidden="true" />
                    {strings.reader.selectConversation}
                  </button>
                ) : null}
                {onSelectFromSender ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onSelectFromSender();
                      onCloseMore();
                    }}
                  >
                    <ListChecks aria-hidden="true" />
                    {strings.reader.selectFromSender}
                  </button>
                ) : null}
                {onOpenEarlier ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onOpenEarlier();
                      onCloseMore();
                    }}
                  >
                    <Mail aria-hidden="true" />
                    {strings.reader.openEarlier}
                  </button>
                ) : null}
                {onOlderInConversation ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onOlderInConversation();
                      onCloseMore();
                    }}
                  >
                    <ChevronDown aria-hidden="true" />
                    {strings.reader.olderInConversation}
                  </button>
                ) : null}
                {onNewerInConversation ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onNewerInConversation();
                      onCloseMore();
                    }}
                  >
                    <ChevronUp aria-hidden="true" />
                    {strings.reader.newerInConversation}
                  </button>
                ) : null}
                {onUnreadInConversation ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onUnreadInConversation();
                      onCloseMore();
                    }}
                  >
                    <MailOpen aria-hidden="true" />
                    {strings.reader.unreadInConversation}
                  </button>
                ) : null}
                {isJunkMailbox ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onMoveToInbox();
                      onDismissMore();
                    }}
                  >
                    <ShieldCheck aria-hidden="true" />
                    {strings.reader.notJunk}
                  </button>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onMoveJunk();
                      onDismissMore();
                    }}
                  >
                    <ShieldAlert aria-hidden="true" />
                    {strings.reader.junk}
                  </button>
                )}
                {onJunkConversation ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onJunkConversation();
                      onCloseMore();
                    }}
                  >
                    <ShieldAlert aria-hidden="true" />
                    {strings.reader.junkConversation}
                  </button>
                ) : null}
                {senderBlocked &&
                onUnblockSender &&
                senderRuleNeedle(message.senderAddress) ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onUnblockSender();
                      onDismissMore();
                    }}
                  >
                    <ShieldCheck aria-hidden="true" />
                    {strings.reader.unblockSender}
                  </button>
                ) : onBlockSender && senderRuleNeedle(message.senderAddress) ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onBlockSender();
                      onDismissMore();
                    }}
                  >
                    <ShieldAlert aria-hidden="true" />
                    {strings.reader.blockSender}
                  </button>
                ) : null}
                {domainBlocked &&
                onUnblockDomain &&
                senderDomain(message.senderAddress) ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onUnblockDomain();
                      onDismissMore();
                    }}
                  >
                    <ShieldCheck aria-hidden="true" />
                    {strings.reader.unblockDomain}
                  </button>
                ) : onBlockDomain && senderDomain(message.senderAddress) ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onBlockDomain();
                      onDismissMore();
                    }}
                  >
                    <ShieldAlert aria-hidden="true" />
                    {strings.reader.blockDomain}
                  </button>
                ) : null}
                {onMuteConversation && canMuteConversation(message) ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onMuteConversation();
                      onDismissMore();
                    }}
                  >
                    {message.conversationMuted ? (
                      <Bell aria-hidden="true" />
                    ) : (
                      <BellOff aria-hidden="true" />
                    )}
                    {message.conversationMuted
                      ? strings.reader.unmuteConversation
                      : strings.reader.muteConversation}
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onOpenSnooze();
                    onDismissMore();
                  }}
                >
                  <Clock aria-hidden="true" />
                  {strings.reader.snooze}
                </button>
                {onSnoozeConversation ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onSnoozeConversation();
                      onDismissMore();
                    }}
                  >
                    <Clock aria-hidden="true" />
                    {strings.reader.snoozeConversation}
                  </button>
                ) : null}
                {senderRuleNeedle(message.senderAddress) ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onCreateRule();
                      onDismissMore();
                    }}
                  >
                    <Filter aria-hidden="true" />
                    {strings.reader.createRuleFromSender}
                  </button>
                ) : null}
                {onCreateSubjectRule && subjectRuleNeedle(message.subject) ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onCreateSubjectRule();
                      onDismissMore();
                    }}
                  >
                    <Filter aria-hidden="true" />
                    {strings.reader.createRuleFromSubject}
                  </button>
                ) : null}
                {onComposeToSender && addressMailbox(message.senderAddress) ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onComposeToSender();
                      onDismissMore();
                    }}
                  >
                    <SquarePen aria-hidden="true" />
                    {strings.reader.newMessageToSender}
                  </button>
                ) : null}
                {onMessagesFromSender &&
                senderSearchQuery(message.senderAddress) ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onMessagesFromSender();
                      onDismissMore();
                    }}
                  >
                    <Search aria-hidden="true" />
                    {strings.reader.messagesFromSender}
                  </button>
                ) : null}
                {onMessagesWithSubject &&
                subjectSearchQuery(message.subject) ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onMessagesWithSubject();
                      onDismissMore();
                    }}
                  >
                    <Search aria-hidden="true" />
                    {strings.reader.messagesWithSubject}
                  </button>
                ) : null}
                {message.unsubscribe ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onUnsubscribe();
                      onDismissMore();
                    }}
                  >
                    <MailMinus aria-hidden="true" />
                    {strings.reader.unsubscribe}
                  </button>
                ) : null}
                {canViewPlain ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onTogglePlain?.();
                      onDismissMore();
                    }}
                  >
                    <AlignLeft aria-hidden="true" />
                    {viewingPlain
                      ? strings.reader.viewFormatted
                      : strings.reader.viewPlain}
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onShowOriginal();
                    onDismissMore();
                  }}
                >
                  <FileText aria-hidden="true" />
                  {strings.reader.showOriginal}
                </button>
                {onSaveEml ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onSaveEml();
                      onDismissMore();
                    }}
                  >
                    <Download aria-hidden="true" />
                    {strings.reader.saveEml}
                  </button>
                ) : null}
                {moveDestinations.length > 0 ? (
                  // Folders as menu items, like the right-click menu. Archive,
                  // Junk, and Trash already have direct actions above.
                  <>
                    <div className="context-menu-separator" role="separator" />
                    <div role="group" aria-labelledby="reader-move-heading">
                      <div
                        id="reader-move-heading"
                        className="context-menu-heading"
                      >
                        {strings.contextMenu.moveTo}
                      </div>
                      {moveDestinations.map((mailbox) => {
                        const Icon = folderIcons[mailbox.role] ?? FolderInput;
                        const name = folderPathLabel(mailbox);
                        return (
                          <button
                            key={mailbox.id}
                            type="button"
                            role="menuitem"
                            aria-label={strings.contextMenu.moveToFolder(name)}
                            onClick={() => {
                              onMoveToMailbox(mailbox.id);
                              onDismissMore();
                            }}
                          >
                            <Icon aria-hidden="true" />
                            {name}
                          </button>
                        );
                      })}
                    </div>
                    {onMoveConversationToMailbox ? (
                      <div
                        role="group"
                        aria-labelledby="reader-move-conversation-heading"
                      >
                        <div
                          id="reader-move-conversation-heading"
                          className="context-menu-heading"
                        >
                          {strings.contextMenu.moveConversationTo}
                        </div>
                        {moveDestinations.map((mailbox) => {
                          const Icon = folderIcons[mailbox.role] ?? FolderInput;
                          const name = folderPathLabel(mailbox);
                          return (
                            <button
                              key={`move-conversation-${mailbox.id}`}
                              type="button"
                              role="menuitem"
                              aria-label={strings.contextMenu.moveConversationToFolder(
                                name,
                              )}
                              onClick={() => {
                                onMoveConversationToMailbox(mailbox.id);
                                onDismissMore();
                              }}
                            >
                              <Icon aria-hidden="true" />
                              {name}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                    {onCopyToMailbox ? (
                      <div role="group" aria-labelledby="reader-copy-heading">
                        <div
                          id="reader-copy-heading"
                          className="context-menu-heading"
                        >
                          {strings.contextMenu.copyTo}
                        </div>
                        {moveDestinations.map((mailbox) => {
                          const Icon = folderIcons[mailbox.role] ?? FolderInput;
                          const name = folderPathLabel(mailbox);
                          return (
                            <button
                              key={`copy-${mailbox.id}`}
                              type="button"
                              role="menuitem"
                              aria-label={strings.contextMenu.copyToFolder(
                                name,
                              )}
                              onClick={() => {
                                onCopyToMailbox(mailbox.id);
                                onDismissMore();
                              }}
                            >
                              <Icon aria-hidden="true" />
                              {name}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                    {onCopyConversationToMailbox ? (
                      <div
                        role="group"
                        aria-labelledby="reader-copy-conversation-heading"
                      >
                        <div
                          id="reader-copy-conversation-heading"
                          className="context-menu-heading"
                        >
                          {strings.contextMenu.copyConversationTo}
                        </div>
                        {moveDestinations.map((mailbox) => {
                          const Icon = folderIcons[mailbox.role] ?? FolderInput;
                          const name = folderPathLabel(mailbox);
                          return (
                            <button
                              key={`copy-conversation-${mailbox.id}`}
                              type="button"
                              role="menuitem"
                              aria-label={strings.contextMenu.copyConversationToFolder(
                                name,
                              )}
                              onClick={() => {
                                onCopyConversationToMailbox(mailbox.id);
                                onDismissMore();
                              }}
                            >
                              <Icon aria-hidden="true" />
                              {name}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        {showNav ? (
          <div className="reader-action-group reader-nav">
            <button
              type="button"
              onClick={onPrevious}
              disabled={!onPrevious}
              aria-label={strings.reader.previousMessage}
              title={strings.reader.previousMessage}
            >
              <ChevronUp aria-hidden="true" />
            </button>
            {listPosition ? (
              <span
                className="reader-position"
                aria-label={strings.reader.messagePosition(
                  listPosition.index,
                  listPosition.total,
                )}
              >
                {strings.reader.messagePlace(
                  listPosition.index,
                  listPosition.total,
                )}
              </span>
            ) : null}
            <button
              type="button"
              onClick={onNext}
              disabled={!onNext}
              aria-label={strings.reader.nextMessage}
              title={strings.reader.nextMessage}
            >
              <ChevronDown aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
