import { useLayoutEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  FolderInput,
  Inbox,
  Forward,
  Ellipsis,
  Reply,
  ReplyAll,
  Star,
  Trash,
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
import { formatChord, withChord } from "../../format";
import { strings } from "../../i18n";
import { folderPathLabel } from "../../i18n/mail";
import type { MailboxSummary, MessageDetail, ReadingPane } from "../../types";
import { folderIcons } from "../mail/folderIcons";
import { PopupEntries, type PopupEntry } from "../ContextMenu";
import { iconFor } from "../menuIcons";
import {
  buildMessageMenu,
  type FolderKind,
  type MenuKit,
  type MessageMenuFacts,
} from "../../menuModel";
import { placeAnchoredMenu, syncScrollCue } from "../popupPlacement";
import { moveMenuFocus, moveToolbarFocus } from "../toolbarNav";
import type { ReaderToolbarActions } from "./readerActions";

export function ReaderToolbar({
  actions,
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
  listPosition,
  senderBlocked = false,
  domainBlocked = false,
  canViewPlain = false,
  viewingPlain = false,
  windowDrag,
}: {
  actions: ReaderToolbarActions;
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
  listPosition?: { index: number; total: number };
  senderBlocked?: boolean;
  domainBlocked?: boolean;
  canViewPlain?: boolean;
  viewingPlain?: boolean;
  windowDrag?: boolean;
}) {
  const {
    onBack,
    onPrevious,
    onNext,
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
    onUnblockSender,
    onBlockDomain,
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
    onTogglePlain,
    onToggleMore,
    onOpenMore,
    onCloseMore,
    onDismissMore,
  } = actions;

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
  // Keep the More menu inside the viewport: fixed placement beside the
  // trigger, flipped above when there is no room, scrolling inside.
  const menuNodeRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!moreOpen) return;
    const menu = menuNodeRef.current;
    const trigger = moreTriggerRef.current;
    if (!menu || !trigger) return;
    const update = () => placeAnchoredMenu(menu, trigger);
    update();
    window.addEventListener("resize", update);
    const onScroll = (event: Event) => {
      // Ignore the menu's own scrolling; re-placing would reset it.
      if (event.target instanceof Node && menu.contains(event.target)) return;
      update();
    };
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [moreOpen, moreTriggerRef]);
  const showNav = listPosition
    ? listPosition.total > 1
    : Boolean(onPrevious || onNext);
  // Conversation rows exist only when some conversation action is wired.
  const hasConversationActions = [
    onMoveConversationToMailbox,
    onCopyConversationToMailbox,
    onArchiveConversation,
    onTrashConversation,
    onDeleteConversation,
    onJunkConversation,
    onMoveConversationToInbox,
    onMarkConversationRead,
    onMarkConversationUnread,
    onStarConversation,
    onUnstarConversation,
    onPinConversation,
    onUnpinConversation,
    onSelectConversation,
    onSnoozeConversation,
    onSaveConversationFiles,
    onPrintConversation,
    onForwardConversation,
    onCopyConversationText,
  ].some(Boolean);
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
  // Same ordered groups as the row context menu (src/menuModel.ts). The kit
  // drops entries whose handler this surface does not supply.
  const handlers: Record<string, (() => void) | undefined> = {
    "reply-bare": onReplyWithoutQuoting,
    "reply-all-bare": onReplyAllWithoutQuoting,
    "reply-with-attachments": onReplyWithAttachments,
    "reply-all-with-attachments": onReplyAllWithAttachments,
    redirect: onRedirect,
    "edit-as-new": onEditAsNew,
    "compose-to-sender": onComposeToSender,
    "forward-conversation": onForwardConversation,
    "forward-attachment": onForwardAsAttachment,
    "copy-message-text": onCopyMessageText,
    "copy-subject": onCopySubject,
    "copy-sender-address": onCopySenderAddress,
    "copy-recipients": onCopyRecipients,
    "copy-conversation-text": onCopyConversationText,
    print: onPrint,
    "print-conversation": onPrintConversation,
    "save-eml": onSaveEml,
    "toggle-read": onToggleRead,
    "toggle-star": onToggleStar,
    pin: onPin,
    unpin: onPin,
    snooze: onOpenSnooze,
    "mute-conversation": onMuteConversation,
    "not-junk": onMoveToInbox,
    archive: onArchive,
    "move-to-inbox": onMoveToInbox,
    trash: onTrash,
    "delete-forever": onTrash,
    junk: onMoveJunk,
    "mark-conversation-read": onMarkConversationRead,
    "mark-conversation-unread": onMarkConversationUnread,
    "star-conversation": onStarConversation,
    "unstar-conversation": onUnstarConversation,
    "pin-conversation": onPinConversation,
    "unpin-conversation": onUnpinConversation,
    "select-conversation": onSelectConversation,
    "snooze-conversation": onSnoozeConversation,
    "older-in-conversation": onOlderInConversation,
    "newer-in-conversation": onNewerInConversation,
    "unread-in-conversation": onUnreadInConversation,
    "archive-conversation": onArchiveConversation,
    "move-conversation-inbox": onMoveConversationToInbox,
    "junk-conversation": onJunkConversation,
    "trash-conversation": onTrashConversation,
    "delete-conversation": onDeleteConversation,
    "save-conversation-files": onSaveConversationFiles,
    "select-from-sender": onSelectFromSender,
    "open-earlier": onOpenEarlier,
    "create-rule": onCreateRule,
    "create-subject-rule": onCreateSubjectRule,
    "messages-from-sender": onMessagesFromSender,
    "messages-with-subject": onMessagesWithSubject,
    "block-sender": onBlockSender,
    "unblock-sender": onUnblockSender,
    "block-domain": onBlockDomain,
    "unblock-domain": onUnblockDomain,
    unsubscribe: onUnsubscribe,
    "view-plain": onTogglePlain,
    "show-original": onShowOriginal,
  };
  const folderHandlers: Record<
    FolderKind,
    ((mailboxId: number) => void) | undefined
  > = {
    move: onMoveToMailbox,
    "move-conversation": onMoveConversationToMailbox,
    copy: onCopyToMailbox,
    "copy-conversation": onCopyConversationToMailbox,
  };
  const folderIdPrefix: Record<FolderKind, string> = {
    move: "move",
    "move-conversation": "move-conversation",
    copy: "copy",
    "copy-conversation": "copy-conversation",
  };
  const folderAria: Record<FolderKind, (name: string) => string> = {
    move: strings.contextMenu.moveToFolder,
    "move-conversation": strings.contextMenu.moveConversationToFolder,
    copy: strings.contextMenu.copyToFolder,
    "copy-conversation": strings.contextMenu.copyConversationToFolder,
  };
  const readerKit: MenuKit<PopupEntry> = {
    item: (def) => {
      const run = handlers[def.id];
      if (!run) return [];
      return [
        {
          kind: "action",
          id: def.id,
          label: def.label,
          icon: iconFor(def.icon),
          ariaLabel: def.ariaLabel,
          chord: def.chord,
          disabled: def.disabled,
          danger: def.danger,
          onSelect: () => {
            run();
            if (def.dismiss) onDismissMore();
            else onCloseMore();
          },
        },
      ];
    },
    folder: (kind, folder) => {
      const run = folderHandlers[kind];
      if (!run) return [];
      return [
        {
          kind: "action",
          id: `${folderIdPrefix[kind]}-${folder.id}`,
          label: folder.name,
          icon: folderIcons[folder.role] ?? FolderInput,
          ariaLabel: folderAria[kind](folder.name),
          onSelect: () => {
            run(folder.id);
            onDismissMore();
          },
        },
      ];
    },
    group: (label, entries, hideHeading) => [
      { kind: "group", label, hideHeading, entries },
    ],
    submenu: (id, label, entries) => [{ kind: "submenu", id, label, entries }],
    separator: () => [{ kind: "separator" }],
  };
  // Junk wins so "Not junk" stays reachable when flags overlap.
  const mailboxRole = isJunkMailbox
    ? "junk"
    : isTrashMailbox
      ? "trash"
      : isArchiveMailbox
        ? "archive"
        : "other";
  const facts: MessageMenuFacts = {
    isRead: message.isRead,
    isStarred: message.isStarred,
    pinned: Boolean(message.pinned),
    canMute: canMuteConversation(message),
    conversationMuted: Boolean(message.conversationMuted),
    mailboxRole,
    // Handler presence gates the conversation entries on this surface.
    conversation: hasConversationActions,
    conversationUnread: Boolean(onMarkConversationRead),
    conversationRead: Boolean(onMarkConversationUnread),
    conversationHasUnstarred: Boolean(onStarConversation),
    conversationHasUnpinned: Boolean(onPinConversation),
    conversationHasAttachments: true,
    hasAttachments: true,
    hasSender: Boolean(addressMailbox(message.senderAddress)),
    hasSubject: true,
    hasRecipients: true,
    senderRule: Boolean(senderRuleNeedle(message.senderAddress)),
    subjectRule: Boolean(subjectRuleNeedle(message.subject)),
    senderSearch: Boolean(senderSearchQuery(message.senderAddress)),
    subjectSearch: Boolean(subjectSearchQuery(message.subject)),
    selectFromSender: true,
    openEarlier: true,
    blockSender: senderRuleNeedle(message.senderAddress)
      ? senderBlocked
        ? "unblock"
        : "block"
      : undefined,
    blockDomain: senderDomain(message.senderAddress)
      ? domainBlocked
        ? "unblock"
        : "block"
      : undefined,
    unsubscribe: Boolean(message.unsubscribe),
    plainToggle:
      canViewPlain && onTogglePlain
        ? viewingPlain
          ? "formatted"
          : "view"
        : undefined,
    showOriginal: true,
    conversationNav: true,
    preparing: preparingForward,
    moveFolders: moveDestinations.map((box) => ({
      id: box.id,
      name: folderPathLabel(box),
      role: box.role,
    })),
    // Archive and trash sit on the toolbar, so More omits them.
    inToolbar: { primary: true, archiveTrash: true },
  };
  const moreEntries: PopupEntry[] = buildMessageMenu(facts, readerKit);

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
          className="desktop-reader-close reader-icon-action"
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
            className="reader-reply-action"
            onClick={onReply}
            aria-label={strings.reader.reply}
            title={withChord(strings.reader.reply, formatChord("R"))}
            aria-keyshortcuts="Meta+R Control+R"
          >
            <Reply aria-hidden="true" />
            <span className="reader-action-label">{strings.reader.reply}</span>
          </button>
          <button
            type="button"
            className="reader-reply-action"
            onClick={onReplyAll}
            aria-label={strings.reader.replyAll}
            title={withChord(
              strings.reader.replyAll,
              formatChord("R", { shift: true }),
            )}
            aria-keyshortcuts="Meta+Shift+R Control+Shift+R"
          >
            <ReplyAll aria-hidden="true" />
            <span className="reader-action-label">
              {strings.reader.replyAll}
            </span>
          </button>
          {onReplyToList ? (
            <button
              type="button"
              className="reader-reply-action"
              onClick={onReplyToList}
              aria-label={strings.reader.replyToList}
              title={strings.reader.replyToList}
            >
              <Reply aria-hidden="true" />
              <span className="reader-action-label">
                {strings.reader.replyToList}
              </span>
            </button>
          ) : null}
          <button
            type="button"
            className="reader-reply-action"
            onClick={onForward}
            disabled={preparingForward}
            aria-label={
              preparingForward
                ? strings.reader.preparing
                : strings.reader.forward
            }
            title={withChord(
              preparingForward
                ? strings.reader.preparing
                : strings.reader.forward,
              formatChord("F", { shift: true }),
            )}
            aria-keyshortcuts="Meta+Shift+F Control+Shift+F F"
          >
            <Forward aria-hidden="true" />
            <span className="reader-action-label">
              {preparingForward
                ? strings.reader.preparing
                : strings.reader.forward}
            </span>
          </button>
        </div>
        <div className="reader-action-group">
          <button
            type="button"
            className="reader-icon-action"
            onClick={onToggleStar}
            aria-pressed={message.isStarred}
            aria-label={
              message.isStarred
                ? strings.reader.removeStar
                : strings.reader.addStar
            }
            title={withChord(
              message.isStarred
                ? strings.reader.removeStar
                : strings.reader.addStar,
              formatChord("L", { shift: true }),
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
            className="reader-icon-action"
            onClick={isArchiveMailbox ? onMoveToInbox : onArchive}
            aria-label={
              isArchiveMailbox
                ? strings.reader.moveToInbox
                : strings.reader.archive
            }
            title={
              isArchiveMailbox
                ? strings.reader.moveToInbox
                : withChord(strings.reader.archive, formatChord("E"))
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
            className="reader-icon-action"
            onClick={onTrash}
            aria-label={
              isTrashMailbox ? strings.mail.deleteForever : strings.reader.trash
            }
            title={withChord(
              isTrashMailbox
                ? strings.mail.deleteForever
                : strings.reader.trash,
              isTrashMailbox ? "Delete" : formatChord("⌫"),
            )}
            aria-keyshortcuts={
              isTrashMailbox ? "Delete" : "Meta+Backspace Control+Backspace"
            }
          >
            <Trash aria-hidden="true" />
          </button>
          <div className="reader-more">
            <button
              ref={moreTriggerRef}
              type="button"
              className="reader-icon-action"
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
              <Ellipsis aria-hidden="true" />
            </button>
            {moreOpen
              ? createPortal(
                  <div
                    ref={(node) => {
                      menuNodeRef.current = node;
                      moreMenuRef.current = node;
                    }}
                    id="reader-more-menu"
                    className="reader-more-menu app-menu"
                    role="menu"
                    aria-label={strings.reader.moreActions}
                    onKeyDown={moveMenuFocus}
                    onScroll={(event) => syncScrollCue(event.currentTarget)}
                  >
                    <PopupEntries entries={moreEntries} />
                  </div>,
                  document.body,
                )
              : null}
          </div>
        </div>
        {showNav ? (
          <div className="reader-action-group reader-nav">
            <button
              type="button"
              className="reader-icon-action"
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
              className="reader-icon-action"
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
