import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import {
  CONTEXT_ACTION_EVENT,
  IFRAME_CONTEXT_EVENT,
  type ContextMenuActionDetail,
  type IframeContextMenuDetail,
} from "../contextMenu";
import { strings } from "../i18n";
import { parseMailto } from "../mailto";
import { messageFrameDocument, sanitizeReceivedHtml } from "../security";
import { useAppStore } from "../store";
import type { Attachment, AttachmentPreview, MessageSummary } from "../types";
import { useDialogFocus } from "./useDialogFocus";
import { AppMark } from "./AppMark";
import { AttachmentList } from "./reader/attachmentList";
import { MessageBody } from "./reader/messageBody";
import { MessageHeader } from "./reader/messageHeader";
import { ReaderToolbar } from "./reader/readerToolbar";
import { SnoozePanel } from "./reader/snoozePanel";
import {
  buildPrintDocument,
  hydrateInlineImages,
  moveCounts,
} from "./reader/readerUtils";

function restoreMovedMessage(
  current: MessageSummary[],
  expected: MessageSummary[],
  message: MessageSummary,
  previousIndex: number,
): MessageSummary[] | undefined {
  if (previousIndex < 0) return undefined;
  if (current.some((summary) => summary.id === message.id)) return undefined;
  if (current.length > expected.length) return undefined;
  const expectedIndexes = new Map(
    expected.map((summary, index) => [summary.id, index]),
  );
  let lastIndex = -1;
  let insertAt = 0;
  for (const summary of current) {
    const index = expectedIndexes.get(summary.id);
    if (index === undefined || index < lastIndex) return undefined;
    if (index < previousIndex) insertAt += 1;
    lastIndex = index;
  }
  const restored = [...current];
  restored.splice(insertAt, 0, message);
  return restored;
}

export function MessageReader({
  onSnoozed,
}: {
  onSnoozed?: (accountId: string, messageId: number) => void | Promise<void>;
}) {
  const message = useAppStore((state) => state.selectedMessage);
  const selectMessage = useAppStore((state) => state.selectMessage);
  const mailboxes = useAppStore((state) => state.mailboxes);
  const setMailboxes = useAppStore((state) => state.setMailboxes);
  const setMessages = useAppStore((state) => state.setMessages);
  const openComposer = useAppStore((state) => state.openComposer);
  const settings = useAppStore((state) => state.settings);
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
  const [loadingImagesFor, setLoadingImagesFor] = useState<number>();
  const [preparingForward, setPreparingForward] = useState(false);
  const [downloadingAttachmentId, setDownloadingAttachmentId] =
    useState<string>();
  const [preview, setPreview] = useState<{
    messageId: number;
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
      setPreview({ messageId: targetMessageId, preview: loaded });
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPreviewAttachmentId(undefined);
    }
  }
  const [showDetailsFor, setShowDetailsFor] = useState<number>();
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const findInputRef = useRef<HTMLInputElement>(null);

  function printMessage() {
    if (!message) return;
    const html = buildPrintDocument(message, loadedHtml, settings.textScale);
    const printer = document.createElement("iframe");
    // Intentionally unsandboxed: the parent calls contentWindow.print(), but a
    // sandboxed srcdoc frame is cross-origin (print() is not exposed on the
    // cross-origin WindowProxy) and its modals flag blocks window.print(), so
    // sandbox="allow-modals" alone would break printing. buildPrintDocument
    // wraps sanitized HTML in a restrictive CSP, and this frame is removed
    // immediately after printing.
    printer.setAttribute("aria-hidden", "true");
    printer.style.position = "fixed";
    printer.style.width = "0";
    printer.style.height = "0";
    printer.style.border = "0";
    printer.srcdoc = html;
    printer.addEventListener("load", () => {
      printer.contentWindow?.focus();
      printer.contentWindow?.print();
      window.setTimeout(() => printer.remove(), 1500);
    });
    document.body.appendChild(printer);
  }
  const printMessageRef = useRef(printMessage);
  printMessageRef.current = printMessage;

  function scrollMessage(direction: 1 | -1) {
    const amount = Math.round(window.innerHeight * 0.85) * direction;
    const frameWindow = frame.current?.contentWindow;
    if (frameWindow) {
      frameWindow.scrollBy(0, amount);
      return;
    }
    bodyRef.current?.scrollBy?.({ top: amount, behavior: "auto" });
  }

  function findInMessage() {
    const query = findQuery.trim();
    if (!query) return;
    const frameWindow = frame.current?.contentWindow as
      (Window & { find?: (text: string) => boolean }) | null;
    if (frameWindow?.find) {
      frameWindow.find(query);
      return;
    }
    const body = bodyRef.current;
    if (!body) return;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.textContent ?? "";
      const index = text.toLowerCase().indexOf(query.toLowerCase());
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + query.length);
      selection?.addRange(range);
      (node.parentElement as HTMLElement | null)?.scrollIntoView({
        block: "center",
      });
      break;
    }
  }

  async function snoozeCurrentMessage(untilIso: string) {
    if (!message) return;
    const target = message;
    try {
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
    restoreMoreFocus();
  }, [restoreMoreFocus]);
  const closeMoreMenu = useCallback(() => {
    setMoreOpen(false);
    restoreMoreFocus();
  }, [restoreMoreFocus]);
  const dialogRef = useDialogFocus(() => {
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
    selectMessage(undefined);
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
    if (snoozeOpen) setSnoozeOpen(false);
  }

  const account = accounts.find((a) => a.id === message?.accountId);
  const currentMailbox = mailboxes.find((m) => m.id === message?.mailboxId);
  const isArchiveMailbox = currentMailbox?.role === "archive";
  const isTrashMailbox = currentMailbox?.role === "trash";
  const isJunkMailbox = currentMailbox?.role === "junk";

  async function handleExternalLink(url: string) {
    let check;
    try {
      check = await api.inspectExternalUrl(url);
    } catch {
      return;
    }
    const shownUrl =
      check.url.length > 1400 ? `${check.url.slice(0, 1400)}…` : check.url;
    if (check.reportedThreat) {
      const proceed = await api.showNativeConfirm(
        strings.reader.reportedThreatTitle,
        strings.reader.reportedThreat(check.hostname, shownUrl),
      );
      if (!proceed) return;
      const anyway = await api.showNativeConfirm(
        strings.reader.reportedThreatTitle,
        strings.reader.reportedThreatOpenAnyway,
      );
      if (!anyway) return;
    } else {
      const confirmed = await api.showNativeConfirm(
        strings.appName,
        strings.reader.openLink(check.hostname, shownUrl),
      );
      if (!confirmed) return;
    }
    try {
      await api.openExternalUrl(check.url, check.reportedThreat);
    } catch {
      // Opening failures stay in the generic native error; do not surface URLs.
    }
  }

  const menuHandlersRef = useRef({
    openComposer,
    forwardMessage,
    move,
    moveToMailbox,
    setRead,
    setStarred,
    previewFile,
    download,
  });

  useEffect(() => {
    menuHandlersRef.current = {
      openComposer,
      forwardMessage,
      move,
      moveToMailbox,
      setRead,
      setStarred,
      previewFile,
      download,
    };
  });

  useEffect(() => {
    const menuAction = (event: Event) => {
      const h = menuHandlersRef.current;
      const selected = useAppStore.getState().selectedMessage;
      if (!selected) return;
      const action = (event as CustomEvent<string>).detail;
      if (action === "reply")
        h.openComposer({ sourceMessage: selected, composeMode: "reply" });
      if (action === "reply-all")
        h.openComposer({ sourceMessage: selected, composeMode: "replyAll" });
      if (action === "forward") void h.forwardMessage();
      if (action === "archive") void h.move("archive");
      if (action === "trash") void h.move("trash");
      if (action === "toggle-read") void h.setRead();
      if (action === "toggle-star") void h.setStarred();
      if (action === "junk") void h.move("junk");
      if (action === "not-junk") {
        const inbox = useAppStore
          .getState()
          .mailboxes.find((box) => box.role === "inbox");
        if (inbox) void h.moveToMailbox(inbox.id);
      }
      if (action === "print" || action === "file-print") {
        window.dispatchEvent(new Event("postal:print-message"));
      }
      if (action === "find-in-message") {
        window.dispatchEvent(new Event("postal:find-in-message"));
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
    const openSnooze = () => setSnoozeOpen(true);
    const moveMailbox = (event: Event) => {
      const mailboxId = (event as CustomEvent<number>).detail;
      if (typeof mailboxId === "number") {
        void menuHandlersRef.current.moveToMailbox(mailboxId);
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
    window.addEventListener("postal:move-mailbox", moveMailbox);
    window.addEventListener(CONTEXT_ACTION_EVENT, contextAction);
    return () => {
      window.removeEventListener("postal:print-message", print);
      window.removeEventListener("postal:find-in-message", find);
      window.removeEventListener("postal:scroll-reader", scroll);
      window.removeEventListener("postal:open-snooze", openSnooze);
      window.removeEventListener("postal:move-mailbox", moveMailbox);
      window.removeEventListener(CONTEXT_ACTION_EVENT, contextAction);
    };
  }, []);

  const htmlBody = message?.htmlBody;
  const attachments = message?.attachments;
  const sanitized = useMemo(
    () => (htmlBody ? sanitizeReceivedHtml(htmlBody) : undefined),
    [htmlBody],
  );
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
  const loadingImages = loadingImagesFor === messageId;
  const frameHtml = messageFrameDocument(
    currentLoadedHtml ?? sanitized?.html ?? "",
    settings.textScale,
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
        void handleExternalLink(url);
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
      if (/^https?:/i.test(url)) detail.href = url;
      else if (/^mailto:/i.test(url)) detail.mailto = url;
      window.dispatchEvent(
        new CustomEvent<IframeContextMenuDetail>(IFRAME_CONTEXT_EVENT, {
          detail,
        }),
      );
    };
    body.addEventListener("click", handleLink);
    body.addEventListener("auxclick", handleLink);
    doc.addEventListener("contextmenu", blockNativeOpen, true);
    frameLinkCleanup.current = () => {
      body.removeEventListener("click", handleLink);
      body.removeEventListener("auxclick", handleLink);
      doc.removeEventListener("contextmenu", blockNativeOpen, true);
    };
  }

  useEffect(
    () => () => {
      frameLinkCleanup.current?.();
    },
    [],
  );

  async function loadImages() {
    if (!sanitized || loadingImages || !messageId) return;
    setLoadingImagesFor(messageId);
    const targetId = messageId;
    const operation = ++contentOperation.current;
    try {
      const doc = new DOMParser().parseFromString(
        currentLoadedHtml ?? sanitized.html,
        "text/html",
      );
      const images = [
        ...doc.querySelectorAll<HTMLImageElement>("img[data-remote-src]"),
      ].slice(0, 60);
      const batchSize = 4;
      for (let i = 0; i < images.length; i += batchSize) {
        if (contentOperation.current !== operation) break;
        const batch = images.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (image) => {
            const url = image.dataset.remoteSrc;
            if (!url) return;
            try {
              const result = await api.fetchRemoteImage(url);
              if (result.status === "blocked") {
                image.dataset.contentBlocked = "true";
                image.alt = strings.reader.filteredImage;
              } else if (result.status === "reportedThreat") {
                image.dataset.threatBlocked = "true";
                image.alt = strings.reader.threatImage;
              } else {
                image.src = result.dataUrl;
                image.classList.remove("remote-image-blocked");
              }
              image.removeAttribute("data-remote-src");
            } catch {
              // Keep placeholder on individual image error without blocking other images
            }
          }),
        );
      }
      if (message && contentOperation.current === operation)
        await hydrateInlineImages(
          doc,
          message.accountId,
          message.id,
          inlineAttachments,
        );
      if (message && contentOperation.current === operation)
        setLoadedHtml({ messageId: message.id, html: doc.body.innerHTML });
    } catch (cause) {
      if (contentOperation.current === operation) setError(String(cause));
    } finally {
      setLoadingImagesFor((current) =>
        current === targetId ? undefined : current,
      );
    }
  }

  async function setStarred() {
    const current = useAppStore.getState();
    const message = current.selectedMessage;
    if (!message) return;
    const operation = ++starredOperation.current;
    const viewMailboxId = current.activeMailboxId;
    const next = !message.isStarred;
    selectMessage({ ...message, isStarred: next });
    setMessages(
      current.messages.map((summary) =>
        summary.id === message.id ? { ...summary, isStarred: next } : summary,
      ),
      current.messageCursor,
      current.hasMoreMessages,
    );
    try {
      await api.setMessageFlags(message.accountId, message.id, undefined, next);
    } catch (cause) {
      const current = useAppStore.getState();
      if (
        operation !== starredOperation.current ||
        current.activeAccountId !== message.accountId ||
        current.activeMailboxId !== viewMailboxId ||
        current.activeLocalView
      )
        return;
      setMessages(
        current.messages.map((summary) =>
          summary.id === message.id && summary.isStarred === next
            ? { ...summary, isStarred: message.isStarred }
            : summary,
        ),
        current.messageCursor,
        current.hasMoreMessages,
      );
      if (
        current.selectedMessage?.id === message.id &&
        current.selectedMessage.isStarred === next
      )
        selectMessage({
          ...current.selectedMessage,
          isStarred: message.isStarred,
        });
      setError(String(cause));
    }
  }

  async function setRead() {
    const current = useAppStore.getState();
    const message = current.selectedMessage;
    if (!message) return;
    const operation = ++readOperation.current;
    const viewMailboxId = current.activeMailboxId;
    const next = !message.isRead;
    const previousUnreadCount = current.mailboxes.find(
      (mailbox) => mailbox.id === message.mailboxId,
    )?.unreadCount;
    selectMessage({ ...message, isRead: next });
    setMailboxes(
      current.mailboxes.map((mailbox) =>
        mailbox.id === message.mailboxId
          ? {
              ...mailbox,
              unreadCount: Math.max(0, mailbox.unreadCount + (next ? -1 : 1)),
            }
          : mailbox,
      ),
    );
    setMessages(
      current.messages.map((summary) =>
        summary.id === message.id ? { ...summary, isRead: next } : summary,
      ),
      current.messageCursor,
      current.hasMoreMessages,
    );
    try {
      await api.setMessageFlags(message.accountId, message.id, next, undefined);
    } catch (cause) {
      const current = useAppStore.getState();
      if (
        operation !== readOperation.current ||
        current.activeAccountId !== message.accountId ||
        current.activeMailboxId !== viewMailboxId ||
        current.activeLocalView
      )
        return;
      setMessages(
        current.messages.map((summary) =>
          summary.id === message.id && summary.isRead === next
            ? { ...summary, isRead: message.isRead }
            : summary,
        ),
        current.messageCursor,
        current.hasMoreMessages,
      );
      if (
        current.selectedMessage?.id === message.id &&
        current.selectedMessage.isRead === next
      )
        selectMessage({ ...current.selectedMessage, isRead: message.isRead });
      if (previousUnreadCount !== undefined) {
        const expectedUnreadCount = previousUnreadCount + (next ? -1 : 1);
        setMailboxes(
          current.mailboxes.map((mailbox) =>
            mailbox.id === message.mailboxId &&
            mailbox.unreadCount === expectedUnreadCount
              ? { ...mailbox, unreadCount: previousUnreadCount }
              : mailbox,
          ),
        );
      }
      setError(String(cause));
    }
  }

  async function move(role: "archive" | "trash" | "junk") {
    const snapshot = useAppStore.getState();
    const message = snapshot.selectedMessage;
    if (!message) return;
    const mailboxes = snapshot.mailboxes;
    const messages = snapshot.messages;
    const messageCursor = snapshot.messageCursor;
    const hasMoreMessages = snapshot.hasMoreMessages;
    const destination = mailboxes.find((mailbox) => mailbox.role === role);
    const source = mailboxes.find(
      (mailbox) => mailbox.id === message.mailboxId,
    );
    if (
      destination?.id === message.mailboxId ||
      (destination && source?.name === destination.name)
    )
      return;
    const operation = (moveOperations.current.get(message.id) ?? 0) + 1;
    moveOperations.current.set(message.id, operation);
    const viewMailboxId = snapshot.activeMailboxId;
    const previousUnreadCounts = new Map(
      mailboxes.map((mailbox) => [mailbox.id, mailbox.unreadCount]),
    );
    const previousIndex = messages.findIndex(
      (summary) => summary.id === message.id,
    );
    setMailboxes(moveCounts(mailboxes, message, destination?.id));
    setMessages(
      messages.filter((summary) => summary.id !== message.id),
      messageCursor,
      hasMoreMessages,
    );
    selectMessage(undefined);
    try {
      await api.moveMessage(message.accountId, message.id, role);
    } catch (cause) {
      const current = useAppStore.getState();
      if (
        moveOperations.current.get(message.id) !== operation ||
        current.activeAccountId !== message.accountId ||
        current.activeMailboxId !== viewMailboxId ||
        current.activeLocalView
      )
        return;
      const expectedMessages = messages.filter(
        (summary) => summary.id !== message.id,
      );
      const restoredMessages = restoreMovedMessage(
        current.messages,
        expectedMessages,
        message,
        previousIndex,
      );
      if (restoredMessages) {
        setMessages(
          restoredMessages,
          current.messageCursor,
          current.hasMoreMessages,
        );
      }
      setMailboxes(
        current.mailboxes.map((mailbox) => {
          const previousUnreadCount = previousUnreadCounts.get(mailbox.id);
          if (previousUnreadCount === undefined) return mailbox;
          const delta =
            mailbox.id === message.mailboxId
              ? message.isRead
                ? 0
                : -1
              : mailbox.id === destination?.id
                ? message.isRead
                  ? 0
                  : 1
                : 0;
          return mailbox.unreadCount === previousUnreadCount + delta
            ? { ...mailbox, unreadCount: previousUnreadCount }
            : mailbox;
        }),
      );
      if (restoredMessages && !current.selectedMessage) selectMessage(message);
      setError(String(cause));
    }
  }

  async function moveToMailbox(mailboxId: number) {
    const snapshot = useAppStore.getState();
    const message = snapshot.selectedMessage;
    if (!message) return;
    if (mailboxId === message.mailboxId) return;
    const mailboxes = snapshot.mailboxes;
    const messages = snapshot.messages;
    const messageCursor = snapshot.messageCursor;
    const hasMoreMessages = snapshot.hasMoreMessages;
    const operation = (moveOperations.current.get(message.id) ?? 0) + 1;
    moveOperations.current.set(message.id, operation);
    const viewMailboxId = snapshot.activeMailboxId;
    const previousUnreadCounts = new Map(
      mailboxes.map((mailbox) => [mailbox.id, mailbox.unreadCount]),
    );
    const previousIndex = messages.findIndex(
      (summary) => summary.id === message.id,
    );
    setMailboxes(moveCounts(mailboxes, message, mailboxId));
    setMessages(
      messages.filter((summary) => summary.id !== message.id),
      messageCursor,
      hasMoreMessages,
    );
    selectMessage(undefined);
    try {
      await api.moveMessageToMailbox(message.accountId, message.id, mailboxId);
    } catch (cause) {
      const current = useAppStore.getState();
      if (
        moveOperations.current.get(message.id) !== operation ||
        current.activeAccountId !== message.accountId ||
        current.activeMailboxId !== viewMailboxId ||
        current.activeLocalView
      )
        return;
      const expectedMessages = messages.filter(
        (summary) => summary.id !== message.id,
      );
      const restoredMessages = restoreMovedMessage(
        current.messages,
        expectedMessages,
        message,
        previousIndex,
      );
      if (restoredMessages) {
        setMessages(
          restoredMessages,
          current.messageCursor,
          current.hasMoreMessages,
        );
      }
      setMailboxes(
        current.mailboxes.map((mailbox) => {
          const previousUnreadCount = previousUnreadCounts.get(mailbox.id);
          if (previousUnreadCount === undefined) return mailbox;
          const delta =
            mailbox.id === message.mailboxId
              ? message.isRead
                ? 0
                : -1
              : mailbox.id === mailboxId
                ? message.isRead
                  ? 0
                  : 1
                : 0;
          return mailbox.unreadCount === previousUnreadCount + delta
            ? { ...mailbox, unreadCount: previousUnreadCount }
            : mailbox;
        }),
      );
      if (restoredMessages && !current.selectedMessage) selectMessage(message);
      setError(String(cause));
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

  async function forwardMessage() {
    const message = useAppStore.getState().selectedMessage;
    if (!message || preparingForward) return;
    const operation = ++forwardOperation.current;
    const messageId = message.id;
    const accountId = message.accountId;
    setPreparingForward(true);
    try {
      const attachments = await api.prepareForwardAttachments(
        accountId,
        messageId,
      );
      const current = useAppStore.getState();
      if (
        operation !== forwardOperation.current ||
        current.activeAccountId !== accountId ||
        current.selectedMessage?.id !== messageId
      )
        return;
      openComposer({
        sourceMessage: message,
        composeMode: "forward",
        prefill: { attachments },
      });
    } catch (cause) {
      const current = useAppStore.getState();
      if (
        operation === forwardOperation.current &&
        current.activeAccountId === accountId &&
        current.selectedMessage?.id === messageId
      )
        setError(String(cause));
    } finally {
      if (operation === forwardOperation.current) setPreparingForward(false);
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
      <section className="reader-pane empty-reader" id="reader-pane">
        <AppMark size={60} className="brand-watermark" />
        <p>{strings.mail.noMessage}</p>
      </section>
    );

  const showDetails = showDetailsFor === message.id;

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
        onBack={() => selectMessage(undefined)}
        onReply={() =>
          openComposer({ sourceMessage: message, composeMode: "reply" })
        }
        onReplyAll={() =>
          openComposer({ sourceMessage: message, composeMode: "replyAll" })
        }
        onForward={() => void forwardMessage()}
        onArchive={() => void move("archive")}
        onTrash={() => void move("trash")}
        onPrint={printMessage}
        onToggleRead={() => void setRead()}
        onToggleStar={() => void setStarred()}
        onMoveJunk={() => void move("junk")}
        onMoveToInbox={() => {
          const inbox = mailboxes.find((box) => box.role === "inbox");
          if (inbox) void moveToMailbox(inbox.id);
        }}
        onMoveToMailbox={(mailboxId) => void moveToMailbox(mailboxId)}
        onOpenSnooze={() => setSnoozeOpen(true)}
        onToggleMore={() => setMoreOpen((value) => !value)}
        onOpenMore={() => setMoreOpen(true)}
        onCloseMore={closeMoreMenu}
        onDismissMore={() => setMoreOpen(false)}
      />
      {snoozeOpen ? (
        <SnoozePanel
          onSnooze={(untilIso) => void snoozeCurrentMessage(untilIso)}
          onClose={closeSnoozePanel}
        />
      ) : null}
      <MessageHeader
        message={message}
        account={account}
        currentMailbox={currentMailbox}
        showDetails={showDetails}
        onToggleDetails={() =>
          setShowDetailsFor((id) =>
            id === message.id ? undefined : message.id,
          )
        }
        titleRef={titleRef}
        treatAsOverlay={treatAsOverlay}
      />
      <MessageBody
        message={message}
        sanitized={sanitized}
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
        onFindQueryChange={setFindQuery}
        onCloseFind={() => {
          setFindOpen(false);
          setFindQuery("");
        }}
        onSubmitFind={findInMessage}
        onLoadImages={() => void loadImages()}
        onFrameLoad={wireFrameLinks}
        onOpenLink={(url) => void handleExternalLink(url)}
        onOpenMailto={(url) => openComposer({ prefill: parseMailto(url) })}
      />
      <AttachmentList
        message={message}
        preview={preview}
        downloadingAttachmentId={downloadingAttachmentId}
        previewAttachmentId={previewAttachmentId}
        isPreviewable={isPreviewable}
        onPreview={previewFile}
        onDownload={download}
        onPreviewDownload={() => {
          const current = message.attachments.find(
            (item) =>
              item.filename === preview?.preview.filename && !item.inline,
          );
          if (current) void download(current.id, current.filename);
        }}
        onPreviewClose={() => setPreview(null)}
      />
    </article>
  );
}
