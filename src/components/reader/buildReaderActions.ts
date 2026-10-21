import type { Dispatch, SetStateAction } from "react";
import { api } from "../../api";
import {
  CONTEXT_ACTION_EVENT,
  addressMailbox,
  earlierHeaderId,
  senderRuleNeedle,
  subjectRuleNeedle,
} from "../../contextMenu";
import { blockableDomain, canBlockSender } from "../../blockedSenders";
import { copyLoadedConversation } from "../../copyConversation";
import { copyLoadedConversationText } from "../../copyMessageText";
import { forwardLoadedConversation } from "../../forwardConversation";
import {
  markLoadedConversationRead,
  markLoadedConversationUnread,
} from "../../markConversation";
import { pinLoadedMessages } from "../../pinConversation";
import { printLoadedConversation } from "../../printConversation";
import { rememberMoveMailboxId } from "../../recentMailbox";
import { saveLoadedConversationFiles } from "../../saveConversation";
import { starLoadedConversation } from "../../starConversation";
import type {
  AccountSummary,
  MailboxSummary,
  MessageDetail,
} from "../../types";
import type { useAppStore } from "../../store";
import {
  listPostAddress,
  messageSelectionQuote,
  preferredReplyMode,
} from "../composer/composerSeed";
import type { ReaderToolbarActions } from "./readerActions";
import { recipientLines } from "./readerUtils";
import type { useReaderCompose } from "./useReaderCompose";
import type { useReaderFlags } from "./useReaderFlags";
import type { useReaderMoves } from "./useReaderMoves";
import { readerAccount, type useSenderRules } from "./useSenderRules";

type Store = ReturnType<typeof useAppStore.getState>;
type Compose = ReturnType<typeof useReaderCompose>;
type Flags = ReturnType<typeof useReaderFlags>;
type Moves = ReturnType<typeof useReaderMoves>;
type SenderRules = ReturnType<typeof useSenderRules>;

// Builds the toolbar callbacks from MessageReader state; call after the early returns.
export interface ReaderActionSources {
  message: MessageDetail;
  accounts: AccountSummary[];
  mailboxes: MailboxSummary[];
  replyToAll: boolean;
  openComposer: Store["openComposer"];
  setError: Store["setError"];
  sanitizedHtml: string | undefined;
  currentLoadedHtml: string | undefined;
  showHtml: boolean;
  isArchiveMailbox: boolean;
  isTrashMailbox: boolean;
  isJunkMailbox: boolean;
  canMoveConversation: boolean;
  canSaveConversationFiles: boolean;
  canMarkConversationRead: boolean;
  canMarkConversationUnread: boolean;
  canStarConversation: boolean;
  canUnstarConversation: boolean;
  canPinConversation: boolean;
  canUnpinConversation: boolean;
  canSelectFromSender: boolean;
  closeOpenMessage: () => void;
  closeMoreMenu: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  onOlderInConversation?: () => void;
  onNewerInConversation?: () => void;
  onUnreadInConversation?: () => void;
  onMessagesFromSender?: (address: string) => void;
  onMessagesWithSubject?: (subject: string) => void;
  replyWithAttachments: Compose["replyWithAttachments"];
  forwardMessage: Compose["forwardMessage"];
  forwardAsAttachment: Compose["forwardAsAttachment"];
  redirectMessage: Compose["redirectMessage"];
  editAsNewMessage: Compose["editAsNewMessage"];
  printMessage: () => void;
  copyReadableText: () => Promise<void>;
  copyRecipients: () => Promise<void>;
  setRead: Flags["setRead"];
  setStarred: Flags["setStarred"];
  move: Moves["move"];
  deleteForever: Moves["deleteForever"];
  muteConversation: Moves["muteConversation"];
  deleteConversation: Moves["deleteConversation"];
  moveConversation: Moves["moveConversation"];
  moveToMailbox: Moves["moveToMailbox"];
  copyToMailbox: Moves["copyToMailbox"];
  blockSender: SenderRules["blockSender"];
  blockDomain: SenderRules["blockDomain"];
  unblockDomain: SenderRules["unblockDomain"];
  unblockSender: SenderRules["unblockSender"];
  unsubscribe: () => Promise<void>;
  setSnoozeConversation: Dispatch<SetStateAction<boolean>>;
  setSnoozeOpen: Dispatch<SetStateAction<boolean>>;
  setOriginalOpen: Dispatch<SetStateAction<boolean>>;
  setPlainMessageId: Dispatch<SetStateAction<number | undefined>>;
  setMoreOpen: Dispatch<SetStateAction<boolean>>;
}

export function buildReaderActions(
  sources: ReaderActionSources,
): ReaderToolbarActions {
  const {
    message,
    accounts,
    mailboxes,
    replyToAll,
    openComposer,
    setError,
    sanitizedHtml,
    currentLoadedHtml,
    showHtml,
    isArchiveMailbox,
    isTrashMailbox,
    isJunkMailbox,
    canMoveConversation,
    canSaveConversationFiles,
    canMarkConversationRead,
    canMarkConversationUnread,
    canStarConversation,
    canUnstarConversation,
    canPinConversation,
    canUnpinConversation,
    canSelectFromSender,
    closeOpenMessage,
    closeMoreMenu,
    onPrevious,
    onNext,
    onOlderInConversation,
    onNewerInConversation,
    onUnreadInConversation,
    onMessagesFromSender,
    onMessagesWithSubject,
    replyWithAttachments,
    forwardMessage,
    forwardAsAttachment,
    redirectMessage,
    editAsNewMessage,
    printMessage,
    copyReadableText,
    copyRecipients,
    setRead,
    setStarred,
    move,
    deleteForever,
    muteConversation,
    deleteConversation,
    moveConversation,
    moveToMailbox,
    copyToMailbox,
    blockSender,
    blockDomain,
    unblockDomain,
    unblockSender,
    unsubscribe,
    setSnoozeConversation,
    setSnoozeOpen,
    setOriginalOpen,
    setPlainMessageId,
    setMoreOpen,
  } = sources;

  return {
    onBack: closeOpenMessage,
    onPrevious,
    onNext,
    onReply: () => {
      const account = accounts.find((item) => item.id === message.accountId);
      openComposer({
        sourceMessage: message,
        composeMode: preferredReplyMode(
          message,
          replyToAll,
          account?.email ?? "",
          account?.aliases ?? [],
        ),
        quoteExcerpt: messageSelectionQuote(),
      });
    },
    onReplyAll: () =>
      openComposer({
        sourceMessage: message,
        composeMode: "replyAll",
        quoteExcerpt: messageSelectionQuote(),
      }),
    onReplyWithoutQuoting: () =>
      openComposer({
        sourceMessage: message,
        composeMode: "reply",
        omitQuote: true,
      }),
    onReplyAllWithoutQuoting: () =>
      openComposer({
        sourceMessage: message,
        composeMode: "replyAll",
        omitQuote: true,
      }),
    onReplyToList: listPostAddress(message.listPost)
      ? () =>
          openComposer({
            sourceMessage: message,
            composeMode: "replyList",
            quoteExcerpt: messageSelectionQuote(),
          })
      : undefined,
    onReplyWithAttachments: message.attachments.some((item) => !item.inline)
      ? () => void replyWithAttachments("reply")
      : undefined,
    onReplyAllWithAttachments: message.attachments.some((item) => !item.inline)
      ? () => void replyWithAttachments("replyAll")
      : undefined,
    onForward: () => void forwardMessage(),
    onForwardConversation: canMoveConversation
      ? () => void forwardLoadedConversation(message)
      : undefined,
    onForwardAsAttachment: () => void forwardAsAttachment(),
    onRedirect: redirectMessage,
    onEditAsNew: () => void editAsNewMessage(),
    onArchive: () => void move("archive"),
    onTrash: () => {
      if (isTrashMailbox) void deleteForever();
      else void move("trash");
    },
    onPrint: printMessage,
    onPrintConversation: canMoveConversation
      ? () =>
          void printLoadedConversation(message, {
            messageId: message.id,
            html: showHtml ? (currentLoadedHtml ?? sanitizedHtml) : undefined,
          })
      : undefined,
    onCopyMessageText: () => void copyReadableText(),
    onCopySubject: message.subject.trim()
      ? () =>
          void navigator.clipboard
            .writeText(message.subject.trim())
            .catch(() => undefined)
      : undefined,
    onCopySenderAddress: addressMailbox(message.senderAddress)
      ? () =>
          void navigator.clipboard
            .writeText(addressMailbox(message.senderAddress) ?? "")
            .catch(() => undefined)
      : undefined,
    onCopyRecipients:
      message && recipientLines(message.to, message.cc, message.bcc)
        ? () => void copyRecipients()
        : undefined,
    onCopyConversationText: canMoveConversation
      ? () => void copyLoadedConversationText(message)
      : undefined,
    onSaveConversationFiles: canSaveConversationFiles
      ? () => void saveLoadedConversationFiles(message)
      : undefined,
    onToggleRead: () => void setRead(),
    onMarkConversationRead: canMarkConversationRead
      ? () => void markLoadedConversationRead(message)
      : undefined,
    onMarkConversationUnread: canMarkConversationUnread
      ? () => void markLoadedConversationUnread(message)
      : undefined,
    onArchiveConversation:
      canMoveConversation && !isArchiveMailbox
        ? () => moveConversation("archive")
        : undefined,
    onTrashConversation:
      canMoveConversation && !isTrashMailbox
        ? () => moveConversation("trash")
        : undefined,
    onDeleteConversation:
      canMoveConversation && isTrashMailbox
        ? () => deleteConversation()
        : undefined,
    onJunkConversation:
      canMoveConversation && !isJunkMailbox
        ? () => moveConversation("junk")
        : undefined,
    onMoveConversationToInbox:
      canMoveConversation && (isArchiveMailbox || isJunkMailbox)
        ? () => moveConversation("inbox")
        : undefined,
    onToggleStar: () => void setStarred(),
    onStarConversation: canStarConversation
      ? () => void starLoadedConversation(message, true)
      : undefined,
    onUnstarConversation: canUnstarConversation
      ? () => void starLoadedConversation(message, false)
      : undefined,
    onPin: () => void pinLoadedMessages(message, !message.pinned),
    onPinConversation: canPinConversation
      ? () => void pinLoadedMessages(message, true, true)
      : undefined,
    onUnpinConversation: canUnpinConversation
      ? () => void pinLoadedMessages(message, false, true)
      : undefined,
    onSelectConversation: canMoveConversation
      ? () =>
          window.dispatchEvent(
            new CustomEvent(CONTEXT_ACTION_EVENT, {
              detail: {
                id: "select-conversation",
                target: { kind: "message", messageId: message.id },
              },
            }),
          )
      : undefined,
    onSelectFromSender: canSelectFromSender
      ? () =>
          window.dispatchEvent(
            new CustomEvent(CONTEXT_ACTION_EVENT, {
              detail: {
                id: "select-from-sender",
                target: { kind: "message", messageId: message.id },
              },
            }),
          )
      : undefined,
    onOlderInConversation,
    onNewerInConversation,
    onUnreadInConversation,
    onOpenEarlier: earlierHeaderId(message)
      ? () =>
          window.dispatchEvent(
            new CustomEvent(CONTEXT_ACTION_EVENT, {
              detail: {
                id: "open-earlier",
                target: { kind: "message", messageId: message.id },
              },
            }),
          )
      : undefined,
    onMoveJunk: () => void move("junk"),
    onBlockSender: canBlockSender(
      message.senderAddress,
      readerAccount(message.accountId),
    )
      ? () => void blockSender()
      : undefined,
    onBlockDomain: blockableDomain(
      message.senderAddress,
      readerAccount(message.accountId),
    )
      ? () => void blockDomain()
      : undefined,
    onUnblockDomain: () => void unblockDomain(),
    onUnblockSender: () => void unblockSender(),
    onMuteConversation: () => void muteConversation(),
    onMoveToInbox: () => {
      const inbox = mailboxes.find((box) => box.role === "inbox");
      if (inbox) void moveToMailbox(inbox.id);
    },
    onMoveToMailbox: (mailboxId) => void moveToMailbox(mailboxId),
    onMoveConversationToMailbox: canMoveConversation
      ? (mailboxId) => moveConversation(mailboxId)
      : undefined,
    onCopyToMailbox: (mailboxId) => void copyToMailbox(mailboxId),
    onCopyConversationToMailbox: canMoveConversation
      ? (mailboxId) => {
          rememberMoveMailboxId(mailboxes, mailboxId);
          void copyLoadedConversation(message, mailboxId);
        }
      : undefined,
    onOpenSnooze: () => {
      setSnoozeConversation(false);
      setSnoozeOpen(true);
    },
    onSnoozeConversation: canMoveConversation
      ? () => {
          setSnoozeConversation(true);
          setSnoozeOpen(true);
        }
      : undefined,
    onCreateRule: () => {
      const contains = senderRuleNeedle(message.senderAddress);
      if (!contains) return;
      window.dispatchEvent(
        new CustomEvent("postal:create-rule", {
          detail: {
            accountId: message.accountId,
            contains,
            field: "from",
          },
        }),
      );
    },
    onCreateSubjectRule: subjectRuleNeedle(message.subject)
      ? () => {
          const contains = subjectRuleNeedle(message.subject);
          if (!contains) return;
          window.dispatchEvent(
            new CustomEvent("postal:create-rule", {
              detail: {
                accountId: message.accountId,
                contains,
                field: "subject",
              },
            }),
          );
        }
      : undefined,
    onMessagesFromSender: onMessagesFromSender
      ? () => onMessagesFromSender(message.senderAddress)
      : undefined,
    onComposeToSender: () => {
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: {
            id: "compose-to-sender",
            target: { kind: "message", messageId: message.id },
          },
        }),
      );
    },
    onMessagesWithSubject: onMessagesWithSubject
      ? () => onMessagesWithSubject(message.subject)
      : undefined,
    onUnsubscribe: () => void unsubscribe(),
    onShowOriginal: () => setOriginalOpen(true),
    onSaveEml: () => {
      void api
        .saveMessageEml(message.accountId, message.id)
        .catch((cause) => setError(String(cause)));
    },
    onTogglePlain: () =>
      setPlainMessageId((current) =>
        message && current === message.id ? undefined : message?.id,
      ),
    onToggleMore: () => setMoreOpen((value) => !value),
    onOpenMore: () => setMoreOpen(true),
    onCloseMore: closeMoreMenu,
    onDismissMore: () => setMoreOpen(false),
  };
}
