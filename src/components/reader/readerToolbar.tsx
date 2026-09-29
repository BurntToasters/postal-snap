import type { RefObject } from "react";
import {
  Archive,
  ArrowLeft,
  Clock,
  FolderInput,
  FileText,
  Forward,
  Mail,
  MailMinus,
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
import { folderPathLabel } from "../../i18n/mail";
import type { MailboxSummary, MessageDetail, ReadingPane } from "../../types";
import { folderIcons } from "../mail/folderIcons";
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
  onUnsubscribe,
  onShowOriginal,
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
  onUnsubscribe: () => void;
  onShowOriginal: () => void;
  onToggleMore: () => void;
  onOpenMore: () => void;
  onCloseMore: () => void;
  onDismissMore: () => void;
}) {
  const moveDestinations = mailboxes.filter(
    (mailbox) =>
      mailbox.accountId === message.accountId &&
      mailbox.id !== message.mailboxId &&
      mailbox.role !== "archive" &&
      mailbox.role !== "junk" &&
      mailbox.role !== "trash",
  );
  return (
    <div
      className="reader-actions"
      role="toolbar"
      aria-label={strings.reader.actions}
      data-context="chrome"
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
        {/* Two glass groups (HIG): labeled replies, then symbol actions. */}
        <div className="reader-action-group">
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
            {preparingForward
              ? strings.reader.preparing
              : strings.reader.forward}
          </button>
        </div>
        <div className="reader-action-group">
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
                className="reader-more-menu app-menu"
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
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
