import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useRemoteImages } from "./reader/useRemoteImages";
import {
  CONTEXT_ACTION_EVENT,
  addressMailbox,
  earlierHeaderId,
  senderRuleNeedle,
} from "../contextMenu";
import { strings } from "../i18n";
import {
  domainIsBlocked,
  rememberBlockedSenders,
  senderIsBlocked,
} from "../blockedSenders";

import { beginMessageOpen } from "../messageOpen";
import { forgetOpenMessage } from "../recentMessage";
import { rememberedLetterScroll } from "../letterScroll";
import { snoozeLoadedConversation } from "../snoozeConversation";
import { inspectAndOpenExternalLink } from "./externalLink";
import { parseMailto } from "../mailto";
import { hasAuthorColors, sanitizeReceivedHtml } from "../security";
import { textHighlightTerms } from "../searchHighlight";
import { useIsDark } from "../hooks/useColorScheme";
import { useAppStore } from "../store";
import type { AttachmentPreview, MessageSummary } from "../types";
import { useDialogFocus } from "./useDialogFocus";
import { AttachmentList } from "./reader/attachmentList";
import { MessageBody } from "./reader/messageBody";
import { MessageHeader } from "./reader/messageHeader";
import { OriginalDialog } from "./reader/originalDialog";
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
import { useConversationState } from "./reader/useConversationState";
import { useReaderCompose } from "./reader/useReaderCompose";
import { useReaderFind } from "./reader/useReaderFind";
import { useReaderMenuActions } from "./reader/useReaderMenuActions";
import { useReaderFlags } from "./reader/useReaderFlags";
import { useReaderMoves } from "./reader/useReaderMoves";
import { useSenderRules } from "./reader/useSenderRules";
import { useReplyNotes } from "./reader/useReplyNotes";
import { ReaderToolbar } from "./reader/readerToolbar";
import { buildReaderActions } from "./reader/buildReaderActions";
import { SnoozePanel } from "./reader/snoozePanel";
import {
  buildPrintDocument,
  presentPrintDocument,
  hasVisibleHtml,
  htmlToPlainText,
  readableMessageText,
  recipientLines,
  readReceiptState,
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
  // eslint-disable-next-line react-hooks/refs -- latest-ref pattern
  printMessageRef.current = printMessage;

  const neighborRef = useRef({ onNext, onPrevious });
  // eslint-disable-next-line react-hooks/refs -- latest-ref pattern
  neighborRef.current = { onNext, onPrevious };

  const { scrollMessage, findInMessage } = useReaderFind({
    frame,
    bodyRef,
    neighborRef,
    findQuery,
    findIndex,
    setFindIndex,
    setFindStatus,
  });

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
      const target = event.target as Node;
      if (
        moreMenuRef.current?.contains(target) ||
        moreTriggerRef.current?.contains(target)
      )
        return;
      setMoreOpen(false);
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
    // eslint-disable-next-line react-hooks/refs -- latest-ref pattern
    if (snoozeOpen && !keepSnooze.current) {
      setSnoozeOpen(false);
      setSnoozeConversation(false);
    }
    // eslint-disable-next-line react-hooks/refs -- latest-ref pattern
    keepSnooze.current = false;
    if (originalOpen) setOriginalOpen(false);
  }

  const {
    listPosition,
    conversation,
    listed,
    canMarkConversationRead,
    canMarkConversationUnread,
    canMoveConversation,
    canSelectFromSender,
    canSaveConversationFiles,
    canStarConversation,
    canUnstarConversation,
    canPinConversation,
    canUnpinConversation,
  } = useConversationState(message, settings);

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
  // eslint-disable-next-line react-hooks/refs -- latest-ref pattern
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
  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- memo kept as written
  const sanitized = useMemo(
    () => (htmlBody ? sanitizeReceivedHtml(htmlBody) : undefined),
    [htmlBody],
  );
  // Fall back to the text part when the HTML part sanitizes to nothing visible.
  const formatted = useMemo(
    () => (sanitized ? hasVisibleHtml(sanitized.html) : false),
    // eslint-disable-next-line react-hooks/preserve-manual-memoization -- memo kept as written
    [sanitized],
  );
  const extractedPlain = useMemo(
    () => (sanitized ? htmlToPlainText(sanitized.html) : ""),
    // eslint-disable-next-line react-hooks/preserve-manual-memoization -- memo kept as written
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
      // eslint-disable-next-line react-hooks/preserve-manual-memoization -- memo kept as written
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
  // eslint-disable-next-line react-hooks/refs -- handlers read refs only when invoked
  const readerActions = buildReaderActions({
    message,
    accounts,
    mailboxes,
    replyToAll: settings.replyToAll,
    openComposer,
    setError,
    sanitizedHtml: sanitized?.html,
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
  });

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
        actions={readerActions}
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
        listPosition={listPosition}
        senderBlocked={senderBlocked}
        domainBlocked={domainBlocked}
        canViewPlain={canViewPlain}
        viewingPlain={viewingPlain}
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
