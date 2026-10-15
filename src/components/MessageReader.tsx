import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../api";
import { useRemoteImages } from "./reader/useRemoteImages";
import {
  CONTEXT_ACTION_EVENT,
  IFRAME_CONTEXT_EVENT,
  addressMailbox,
  earlierHeaderId,
  sameSenderMessages,
  senderRuleNeedle,
  subjectRuleNeedle,
  type ContextMenuActionDetail,
  type IframeContextMenuDetail,
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
import { rememberedLetterScroll, rememberLetterScroll } from "../letterScroll";
import { snoozeLoadedConversation } from "../snoozeConversation";
import { starLoadedConversation } from "../starConversation";
import { inspectAndOpenExternalLink } from "./externalLink";
import { parseMailto } from "../mailto";
import {
  differentLinkAddress,
  hasAuthorColors,
  messageFrameDocument,
  sanitizeReceivedHtml,
  withFrameLinks,
} from "../security";
import { markHtmlText, textHighlightTerms } from "../searchHighlight";
import { ShieldCheck } from "lucide-react";
import { useIsDark } from "../hooks/useColorScheme";
import { formatFullMessageDate, formatMessageDate } from "../format";
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
import type { Attachment, AttachmentPreview, MessageSummary } from "../types";
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
import { QuickReply } from "./reader/quickReply";
import { useReaderCompose } from "./reader/useReaderCompose";
import { useReaderFlags } from "./reader/useReaderFlags";
import { useReaderMoves } from "./reader/useReaderMoves";
import { readerAccount, useSenderRules } from "./reader/useSenderRules";
import { useReplyNotes } from "./reader/useReplyNotes";
import { ReaderToolbar } from "./reader/readerToolbar";
import { SnoozePanel } from "./reader/snoozePanel";
import {
  buildPrintDocument,
  collapseQuotedMail,
  countTextMatches,
  selectTextMatch,
  presentPrintDocument,
  hasVisibleHtml,
  hydrateInlineImages,
  htmlToPlainText,
  readableMessageText,
  recipientLines,
  readReceiptState,
  scrollRoom,
} from "./reader/readerUtils";

/** Smallest shrink-to-fit scale before wide mail scrolls sideways. */
const MIN_FIT_ZOOM = 0.6;

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

  function isPreviewable(attachment: Attachment): boolean {
    if (attachment.inline || attachment.size > 10 * 1024 * 1024) return false;
    const contentType = attachment.contentType.toLowerCase();
    return (
      contentType === "text/plain" ||
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
        contentType,
      )
    );
  }

  async function previewFile(attachmentId: string) {
    if (!message || previewAttachmentId !== undefined) return;
    const targetMessageId = message.id;
    setPreviewAttachmentId(attachmentId);
    try {
      const loaded = await api.previewAttachment(
        message.accountId,
        message.id,
        attachmentId,
      );
      if (targetMessageId !== useAppStore.getState().selectedMessage?.id)
        return;
      setPreview({
        messageId: targetMessageId,
        attachmentId,
        preview: loaded,
      });
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPreviewAttachmentId(undefined);
    }
  }
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

  const menuHandlersRef = useRef({
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
  });

  useEffect(() => {
    menuHandlersRef.current = {
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
    };
  });

  useEffect(() => {
    const menuAction = (event: Event) => {
      const h = menuHandlersRef.current;
      const selected = useAppStore.getState().selectedMessage;
      if (!selected) return;
      const action = (event as CustomEvent<string>).detail;
      if (action === "reply")
        h.openComposer({
          sourceMessage: selected,
          composeMode: "reply",
          quoteExcerpt: messageSelectionQuote(),
        });
      if (action === "reply-preferred") {
        const account = useAppStore
          .getState()
          .accounts.find((item) => item.id === selected.accountId);
        h.openComposer({
          sourceMessage: selected,
          composeMode: preferredReplyMode(
            selected,
            useAppStore.getState().settings.replyToAll,
            account?.email ?? "",
            account?.aliases ?? [],
          ),
          quoteExcerpt: messageSelectionQuote(),
        });
      }
      if (action === "reply-all")
        h.openComposer({
          sourceMessage: selected,
          composeMode: "replyAll",
          quoteExcerpt: messageSelectionQuote(),
        });
      if (action === "reply-bare")
        h.openComposer({
          sourceMessage: selected,
          composeMode: "reply",
          omitQuote: true,
        });
      if (action === "reply-all-bare")
        h.openComposer({
          sourceMessage: selected,
          composeMode: "replyAll",
          omitQuote: true,
        });
      if (action === "reply-list" && listPostAddress(selected.listPost))
        h.openComposer({
          sourceMessage: selected,
          composeMode: "replyList",
          quoteExcerpt: messageSelectionQuote(),
        });
      if (action === "reply-with-attachments")
        void h.replyWithAttachments("reply");
      if (action === "reply-all-with-attachments")
        void h.replyWithAttachments("replyAll");
      if (action === "forward") void h.forwardMessage();
      if (action === "forward-conversation")
        void forwardLoadedConversation(selected);
      if (action === "forward-attachment") void h.forwardAsAttachment();
      if (action === "redirect") h.redirectMessage();
      if (action === "edit-as-new") void h.editAsNewMessage();
      if (action === "archive") void h.move("archive");
      if (action === "move-to-inbox") void h.moveToInbox();
      if (action === "trash") void h.move("trash");
      if (action === "delete-forever") void h.deleteForever();
      if (action === "toggle-read") void h.setRead();
      if (action === "toggle-star") void h.setStarred();
      if (action === "junk") void h.move("junk");
      if (action === "block-sender") void h.blockSender();
      if (action === "unblock-sender") void h.unblockSender();
      if (action === "block-domain") void h.blockDomain();
      if (action === "unblock-domain") void h.unblockDomain();
      if (action === "mute-conversation") void h.muteConversation();
      if (action === "not-junk") {
        const inbox = useAppStore
          .getState()
          .mailboxes.find((box) => box.role === "inbox");
        if (inbox) void h.moveToMailbox(inbox.id);
      }
      if (action === "copy-recipients") void h.copyRecipients();
      if (action === "save-eml") {
        void api
          .saveMessageEml(selected.accountId, selected.id)
          .catch((cause) => {
            useAppStore.getState().setError(String(cause));
          });
      }
      if (action === "print" || action === "file-print") {
        window.dispatchEvent(new Event("postal:print-message"));
      }
      if (action === "find-in-message") {
        window.dispatchEvent(new Event("postal:find-in-message"));
      }
      if (action === "create-rule") {
        const contains = senderRuleNeedle(selected.senderAddress);
        if (!contains) return;
        window.dispatchEvent(
          new CustomEvent("postal:create-rule", {
            detail: { accountId: selected.accountId, contains, field: "from" },
          }),
        );
      }
      if (action === "create-subject-rule") {
        const contains = subjectRuleNeedle(selected.subject);
        if (!contains) return;
        window.dispatchEvent(
          new CustomEvent("postal:create-rule", {
            detail: {
              accountId: selected.accountId,
              contains,
              field: "subject",
            },
          }),
        );
      }
    };
    window.addEventListener("postal:menu-action", menuAction);
    return () => window.removeEventListener("postal:menu-action", menuAction);
  }, []);

  useEffect(() => {
    const print = () => printMessageRef.current();
    const find = () => {
      setFindOpen(true);
      window.setTimeout(() => findInputRef.current?.focus(), 0);
    };
    const scroll = (event: Event) => {
      const direction = (event as CustomEvent<1 | -1>).detail;
      scrollMessage(direction);
    };
    window.addEventListener("postal:print-message", print);
    window.addEventListener("postal:find-in-message", find);
    window.addEventListener("postal:scroll-reader", scroll);
    const openSnooze = () => {
      setSnoozeConversation(false);
      setSnoozeOpen(true);
    };
    const openConversationSnooze = () => {
      keepSnooze.current = true;
      setSnoozeConversation(true);
      setSnoozeOpen(true);
    };
    const moveMailbox = (event: Event) => {
      const mailboxId = (event as CustomEvent<number>).detail;
      if (typeof mailboxId === "number") {
        void menuHandlersRef.current.moveToMailbox(mailboxId);
      }
    };
    const copyMailbox = (event: Event) => {
      const mailboxId = (event as CustomEvent<number>).detail;
      if (typeof mailboxId === "number") {
        void menuHandlersRef.current.copyToMailbox(mailboxId);
      }
    };
    const contextAction = (event: Event) => {
      const detail = (event as CustomEvent<ContextMenuActionDetail>).detail;
      if (!detail) return;
      if (detail.id === "find-in-message" && detail.target.kind === "reader") {
        find();
        return;
      }
      if (detail.id === "print" && detail.target.kind === "reader") {
        print();
        return;
      }
      if (detail.id === "copy" && detail.target.kind === "reader") {
        const iframeText =
          frame.current?.contentDocument?.getSelection()?.toString() ?? "";
        const parentText = window.getSelection()?.toString() ?? "";
        const text = iframeText || parentText;
        if (text)
          void navigator.clipboard.writeText(text).catch(() => undefined);
        return;
      }
      if (detail.id === "copy-subject" && detail.target.kind === "reader") {
        const subject =
          useAppStore.getState().selectedMessage?.subject.trim() ?? "";
        if (subject)
          void navigator.clipboard.writeText(subject).catch(() => undefined);
        return;
      }
      if (
        detail.id === "copy-sender-address" &&
        detail.target.kind === "reader"
      ) {
        const address = addressMailbox(
          useAppStore.getState().selectedMessage?.senderAddress ?? "",
        );
        if (address)
          void navigator.clipboard.writeText(address).catch(() => undefined);
        return;
      }
      if (
        detail.id === "copy-message-text" &&
        detail.target.kind === "reader"
      ) {
        const selected = useAppStore.getState().selectedMessage;
        const text = selected ? readableMessageText(selected) : "";
        if (text)
          void navigator.clipboard.writeText(text).catch(() => undefined);
        return;
      }
      if (detail.target.kind !== "attachment") return;
      if (detail.id === "preview") {
        void menuHandlersRef.current.previewFile(detail.target.attachmentId);
      }
      if (detail.id === "download") {
        void menuHandlersRef.current.download(
          detail.target.attachmentId,
          detail.target.filename,
        );
      }
    };
    window.addEventListener("postal:open-snooze", openSnooze);
    window.addEventListener(
      "postal:open-snooze-conversation",
      openConversationSnooze,
    );
    window.addEventListener("postal:move-mailbox", moveMailbox);
    window.addEventListener("postal:copy-mailbox", copyMailbox);
    window.addEventListener(CONTEXT_ACTION_EVENT, contextAction);
    return () => {
      window.removeEventListener("postal:print-message", print);
      window.removeEventListener("postal:find-in-message", find);
      window.removeEventListener("postal:scroll-reader", scroll);
      window.removeEventListener("postal:open-snooze", openSnooze);
      window.removeEventListener(
        "postal:open-snooze-conversation",
        openConversationSnooze,
      );
      window.removeEventListener("postal:move-mailbox", moveMailbox);
      window.removeEventListener("postal:copy-mailbox", copyMailbox);
      window.removeEventListener(CONTEXT_ACTION_EVENT, contextAction);
    };
  }, []);

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
  const frameSource = currentLoadedHtml ?? sanitized?.html ?? "";
  const frameHtml = useMemo(
    () =>
      messageFrameDocument(
        collapseQuotedMail(
          markHtmlText(
            withFrameLinks(frameSource),
            textHighlightTerms(searchQuery ?? ""),
          ),
          strings.reader.quotedText,
        ),
        settings.textScale,
        // Colorless mail follows dark mode; designed mail keeps its page.
        isDark && !hasAuthorColors(frameSource),
      ) +
      // Identical bodies must still reload, so the frame gets its link wiring.
      `<!-- ${messageId ?? ""} -->`,
    [frameSource, isDark, messageId, searchQuery, settings.textScale],
  );

  useEffect(() => {
    contentOperation.current += 1;
  }, [messageId]);

  useEffect(() => {
    const operation = ++contentOperation.current;
    if (
      !messageId ||
      !messageAccountId ||
      !sanitized ||
      inlineAttachments.length === 0
    )
      return;
    const doc = new DOMParser().parseFromString(sanitized.html, "text/html");
    void hydrateInlineImages(
      doc,
      messageAccountId,
      messageId,
      inlineAttachments,
    ).then(() => {
      if (contentOperation.current === operation)
        setLoadedHtml({ messageId, html: doc.body.innerHTML });
    });
    return () => {
      if (contentOperation.current === operation) contentOperation.current += 1;
    };
  }, [inlineAttachments, messageAccountId, messageId, sanitized]);

  const frameLinkCleanup = useRef<(() => void) | undefined>(undefined);

  // Shrink fixed-width mail to the pane, like other mail apps, but never
  // below a readable size; past that it scrolls sideways.
  const fitFrameContent = useCallback(() => {
    const iframe = frame.current;
    const doc = iframe?.contentDocument;
    if (!doc?.body || !iframe) return;
    doc.body.style.zoom = "";
    const header = iframe
      .closest(".reader-pane")
      ?.querySelector(".message-header");
    if (header instanceof HTMLElement) {
      const style = getComputedStyle(header);
      doc.body.style.marginLeft = style.paddingLeft;
      doc.body.style.marginRight = style.paddingRight;
    }
    const root = doc.documentElement;
    const available = root.clientWidth;
    const needed = root.scrollWidth;
    if (available > 0 && needed > available + 1) {
      const zoom = Math.max(MIN_FIT_ZOOM, available / needed);
      doc.body.style.zoom = String(Math.floor(zoom * 100) / 100);
    }
  }, []);

  useEffect(() => {
    const node = frame.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fitFrameContent());
    observer.observe(node);
    return () => observer.disconnect();
  }, [fitFrameContent, frameHtml]);

  function wireFrameLinks() {
    frameLinkCleanup.current?.();
    frameLinkCleanup.current = undefined;
    const doc = frame.current?.contentDocument;
    const body = doc?.body;
    if (!doc || !body) return;
    body.querySelectorAll("[usemap]").forEach((element) => {
      element.removeAttribute("usemap");
    });
    const linkSelector = "a[href], a[data-external-href], area[href]";
    const handleLink = (event: MouseEvent) => {
      if (event.button > 1) return;
      const target = (event.target as HTMLElement).closest<HTMLElement>(
        linkSelector,
      );
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      const marked = target.getAttribute("data-external-href")?.trim() ?? "";
      const href = target.getAttribute("href")?.trim() ?? "";
      const url = /^https?:/i.test(marked)
        ? marked
        : /^https?:/i.test(href)
          ? href
          : /^mailto:/i.test(href)
            ? href
            : "";
      if (/^https?:/i.test(url)) {
        void handleExternalLink(url, target.textContent ?? "");
        return;
      }
      if (/^mailto:/i.test(url)) openComposer({ prefill: parseMailto(url) });
    };
    const blockNativeOpen = (event: MouseEvent) => {
      event.preventDefault();
      const iframe = frame.current;
      if (!iframe) return;
      const rect = iframe.getBoundingClientRect();
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
        linkSelector,
      );
      const marked = target?.getAttribute("data-external-href")?.trim() ?? "";
      const href = target?.getAttribute("href")?.trim() ?? "";
      const url = /^https?:/i.test(marked)
        ? marked
        : /^https?:/i.test(href)
          ? href
          : /^mailto:/i.test(href)
            ? href
            : /^mailto:/i.test(marked)
              ? marked
              : "";
      const detail: IframeContextMenuDetail = {
        x: event.clientX + rect.left,
        y: event.clientY + rect.top,
      };
      if (/^https?:/i.test(url)) {
        detail.href = url;
        const text = differentLinkAddress(target?.textContent ?? "", url);
        if (text) detail.text = text;
      } else if (/^mailto:/i.test(url)) detail.mailto = url;
      window.dispatchEvent(
        new CustomEvent<IframeContextMenuDetail>(IFRAME_CONTEXT_EVENT, {
          detail,
        }),
      );
    };
    const forwardKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const key = event.key;
      const readingKey =
        key === "j" ||
        key === "k" ||
        key === "n" ||
        key === "p" ||
        key === "r" ||
        key === "a" ||
        key === "i" ||
        key === "]" ||
        key === "[" ||
        key === "ArrowDown" ||
        key === "ArrowUp" ||
        key === "Home" ||
        key === "End" ||
        key === "Delete" ||
        key === " ";
      if (!readingKey) return;
      event.preventDefault();
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: event.key,
          code: event.code,
          shiftKey: event.shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    body.addEventListener("click", handleLink);
    body.addEventListener("auxclick", handleLink);
    doc.addEventListener("contextmenu", blockNativeOpen, true);
    doc.addEventListener("keydown", forwardKey);
    const scrolling = doc.scrollingElement ?? doc.documentElement;
    const letterId = message?.id;
    const onLetterScroll = (event: Event) => {
      if (letterId == null) return;
      const top = scrolling.scrollTop;
      if (top <= 0 && !event.isTrusted) return;
      rememberLetterScroll(letterId, top);
    };
    if (letterId != null) {
      const top = rememberedLetterScroll(letterId);
      if (top > 0) scrolling.scrollTop = top;
    }
    scrolling.addEventListener("scroll", onLetterScroll);
    frameLinkCleanup.current = () => {
      body.removeEventListener("click", handleLink);
      body.removeEventListener("auxclick", handleLink);
      doc.removeEventListener("contextmenu", blockNativeOpen, true);
      doc.removeEventListener("keydown", forwardKey);
      scrolling.removeEventListener("scroll", onLetterScroll);
    };
  }

  useEffect(
    () => () => {
      frameLinkCleanup.current?.();
    },
    [],
  );

  useLayoutEffect(() => {
    const letterId = message?.id;
    return () => {
      // Read at cleanup on purpose: the frame may mount after this effect runs.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const doc = frame.current?.contentDocument;
      const scrolling = doc?.scrollingElement ?? doc?.documentElement;
      if (letterId != null && scrolling && scrolling.scrollTop > 0) {
        rememberLetterScroll(letterId, scrolling.scrollTop);
      }
      frameLinkCleanup.current?.();
      frameLinkCleanup.current = undefined;
    };
  }, [message?.id]);

  async function saveChosenAttachments(attachmentIds: string[]) {
    if (!message || downloadingAttachmentId !== undefined) return;
    if (attachmentIds.length === 0) return;
    setDownloadingAttachmentId("chosen");
    try {
      await api.saveChosenAttachments(
        message.accountId,
        message.id,
        attachmentIds,
      );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setDownloadingAttachmentId(undefined);
    }
  }

  async function saveAllAttachments() {
    if (!message || downloadingAttachmentId !== undefined) return;
    setDownloadingAttachmentId("all");
    try {
      await api.saveAllAttachments(message.accountId, message.id);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setDownloadingAttachmentId(undefined);
    }
  }

  async function download(attachmentId: string, filename: string) {
    if (!message || downloadingAttachmentId !== undefined) return;
    setDownloadingAttachmentId(attachmentId);
    try {
      await api.saveAttachment(
        message.accountId,
        message.id,
        attachmentId,
        filename,
      );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setDownloadingAttachmentId(undefined);
    }
  }

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
      {isJunkMailbox || isTrashMailbox ? (
        <div className="remote-content-banner warning" role="status">
          <span>
            {isJunkMailbox ? strings.reader.inJunk : strings.reader.inTrash}
          </span>
          <button type="button" onClick={moveToInbox}>
            {isJunkMailbox
              ? strings.reader.notJunk
              : strings.reader.moveToInbox}
          </button>
        </div>
      ) : null}
      {onContinueDraft
        ? (() => {
            const replyDrafts = drafts.filter(
              (draft) =>
                draft.accountId === message.accountId &&
                draft.sourceMessageId === message.id,
            );
            if (replyDrafts.length === 0) return null;
            const kind = replyDrafts[0]?.sourceKind;
            const note =
              replyDrafts.length > 1
                ? strings.reader.unsentDrafts(replyDrafts.length)
                : kind === "forward"
                  ? strings.reader.unsentForward
                  : kind === "redirect"
                    ? strings.reader.unsentRedirect
                    : strings.reader.unsentReply;
            return (
              <div className="continue-draft">
                <p role="status">{note}</p>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onContinueDraft(replyDrafts[0].id)}
                >
                  {strings.reader.continueDraft}
                </button>
              </div>
            );
          })()
        : null}
      {conversation.length > 1 ? (
        <nav
          className="conversation-index"
          aria-label={strings.reader.conversationMessages}
        >
          {conversation.map((item) => {
            const label = strings.reader.conversationMessage(
              item.subject || strings.common.noSubject,
              indexSender(item),
              formatFullMessageDate(item.receivedAt),
            );
            return (
              <button
                key={item.id}
                type="button"
                aria-current={item.id === message.id ? "true" : undefined}
                aria-label={
                  item.isRead ? label : `${strings.mail.unread}, ${label}`
                }
                onClick={() => {
                  if (item.id !== message.id) onOpenInConversation?.(item);
                }}
              >
                <span>{item.subject || strings.common.noSubject}</span>
                {!item.isRead ? (
                  <span className="conversation-index-unread">
                    {strings.mail.unread}
                  </span>
                ) : null}
                <span className="conversation-index-sender">
                  {indexSender(item)}
                </span>
                <time
                  dateTime={item.receivedAt}
                  title={formatFullMessageDate(item.receivedAt)}
                >
                  {formatMessageDate(item.receivedAt)}
                </time>
              </button>
            );
          })}
        </nav>
      ) : null}
      {receiptView === "ask" ? (
        <div className="remote-content-banner">
          <span>
            {strings.reader.readReceiptAsk(
              message.senderName || message.senderAddress,
              message.dispositionTo ?? "",
            )}
          </span>
          <button
            type="button"
            disabled={receiptBusy}
            onClick={() => void chooseReceipt(true)}
          >
            {strings.reader.sendReceipt}
          </button>
          <button
            type="button"
            disabled={receiptBusy}
            onClick={() => void chooseReceipt(false)}
          >
            {strings.reader.declineReceipt}
          </button>
        </div>
      ) : null}
      {receiptView === "sent" ? (
        <div className="remote-content-banner" role="status">
          <span>{strings.reader.receiptSent}</span>
        </div>
      ) : null}
      {unsubscribeSentFor === message.id ? (
        <div className="remote-content-banner" role="status" aria-live="polite">
          <ShieldCheck aria-hidden="true" />
          <span>
            <strong>{strings.reader.unsubscribeSent}</strong>{" "}
            {strings.reader.unsubscribeSentDetail}
          </span>
        </div>
      ) : null}
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
