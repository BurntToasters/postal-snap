import type { RefObject } from "react";
import {
  Archive,
  ArrowLeft,
  Clock,
  FolderInput,
  Forward,
  Mail,
  MailOpen,
  MoreHorizontal,
  Printer,
  Reply,
  ReplyAll,
  ShieldAlert,
  ShieldCheck,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { strings } from "../../i18n";
import type { MailboxSummary, MessageDetail, ReadingPane } from "../../types";
import { moveMenuFocus, moveToolbarFocus } from "../toolbarNav";

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
  onReply,
  onReplyAll,
  onForward,
  onArchive,
  onTrash,
  onPrint,
  onToggleRead,
  onToggleStar,
  onMoveJunk,
  onMoveToInbox,
  onMoveToMailbox,
  onOpenSnooze,
  onToggleMore,
  onOpenMore,
  onCloseMore,
  onDismissMore,
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
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onArchive: () => void;
  onTrash: () => void;
  onPrint: () => void;
  onToggleRead: () => void;
  onToggleStar: () => void;
  onMoveJunk: () => void;
  onMoveToInbox: () => void;
  onMoveToMailbox: (mailboxId: number) => void;
  onOpenSnooze: () => void;
  onToggleMore: () => void;
  onOpenMore: () => void;
  onCloseMore: () => void;
  onDismissMore: () => void;
}) {
  return (
    <div
      className="reader-actions"
      role="toolbar"
      aria-label={strings.reader.actions}
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
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
      <div className="reader-unified-actions">
        <button type="button" onClick={onReply}>
          <Reply aria-hidden="true" />
          {strings.reader.reply}
        </button>
        <button type="button" onClick={onReplyAll}>
          <ReplyAll aria-hidden="true" />
          {strings.reader.replyAll}
        </button>
        <button type="button" onClick={onForward} disabled={preparingForward}>
          <Forward aria-hidden="true" />
          {preparingForward ? strings.reader.preparing : strings.reader.forward}
        </button>
        <span className="toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          onClick={onArchive}
          disabled={isArchiveMailbox}
          aria-label={strings.reader.archive}
          title={strings.reader.archive}
        >
          <Archive aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onTrash}
          disabled={isTrashMailbox}
          aria-label={strings.reader.trash}
          title={strings.reader.trash}
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
              className="reader-more-menu"
              role="menu"
              aria-label={strings.reader.moreActions}
              onKeyDownCapture={moveMenuFocus}
            >
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
              <button
                type="button"
                role="menuitem"
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
              </button>
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
              <label className="move-control" title={strings.reader.moveFolder}>
                <FolderInput aria-hidden="true" />
                <select
                  aria-label={strings.reader.moveFolder}
                  value=""
                  onChange={(event) => {
                    const mailboxId = Number(event.target.value);
                    if (mailboxId) {
                      onMoveToMailbox(mailboxId);
                      onDismissMore();
                    }
                  }}
                >
                  <option value="">{strings.reader.move}</option>
                  {mailboxes
                    .filter(
                      (mailbox) =>
                        mailbox.accountId === message.accountId &&
                        mailbox.id !== message.mailboxId,
                    )
                    .map((mailbox) => (
                      <option key={mailbox.id} value={mailbox.id}>
                        {mailbox.displayName}
                      </option>
                    ))}
                </select>
              </label>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
