import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useRemoteImages } from "./reader/useRemoteImages";
import {
  CONTEXT_ACTION_EVENT,
  addressMailbox,
  earlierHeaderId,
  sameSenderMessages,
  senderRuleNeedle,
  subjectRuleNeedle,
} from "../contextMenu";
import { strings } from "../i18n";
import {
  markLoadedConversationRead,
  markLoadedConversationUnread,
} from "../markConversation";
import {
  domainIsBlocked,
  blockableDomain,
  canBlockSender,
  rememberBlockedSenders,
  senderIsBlocked,
} from "../blockedSenders";

import { beginMessageOpen } from "../messageOpen";
import { forgetOpenMessage } from "../recentMessage";
import { rememberedLetterScroll } from "../letterScroll";
import { snoozeLoadedConversation } from "../snoozeConversation";
import { starLoadedConversation } from "../starConversation";
import { inspectAndOpenExternalLink } from "./externalLink";
import { parseMailto } from "../mailto";
import { hasAuthorColors, sanitizeReceivedHtml } from "../security";
import { textHighlightTerms } from "../searchHighlight";
import { useIsDark } from "../hooks/useColorScheme";
import { useAppStore } from "../store";
import { copyLoadedConversation } from "../copyConversation";
import { rememberMoveMailboxId } from "../recentMailbox";
import { copyLoadedConversationText } from "../copyMessageText";
import { forwardLoadedConversation } from "../forwardConversation";
import { pinLoadedMessages } from "../pinConversation";
import { printLoadedConversation } from "../printConversation";
import { saveLoadedConversationFiles } from "../saveConversation";
import {
  conversationIndex,
  conversationMessages,
  conversationRead,
  conversationUnread,
  messageListPosition,
} from "../threads";
import type { AttachmentPreview, MessageSummary } from "../types";
import { useDialogFocus } from "./useDialogFocus";
import { AttachmentList } from "./reader/attachmentList";
import { MessageBody } from "./reader/messageBody";
import { MessageHeader } from "./reader/messageHeader";
import { OriginalDialog } from "./reader/originalDialog";
import {
  listPostAddress,
  messageSelectionQuote,
  preferredReplyMode,
} from "./composer/composerSeed";
import { ConversationIndex } from "./reader/conversationIndex";
import {
  ContinueDraftNotice,
  JunkTrashBanner,
  ReadReceiptBanner,
  UnsubscribeSentNotice,
} from "./reader/readerNotices";
import { QuickReply } from "./reader/quickReply";
import { useReaderAttachments } from "./reader/useReaderAttachments";
import { useMessageFrame } from "./reader/useMessageFrame";
import { useReaderCompose } from "./reader/useReaderCompose";
import { useReaderMenuActions } from "./reader/useReaderMenuActions";
import { useReaderFlags } from "./reader/useReaderFlags";
import { useReaderMoves } from "./reader/useReaderMoves";
import { readerAccount, useSenderRules } from "./reader/useSenderRules";
import { useReplyNotes } from "./reader/useReplyNotes";
import { ReaderToolbar } from "./reader/readerToolbar";
import { SnoozePanel } from "./reader/snoozePanel";
import {
  buildPrintDocument,
  countTextMatches,
  selectTextMatch,
  presentPrintDocument,
  hasVisibleHtml,
  htmlToPlainText,
  readableMessageText,
  recipientLines,
  readReceiptState,
  scrollRoom,
} from "./reader/readerUtils";

export function MessageReader({
  onSnoozed,
  onConversationSnoozed,
  onShowInFolder,
  onMessagesFromSender,
  onMessagesWithSubject,
  onPrevious,
  onNext,
  onOlderInConversation,
  onNewerInConversation,
  onUnreadInConversation,
  onOpenInConversation,
  onContinueDraft,
  searchQuery,
}: {
  onSnoozed?: (accountId: string, messageId: number) => void | Promise<void>;
  onConversationSnoozed?: (
    accountId: string,
    messageIds: number[],
  ) => void | Promise<void>;
  onShowInFolder?: () => void;
  onMessagesFromSender?: (address: string) => void;
  onMessagesWithSubject?: (subject: string) => void;
  onPrevious?: () => void;
  onNext?: () => void;
  onOlderInConversation?: () => void;
  onNewerInConversation?: () => void;
  onUnreadInConversation?: () => void;
  onOpenInConversation?: (message: MessageSummary) => void;
  onContinueDraft?: (draftId: string) => void;
  searchQuery?: string;
}) {
  const message = useAppStore((state) => state.selectedMessage);
  const selectMessage = useAppStore((state) => state.selectMessage);
  const mailboxes = useAppStore((state) => state.mailboxes);
  const setMailboxes = useAppStore((state) => state.setMailboxes);
  const setMessages = useAppStore((state) => state.setMessages);
  const openComposer = useAppStore((state) => state.openComposer);
  const settings = useAppStore((state) => state.settings);
  const drafts = useAppStore((state) => state.drafts);
  const isDark = useIsDark();
  const setError = useAppStore((state) => state.setError);
  const accounts = useAppStore((state) => state.accounts);
  const frame = useRef<HTMLIFrameElement>(null);
  const contentOperation = useRef(0);
  const starredOperation = useRef(0);
  const readOperation = useRef(0);
  const moveOperations = useRef(new Map<number, number>());
  const forwardOperation = useRef(0);
  const [loadedHtml, setLoadedHtml] = useState<{
    messageId: number;
    html: string;
  }>();
  const [preparingForward, setPreparingForward] = useState(false);
  const [downloadingAttachmentId, setDownloadingAttachmentId] =
    useState<string>();
  const replyNotes = useReplyNotes();
  const [preview, setPreview] = useState<{
    messageId: number;
    attachmentId: string;
    preview: AttachmentPreview;
  } | null>(null);
  const [previewAttachmentId, setPreviewAttachmentId] = useState<string>();

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [snoozeConversation, setSnoozeConversation] = useState(false);
  const keepSnooze = useRef(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [blockRevision, setBlockRevision] = useState(0);

  useEffect(() => {
    const current = message;
    const contains = current
      ? senderRuleNeedle(current.senderAddress)
      : undefined;
    if (!current || !contains) return;
    let cancelled = false;
    void api
      .listFilterRules(current.accountId)
      .then((rules) => {
        if (cancelled) return;
        rememberBlockedSenders(current.accountId, rules);
        setBlockRevision((revision) => revision + 1);
      })
      .catch(() => {
        if (!cancelled) setBlockRevision((revision) => revision + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [message]);
  const senderBlocked = Boolean(
    message &&
    blockRevision >= 0 &&
    senderIsBlocked(message.accountId, message.senderAddress),
  );
  const domainBlocked = Boolean(
    message &&
    blockRevision >= 0 &&
    domainIsBlocked(message.accountId, message.senderAddress),
  );
  const [plainMessageId, setPlainMessageId] = useState<number>();
  const [originalOpen, setOriginalOpen] = useState(false);
  const [unsubscribeSentFor, setUnsubscribeSentFor] = useState<number>();
  const [receiptOverride, setReceiptOverride] = useState<{
    id: number;
    choice: string;
  }>();
  const [receiptBusy, setReceiptBusy] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const [findStatus, setFindStatus] = useState("");
  const findInputRef = useRef<HTMLInputElement>(null);

  function printMessage() {
    if (!message) return;
    presentPrintDocument(
      buildPrintDocument(
        message,
        loadedHtml,
        settings.textScale,
        showHtml ? sanitized?.html : undefined,
      ),
    );
  }
  const printMessageRef = useRef(printMessage);
  printMessageRef.current = printMessage;

  const neighborRef = useRef({ onNext, onPrevious });
  neighborRef.current = { onNext, onPrevious };

  function scrollMessage(direction: 1 | -1) {
    const amount = Math.round(window.innerHeight * 0.85) * direction;
    const frameWindow = frame.current?.contentWindow;
    const scrolling = frameWindow
      ? (frameWindow.document.scrollingElement ??
        frameWindow.document.documentElement)
      : null;
    const body = bodyRef.current;
    const room = scrolling
      ? scrollRoom(
          frameWindow?.scrollY || scrolling.scrollTop,
          scrolling.scrollHeight,
          frameWindow?.innerHeight ?? 0,
          direction,
        )
      : body
        ? scrollRoom(
            body.scrollTop,
            body.scrollHeight,
            body.clientHeight,
            direction,
          )
        : null;
    if (room === null || room > 2) {
      if (frameWindow) frameWindow.scrollBy(0, amount);
      else body?.scrollBy?.({ top: amount, behavior: "auto" });
      return;
    }
    if (direction > 0) neighborRef.current.onNext?.();
    else neighborRef.current.onPrevious?.();
  }

  function findInMessage(direction: 1 | -1 = 1) {
    const query = findQuery.trim();
    if (!query) {
      setFindStatus("");
      return;
    }
    const liveBody = frame.current?.contentDocument?.body;
    const root =
      liveBody && liveBody.textContent?.trim()
        ? liveBody
        : frame.current?.srcdoc
          ? new DOMParser().parseFromString(frame.current.srcdoc, "text/html")
              .body
          : bodyRef.current;
    const total = root ? countTextMatches(root, query) : 0;
    if (!root || total === 0) {
      setFindIndex(0);
      setFindStatus(strings.reader.findNoMatches);
      return;
    }
    const next =
      findIndex === 0 && direction < 0
        ? total
        : findIndex === 0
          ? 1
          : ((findIndex - 1 + direction + total) % total) + 1;
    setFindIndex(next);
    setFindStatus(strings.reader.findMatchCount(next, total));
    selectTextMatch(root, query, next);
  }

  async function snoozeCurrentMessage(untilIso: string) {
    if (!message) return;
    const target = message;
    const conversation = snoozeConversation;
    try {
      if (conversation) {
        const ids = await snoozeLoadedConversation(target, untilIso);
        if (!ids) return;
        setSnoozeOpen(false);
        setSnoozeConversation(false);
        keepSnooze.current = false;
        try {
          await onConversationSnoozed?.(target.accountId, ids);
        } catch (cause) {
          setError(String(cause));
        }
        return;
      }
      await api.snoozeMessage(target.accountId, target.id, untilIso);
    } catch (cause) {
      setError(String(cause));
      return;
    }
    setSnoozeOpen(false);
    const current = useAppStore.getState().selectedMessage;
    if (current?.id === target.id && current.accountId === target.accountId) {
      selectMessage(undefined);
    }
    try {
      await onSnoozed?.(target.accountId, target.id);
    } catch (cause) {
      setError(String(cause));
    }
  }
  const isOverlay = settings.readingPane === "hidden" && message !== undefined;
  const [narrowViewport, setNarrowViewport] = useState(() =>
    typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 760px)").matches
      : false,
  );
  const treatAsOverlay = isOverlay || (narrowViewport && message !== undefined);
  const restoreMoreFocus = useCallback(() => {
    window.setTimeout(() => moreTriggerRef.current?.focus(), 0);
  }, []);
  const closeSnoozePanel = useCallback(() => {
    setSnoozeOpen(false);
    setSnoozeConversation(false);
    keepSnooze.current = false;
    restoreMoreFocus();
  }, [restoreMoreFocus]);
  const closeMoreMenu = useCallback(() => {
    setMoreOpen(false);
    restoreMoreFocus();
  }, [restoreMoreFocus]);
  const closeOpenMessage = useCallback(() => {
    const state = useAppStore.getState();
    if (
      state.activeAccountId &&
      state.activeMailboxId &&
      !state.activeLocalView
    ) {
      forgetOpenMessage(state.activeAccountId, state.activeMailboxId);
    }
    beginMessageOpen();
    selectMessage(undefined);
  }, [selectMessage]);
  const dialogRef = useDialogFocus(() => {
    if (originalOpen) {
      setOriginalOpen(false);
      return;
    }
    if (preview) {
      setPreview(null);
      return;
    }
    if (snoozeOpen) {
      closeSnoozePanel();
      return;
    }
    if (moreOpen) {
      setMoreOpen(false);
      return;
    }
    closeOpenMessage();
  });
  const titleRef = useRef<HTMLHeadingElement>(null);
  const overlayMessageId = message?.id;

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setNarrowViewport(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (overlayMessageId === undefined) return;
    if (!treatAsOverlay) return;
    const previous = document.activeElement as HTMLElement | null;
    titleRef.current?.focus();
    return () => {
      previous?.focus();
    };
  }, [treatAsOverlay, overlayMessageId]);

  useEffect(() => {
    if (!moreOpen) return;
    const first = moreMenuRef.current?.querySelector<HTMLElement>(
      '[role="menuitem"]:not([disabled]), select:not([disabled])',
    );
    first?.focus();
    const close = (event: MouseEvent) => {
      if (!moreMenuRef.current?.contains(event.target as Node)) {
        setMoreOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Tab") return;
      if (event.key === "Escape") event.preventDefault();
      if (snoozeOpen) {
        closeSnoozePanel();
        return;
      }
      closeMoreMenu();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [closeMoreMenu, closeSnoozePanel, moreOpen, snoozeOpen]);

  const [menuMessageId, setMenuMessageId] = useState(message?.id);
  if (message?.id !== menuMessageId) {
    setMenuMessageId(message?.id);
    if (moreOpen) setMoreOpen(false);
    if (snoozeOpen && !keepSnooze.current) {
      setSnoozeOpen(false);
      setSnoozeConversation(false);
    }
    keepSnooze.current = false;
    if (originalOpen) setOriginalOpen(false);
  }

  const loadedMessages = useAppStore((state) => state.messages);
  const mailboxSort = useAppStore((state) => state.mailboxSort);
  const listPosition = message
    ? messageListPosition(
        loadedMessages,
        settings.groupThreads && (mailboxSort ?? "date") === "date",
        message.id,
      )
    : undefined;
  const conversation = message
    ? conversationIndex(loadedMessages, message)
    : [];
  const listed = useAppStore((state) =>
    message ? state.messages.find((item) => item.id === message.id) : undefined,
  );
  const canMarkConversationRead = useAppStore((state) =>
    message ? conversationUnread(state.messages, message).length > 0 : false,
  );
  const canMarkConversationUnread = useAppStore((state) =>
    message ? conversationRead(state.messages, message).length > 0 : false,
  );
  const canMoveConversation = useAppStore((state) =>
    message ? conversationMessages(state.messages, message).length > 1 : false,
  );
  const canSelectFromSender = useAppStore((state) =>
    message
      ? sameSenderMessages(state.messages, message.senderAddress).length > 1
      : false,
  );
  const canSaveConversationFiles = useAppStore((state) =>
    message
      ? conversationMessages(state.messages, message).some(
          (item) => item.hasAttachments,
        )
      : false,
  );
  const canStarConversation = useAppStore((state) =>
    message
      ? conversationMessages(state.messages, message).some(
          (item) => !item.isStarred,
        )
      : false,
  );
  const canUnstarConversation = useAppStore((state) => {
    if (!message) return false;
    const members = conversationMessages(state.messages, message);
    return members.length > 1 && members.every((item) => item.isStarred);
  });
  const canPinConversation = useAppStore((state) =>
    message
      ? conversationMessages(state.messages, message).some(
          (item) => !item.pinned,
        )
      : false,
  );
  const canUnpinConversation = useAppStore((state) => {
    if (!message) return false;
    const members = conversationMessages(state.messages, message);
    return members.length > 1 && members.every((item) => item.pinned);
  });
  const account = accounts.find((a) => a.id === message?.accountId);
  function indexSender(item: { senderName: string; senderAddress: string }) {
    const address = addressMailbox(item.senderAddress)?.toLowerCase();
    const yours =
      Boolean(address) &&
      Boolean(account) &&
      [account?.email, ...(account?.aliases ?? [])].some(
        (entry) => addressMailbox(entry ?? "")?.toLowerCase() === address,
      );
    if (yours) return strings.mail.you;
    return item.senderName || item.senderAddress;
  }
  const currentMailbox = mailboxes.find((m) => m.id === message?.mailboxId);
  const receiptChoice =
    message && receiptOverride?.id === message.id
      ? receiptOverride.choice
      : (message?.receiptChoice ?? "");
  const receiptView = message
    ? readReceiptState(
        { ...message, receiptChoice },
        account,
        currentMailbox?.role,
      )
    : null;
  const isArchiveMailbox = currentMailbox?.role === "archive";
  const isTrashMailbox = currentMailbox?.role === "trash";
  const isJunkMailbox = currentMailbox?.role === "junk";

  async function handleExternalLink(url: string, linkText?: string) {
    await inspectAndOpenExternalLink(url, linkText);
  }

  async function unsubscribe() {
    const target = useAppStore.getState().selectedMessage;
    const options = target?.unsubscribe;
    if (!target || !options) return;
    if (options.oneClick && options.httpsHost) {
      const confirmed = await api.showNativeConfirm(
        strings.reader.unsubscribeTitle,
        strings.reader.unsubscribeConfirm(options.httpsHost),
      );
      if (!confirmed) return;
      try {
        await api.unsubscribeOneClick(target.accountId, target.id);
        setUnsubscribeSentFor(target.id);
      } catch {
        // Reasons stay generic: server text and addresses are never shown.
        setError(strings.reader.unsubscribeFailed);
      }
      return;
    }
    if (options.mailto) {
      // The user reviews and sends this like any other message.
      const draft = parseMailto(options.mailto);
      openComposer({
        prefill: { ...draft, subject: draft.subject.replace(/[\r\n]+/g, " ") },
      });
      return;
    }
    if (options.httpsUrl) await handleExternalLink(options.httpsUrl);
  }

  async function chooseReceipt(send: boolean) {
    if (!message || receiptBusy) return;
    setReceiptBusy(true);
    try {
      const choice = send
        ? await api.sendReadReceipt(message.accountId, message.id)
        : await api.declineReadReceipt(message.accountId, message.id);
      setReceiptOverride({ id: message.id, choice });
    } catch (cause) {
      setError(String(cause));
    } finally {
      setReceiptBusy(false);
    }
  }

  const handleExternalLinkRef = useRef(handleExternalLink);
  handleExternalLinkRef.current = handleExternalLink;

  // Native side routes denied frame popups (WebKit link clicks) here.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    void api
      .onFrameLink((url) => {
        if (/^https?:\/\//i.test(url)) void handleExternalLinkRef.current(url);
        else if (/^mailto:/i.test(url))
          useAppStore.getState().openComposer({ prefill: parseMailto(url) });
      })
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  async function copyReadableText() {
    if (!message) return;
    const text = readableMessageText(message);
    if (!text) return;
    await navigator.clipboard.writeText(text).catch(() => undefined);
  }

  async function copyRecipients() {
    const selected = useAppStore.getState().selectedMessage;
    if (!selected) return;
    const text = recipientLines(selected.to, selected.cc, selected.bcc);
    if (!text) return;
    await navigator.clipboard.writeText(text).catch(() => undefined);
  }

  const {
    editAsNewMessage,
    redirectMessage,
    forwardAsAttachment,
    replyWithAttachments,
    forwardMessage,
  } = useReaderCompose({
    openComposer,
    setError,
    setMoreOpen,
    preparingForward,
    setPreparingForward,
    forwardOperation,
  });

  const { setStarred, setRead } = useReaderFlags({
    selectMessage,
    setMessages,
    setMailboxes,
    setError,
    starredOperation,
    readOperation,
  });

  const {
    deleteForever,
    muteConversation,
    move,
    deleteConversation,
    moveConversation,
    moveToInbox,
    moveToMailbox,
    copyToMailbox,
  } = useReaderMoves({
    selectMessage,
    setMessages,
    setMailboxes,
    setError,
    moveOperations,
  });

  const { blockSender, blockDomain, unblockDomain, unblockSender } =
    useSenderRules({ setError, setBlockRevision, move, moveToInbox });

  const {
    isPreviewable,
    previewFile,
    saveChosenAttachments,
    saveAllAttachments,
    download,
  } = useReaderAttachments({
    message,
    previewAttachmentId,
    setPreviewAttachmentId,
    setPreview,
    downloadingAttachmentId,
    setDownloadingAttachmentId,
    setError,
  });

  useReaderMenuActions({
    openComposer,
    replyWithAttachments,
    forwardMessage,
    forwardAsAttachment,
    redirectMessage,
    editAsNewMessage,
    move,
    blockSender,
    unblockSender,
    blockDomain,
    unblockDomain,
    muteConversation,
    deleteForever,
    moveToInbox,
    moveToMailbox,
    copyToMailbox,
    setRead,
    setStarred,
    previewFile,
    download,
    copyRecipients,
    printMessageRef,
    findInputRef,
    setFindOpen,
    scrollMessage,
    setSnoozeConversation,
    setSnoozeOpen,
    keepSnooze,
    frame,
  });

  const htmlBody = message?.htmlBody;
  const attachments = message?.attachments;
  const sanitized = useMemo(
    () => (htmlBody ? sanitizeReceivedHtml(htmlBody) : undefined),
    [htmlBody],
  );
  // Fall back to the text part when the HTML part sanitizes to nothing visible.
  const formatted = useMemo(
    () => (sanitized ? hasVisibleHtml(sanitized.html) : false),
    [sanitized],
  );
  const extractedPlain = useMemo(
    () => (sanitized ? htmlToPlainText(sanitized.html) : ""),
    [sanitized],
  );
  const viewingPlain = plainMessageId === message?.id;
  const showHtml = formatted && !viewingPlain;
  const plainText =
    viewingPlain && message
      ? message.textBody.trim()
        ? message.textBody
        : extractedPlain
      : undefined;
  const canViewPlain =
    formatted &&
    (Boolean(message?.textBody.trim()) || extractedPlain.length > 0);
  const currentLoadedHtml =
    loadedHtml && loadedHtml.messageId === message?.id
      ? loadedHtml.html
      : undefined;
  const { remainingBlockedImages, filteredImages, threatImages } =
    useMemo(() => {
      if (!currentLoadedHtml) {
        return {
          remainingBlockedImages: sanitized?.blockedImages ?? 0,
          filteredImages: 0,
          threatImages: 0,
        };
      }
      const doc = new DOMParser().parseFromString(
        currentLoadedHtml,
        "text/html",
      );
      return {
        remainingBlockedImages: doc.querySelectorAll("img[data-remote-src]")
          .length,
        filteredImages: doc.querySelectorAll("img[data-content-blocked]")
          .length,
        threatImages: doc.querySelectorAll("img[data-threat-blocked]").length,
      };
    }, [sanitized, currentLoadedHtml]);
  const inlineAttachments = useMemo(
    () => attachments?.filter((attachment) => attachment.inline) ?? [],
    [attachments],
  );
  const messageId = message?.id;
  const messageAccountId = message?.accountId;
  const { loadImages, loadingImages } = useRemoteImages({
    message,
    sanitized,
    currentLoadedHtml,
    inlineAttachments,
    contentOperationRef: contentOperation,
    setLoadedHtml,
    setError,
  });

  const { frameSource, frameHtml, fitFrameContent, wireFrameLinks } =
    useMessageFrame({
      frame,
      contentOperation,
      message,
      messageId,
      messageAccountId,
      sanitized,
      currentLoadedHtml,
      inlineAttachments,
      setLoadedHtml,
      searchQuery,
      settings,
      isDark,
      handleExternalLink,
      openComposer,
    });

  if (settings.readingPane === "hidden" && !message)
    return (
      <section
        className="reader-pane reader-hidden"
        id="reader-pane"
        aria-hidden="true"
      />
    );
  if (!message)
    return (
      // Quiet text, like Mail's "No Message Selected".
      <section className="reader-pane empty-reader" id="reader-pane">
        <p>{strings.mail.noMessage}</p>
      </section>
    );

  const showDetails = detailsOpen;

  return (
    <article
      className="reader-pane"
      id="reader-pane"
      aria-labelledby="message-title"
      ref={treatAsOverlay ? dialogRef : undefined}
      role={treatAsOverlay ? "dialog" : undefined}
      aria-modal={treatAsOverlay ? "true" : undefined}
    >
      <ReaderToolbar
        message={message}
        mailboxes={mailboxes}
        readingPane={settings.readingPane}
        moreOpen={moreOpen}
        moreMenuRef={moreMenuRef}
        moreTriggerRef={moreTriggerRef}
        preparingForward={preparingForward}
        isArchiveMailbox={isArchiveMailbox}
        isTrashMailbox={isTrashMailbox}
        isJunkMailbox={isJunkMailbox}
        onBack={closeOpenMessage}
        onPrevious={onPrevious}
        onNext={onNext}
        listPosition={listPosition}
        onReply={() => {
          const account = accounts.find(
            (item) => item.id === message.accountId,
          );
          openComposer({
            sourceMessage: message,
            composeMode: preferredReplyMode(
              message,
              settings.replyToAll,
              account?.email ?? "",
              account?.aliases ?? [],
            ),
            quoteExcerpt: messageSelectionQuote(),
          });
        }}
        onReplyAll={() =>
          openComposer({
            sourceMessage: message,
            composeMode: "replyAll",
            quoteExcerpt: messageSelectionQuote(),
          })
        }
        onReplyWithoutQuoting={() =>
          openComposer({
            sourceMessage: message,
            composeMode: "reply",
            omitQuote: true,
          })
        }
        onReplyAllWithoutQuoting={() =>
          openComposer({
            sourceMessage: message,
            composeMode: "replyAll",
            omitQuote: true,
          })
        }
        onReplyToList={
          listPostAddress(message.listPost)
            ? () =>
                openComposer({
                  sourceMessage: message,
                  composeMode: "replyList",
                  quoteExcerpt: messageSelectionQuote(),
                })
            : undefined
        }
        onReplyWithAttachments={
          message.attachments.some((item) => !item.inline)
            ? () => void replyWithAttachments("reply")
            : undefined
        }
        onReplyAllWithAttachments={
          message.attachments.some((item) => !item.inline)
            ? () => void replyWithAttachments("replyAll")
            : undefined
        }
        onForward={() => void forwardMessage()}
        onForwardConversation={
          canMoveConversation
            ? () => void forwardLoadedConversation(message)
            : undefined
        }
        onForwardAsAttachment={() => void forwardAsAttachment()}
        onRedirect={redirectMessage}
        onEditAsNew={() => void editAsNewMessage()}
        onArchive={() => void move("archive")}
        onTrash={() => {
          if (isTrashMailbox) void deleteForever();
          else void move("trash");
        }}
        onPrint={printMessage}
        onPrintConversation={
          canMoveConversation
            ? () =>
                void printLoadedConversation(message, {
                  messageId: message.id,
                  html: showHtml
                    ? (currentLoadedHtml ?? sanitized?.html)
                    : undefined,
                })
            : undefined
        }
        onCopyMessageText={() => void copyReadableText()}
        onCopySubject={
          message.subject.trim()
            ? () =>
                void navigator.clipboard
                  .writeText(message.subject.trim())
                  .catch(() => undefined)
            : undefined
        }
        onCopySenderAddress={
          addressMailbox(message.senderAddress)
            ? () =>
                void navigator.clipboard
                  .writeText(addressMailbox(message.senderAddress) ?? "")
                  .catch(() => undefined)
            : undefined
        }
        onCopyRecipients={
          message && recipientLines(message.to, message.cc, message.bcc)
            ? () => void copyRecipients()
            : undefined
        }
        onCopyConversationText={
          canMoveConversation
            ? () => void copyLoadedConversationText(message)
            : undefined
        }
        onSaveConversationFiles={
          canSaveConversationFiles
            ? () => void saveLoadedConversationFiles(message)
            : undefined
        }
        onToggleRead={() => void setRead()}
        onMarkConversationRead={
          canMarkConversationRead
            ? () => void markLoadedConversationRead(message)
            : undefined
        }
        onMarkConversationUnread={
          canMarkConversationUnread
            ? () => void markLoadedConversationUnread(message)
            : undefined
        }
        onArchiveConversation={
          canMoveConversation && !isArchiveMailbox
            ? () => moveConversation("archive")
            : undefined
        }
        onTrashConversation={
          canMoveConversation && !isTrashMailbox
            ? () => moveConversation("trash")
            : undefined
        }
        onDeleteConversation={
          canMoveConversation && isTrashMailbox
            ? () => deleteConversation()
            : undefined
        }
        onJunkConversation={
          canMoveConversation && !isJunkMailbox
            ? () => moveConversation("junk")
            : undefined
        }
        onMoveConversationToInbox={
          canMoveConversation && (isArchiveMailbox || isJunkMailbox)
            ? () => moveConversation("inbox")
            : undefined
        }
        onToggleStar={() => void setStarred()}
        onStarConversation={
          canStarConversation
            ? () => void starLoadedConversation(message, true)
            : undefined
        }
        onUnstarConversation={
          canUnstarConversation
            ? () => void starLoadedConversation(message, false)
            : undefined
        }
        onPin={() => void pinLoadedMessages(message, !message.pinned)}
        onPinConversation={
          canPinConversation
            ? () => void pinLoadedMessages(message, true, true)
            : undefined
        }
        onUnpinConversation={
          canUnpinConversation
            ? () => void pinLoadedMessages(message, false, true)
            : undefined
        }
        onSelectConversation={
          canMoveConversation
            ? () =>
                window.dispatchEvent(
                  new CustomEvent(CONTEXT_ACTION_EVENT, {
                    detail: {
                      id: "select-conversation",
                      target: { kind: "message", messageId: message.id },
                    },
                  }),
                )
            : undefined
        }
        onSelectFromSender={
          canSelectFromSender
            ? () =>
                window.dispatchEvent(
                  new CustomEvent(CONTEXT_ACTION_EVENT, {
                    detail: {
                      id: "select-from-sender",
                      target: { kind: "message", messageId: message.id },
                    },
                  }),
                )
            : undefined
        }
        onOlderInConversation={onOlderInConversation}
        onNewerInConversation={onNewerInConversation}
        onUnreadInConversation={onUnreadInConversation}
        onOpenEarlier={
          earlierHeaderId(message)
            ? () =>
                window.dispatchEvent(
                  new CustomEvent(CONTEXT_ACTION_EVENT, {
                    detail: {
                      id: "open-earlier",
                      target: { kind: "message", messageId: message.id },
                    },
                  }),
                )
            : undefined
        }
        onMoveJunk={() => void move("junk")}
        onBlockSender={
          canBlockSender(
            message.senderAddress,
            readerAccount(message.accountId),
          )
            ? () => void blockSender()
            : undefined
        }
        senderBlocked={senderBlocked}
        domainBlocked={domainBlocked}
        onBlockDomain={
          blockableDomain(
            message.senderAddress,
            readerAccount(message.accountId),
          )
            ? () => void blockDomain()
            : undefined
        }
        onUnblockDomain={() => void unblockDomain()}
        onUnblockSender={() => void unblockSender()}
        onMuteConversation={() => void muteConversation()}
        onMoveToInbox={() => {
          const inbox = mailboxes.find((box) => box.role === "inbox");
          if (inbox) void moveToMailbox(inbox.id);
        }}
        onMoveToMailbox={(mailboxId) => void moveToMailbox(mailboxId)}
        onMoveConversationToMailbox={
          canMoveConversation
            ? (mailboxId) => moveConversation(mailboxId)
            : undefined
        }
        onCopyToMailbox={(mailboxId) => void copyToMailbox(mailboxId)}
        onCopyConversationToMailbox={
          canMoveConversation
            ? (mailboxId) => {
                rememberMoveMailboxId(mailboxes, mailboxId);
                void copyLoadedConversation(message, mailboxId);
              }
            : undefined
        }
        onOpenSnooze={() => {
          setSnoozeConversation(false);
          setSnoozeOpen(true);
        }}
        onSnoozeConversation={
          canMoveConversation
            ? () => {
                setSnoozeConversation(true);
                setSnoozeOpen(true);
              }
            : undefined
        }
        onCreateRule={() => {
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
        }}
        onCreateSubjectRule={
          subjectRuleNeedle(message.subject)
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
            : undefined
        }
        onMessagesFromSender={
          onMessagesFromSender
            ? () => onMessagesFromSender(message.senderAddress)
            : undefined
        }
        onComposeToSender={() => {
          window.dispatchEvent(
            new CustomEvent(CONTEXT_ACTION_EVENT, {
              detail: {
                id: "compose-to-sender",
                target: { kind: "message", messageId: message.id },
              },
            }),
          );
        }}
        onMessagesWithSubject={
          onMessagesWithSubject
            ? () => onMessagesWithSubject(message.subject)
            : undefined
        }
        onUnsubscribe={() => void unsubscribe()}
        onShowOriginal={() => setOriginalOpen(true)}
        onSaveEml={() => {
          void api
            .saveMessageEml(message.accountId, message.id)
            .catch((cause) => setError(String(cause)));
        }}
        canViewPlain={canViewPlain}
        viewingPlain={viewingPlain}
        onTogglePlain={() =>
          setPlainMessageId((current) =>
            message && current === message.id ? undefined : message?.id,
          )
        }
        onToggleMore={() => setMoreOpen((value) => !value)}
        onOpenMore={() => setMoreOpen(true)}
        onCloseMore={closeMoreMenu}
        onDismissMore={() => setMoreOpen(false)}
        windowDrag={treatAsOverlay}
      />
      {snoozeOpen ? (
        <SnoozePanel
          label={
            snoozeConversation
              ? strings.reader.snoozeConversation
              : strings.reader.snooze
          }
          onSnooze={(untilIso) => void snoozeCurrentMessage(untilIso)}
          onClose={closeSnoozePanel}
        />
      ) : null}
      <MessageHeader
        message={message}
        account={account}
        currentMailbox={currentMailbox}
        showDetails={showDetails}
        onToggleDetails={() => setDetailsOpen((open) => !open)}
        titleRef={titleRef}
        treatAsOverlay={treatAsOverlay}
        answered={listed?.isAnswered ?? message.isAnswered}
        forwarded={listed?.isForwarded ?? message.isForwarded}
        onShowInFolder={onShowInFolder}
        onOpenEarlier={
          earlierHeaderId(message)
            ? () =>
                window.dispatchEvent(
                  new CustomEvent(CONTEXT_ACTION_EVENT, {
                    detail: {
                      id: "open-earlier",
                      target: { kind: "message", messageId: message.id },
                    },
                  }),
                )
            : undefined
        }
        searchQuery={searchQuery}
      />
      <JunkTrashBanner
        isJunkMailbox={isJunkMailbox}
        isTrashMailbox={isTrashMailbox}
        onMoveToInbox={moveToInbox}
      />
      <ContinueDraftNotice
        drafts={drafts}
        message={message}
        onContinueDraft={onContinueDraft}
      />
      <ConversationIndex
        conversation={conversation}
        message={message}
        indexSender={indexSender}
        onOpenInConversation={onOpenInConversation}
      />
      <ReadReceiptBanner
        receiptView={receiptView}
        message={message}
        receiptBusy={receiptBusy}
        chooseReceipt={chooseReceipt}
      />
      <UnsubscribeSentNotice
        unsubscribeSentFor={unsubscribeSentFor}
        message={message}
      />
      {originalOpen ? (
        <OriginalDialog
          accountId={message.accountId}
          messageId={message.id}
          onClose={() => {
            setOriginalOpen(false);
            restoreMoreFocus();
          }}
          onError={(text) => setError(text)}
        />
      ) : null}
      <MessageBody
        message={message}
        sanitized={sanitized}
        showHtml={showHtml}
        plainText={plainText}
        followsTheme={isDark && (!showHtml || !hasAuthorColors(frameSource))}
        currentLoadedHtml={currentLoadedHtml}
        frameHtml={frameHtml}
        filteredImages={filteredImages}
        threatImages={threatImages}
        remainingBlockedImages={remainingBlockedImages}
        loadingImages={loadingImages}
        findOpen={findOpen}
        findQuery={findQuery}
        findInputRef={findInputRef}
        bodyRef={bodyRef}
        frameRef={frame}
        findStatus={findStatus}
        onFindQueryChange={(value) => {
          setFindQuery(value);
          setFindIndex(0);
          setFindStatus("");
        }}
        onCloseFind={() => {
          setFindOpen(false);
          setFindQuery("");
          setFindIndex(0);
          setFindStatus("");
        }}
        onSubmitFind={() => findInMessage(1)}
        onFindPrevious={() => findInMessage(-1)}
        onLoadImages={() => void loadImages()}
        onFrameLoad={() => {
          wireFrameLinks();
          fitFrameContent();
          const letterId = message?.id;
          const top = letterId == null ? 0 : rememberedLetterScroll(letterId);
          if (top <= 0) return;
          requestAnimationFrame(() => {
            const doc = frame.current?.contentDocument;
            const scrolling = doc?.scrollingElement ?? doc?.documentElement;
            if (scrolling) scrolling.scrollTop = top;
          });
        }}
        onOpenLink={(url) => void handleExternalLink(url)}
        onOpenMailto={(url) => openComposer({ prefill: parseMailto(url) })}
        searchTerms={textHighlightTerms(searchQuery ?? "")}
      />
      <AttachmentList
        message={message}
        preview={preview}
        downloadingAttachmentId={downloadingAttachmentId}
        previewAttachmentId={previewAttachmentId}
        isPreviewable={isPreviewable}
        onPreview={previewFile}
        onDownload={download}
        onSaveAll={() => void saveAllAttachments()}
        onSaveChosen={(ids) => void saveChosenAttachments(ids)}
        onPreviewDownload={() => {
          const current = message.attachments.find(
            (item) =>
              item.filename === preview?.preview.filename && !item.inline,
          );
          if (current) void download(current.id, current.filename);
        }}
        onPreviewClose={() => setPreview(null)}
      />
      <QuickReply message={message} replyNotes={replyNotes} />
    </article>
  );
}
