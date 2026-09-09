import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Download,
  Eye,
  FolderInput,
  Forward,
  Image,
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
import { api } from "../api";
import { formatBytes, formatFullMessageDate } from "../format";
import { strings } from "../i18n";
import { parseMailto } from "../mailto";
import { messageFrameDocument, sanitizeReceivedHtml } from "../security";
import { useAppStore } from "../store";
import type { Attachment, AttachmentPreview } from "../types";
import { moveToolbarFocus } from "./toolbarNav";
import { useDialogFocus } from "./useDialogFocus";

export function MessageReader() {
  const message = useAppStore((state) => state.selectedMessage);
  const selectMessage = useAppStore((state) => state.selectMessage);
  const activeMailboxId = useAppStore((state) => state.activeMailboxId);
  const mailboxes = useAppStore((state) => state.mailboxes);
  const setMailboxes = useAppStore((state) => state.setMailboxes);
  const messages = useAppStore((state) => state.messages);
  const messageCursor = useAppStore((state) => state.messageCursor);
  const hasMoreMessages = useAppStore((state) => state.hasMoreMessages);
  const setMessages = useAppStore((state) => state.setMessages);
  const openComposer = useAppStore((state) => state.openComposer);
  const settings = useAppStore((state) => state.settings);
  const setError = useAppStore((state) => state.setError);
  const accounts = useAppStore((state) => state.accounts);
  const frame = useRef<HTMLIFrameElement>(null);
  const contentOperation = useRef(0);
  const starredOperation = useRef(0);
  const readOperation = useRef(0);
  const moveOperation = useRef(0);
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
  const bodyRef = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const findInputRef = useRef<HTMLInputElement>(null);

  function printMessage() {
    if (!message) return;
    const from = message.senderName
      ? `${message.senderName} <${message.senderAddress}>`
      : message.senderAddress;
    const header = [
      `<p><strong>${escapePrint(strings.reader.from)}</strong> ${escapePrint(from)}</p>`,
      `<p><strong>${escapePrint(strings.reader.to)}</strong> ${escapePrint(message.to.join(", ") || strings.reader.noRecipients)}</p>`,
      message.cc.length
        ? `<p><strong>${escapePrint(strings.reader.cc)}</strong> ${escapePrint(message.cc.join(", "))}</p>`
        : "",
      `<p><strong>${escapePrint(strings.reader.subject)}</strong> ${escapePrint(message.subject || strings.common.noSubject)}</p>`,
      `<p><strong>${escapePrint(strings.reader.date)}</strong> ${escapePrint(formatFullMessageDate(message.receivedAt))}</p>`,
    ].join("");
    const body =
      loadedHtml?.messageId === message.id && loadedHtml.html
        ? loadedHtml.html
        : `<pre style="white-space:pre-wrap;font:inherit">${escapePrint(message.textBody)}</pre>`;
    const html = messageFrameDocument(
      `<section style="margin:0 0 16px;padding:0 0 12px;border-bottom:1px solid #c8d2dc">${header}</section>${body}`,
      settings.textScale,
    );
    const printer = document.createElement("iframe");
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
    bodyRef.current?.scrollBy({ top: amount, behavior: "auto" });
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
    try {
      await api.snoozeMessage(message.accountId, message.id, untilIso);
      setSnoozeOpen(false);
      selectMessage(undefined);
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
  const dialogRef = useDialogFocus(() => {
    if (preview) {
      setPreview(null);
      return;
    }
    if (snoozeOpen) {
      setSnoozeOpen(false);
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
    const close = (event: MouseEvent) => {
      if (!moreMenuRef.current?.contains(event.target as Node)) {
        setMoreOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (snoozeOpen) {
        setSnoozeOpen(false);
        return;
      }
      setMoreOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen, snoozeOpen]);

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
    message,
    openComposer,
    forwardMessage,
    move,
    setRead,
    setStarred,
  });

  useEffect(() => {
    menuHandlersRef.current = {
      message,
      openComposer,
      forwardMessage,
      move,
      setRead,
      setStarred,
    };
  });

  useEffect(() => {
    const menuAction = (event: Event) => {
      const h = menuHandlersRef.current;
      if (!h.message) return;
      const action = (event as CustomEvent<string>).detail;
      if (action === "reply")
        h.openComposer({ sourceMessage: h.message, composeMode: "reply" });
      if (action === "reply-all")
        h.openComposer({ sourceMessage: h.message, composeMode: "replyAll" });
      if (action === "forward") void h.forwardMessage();
      if (action === "archive") void h.move("archive");
      if (action === "trash") void h.move("trash");
      if (action === "toggle-read") void h.setRead();
      if (action === "toggle-star") void h.setStarred();
      if (action === "junk") void h.move("junk");
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
    return () => {
      window.removeEventListener("postal:print-message", print);
      window.removeEventListener("postal:find-in-message", find);
      window.removeEventListener("postal:scroll-reader", scroll);
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
    const body = frame.current?.contentDocument?.body;
    if (!body) return;
    const handleLink = (event: MouseEvent) => {
      if (event.button > 1) return;
      const target = (event.target as HTMLElement).closest<HTMLAnchorElement>(
        "a[href], a[data-external-href]",
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
    const blockNativeOpen = (event: Event) => {
      if (
        (event.target as HTMLElement).closest("a[href], a[data-external-href]")
      ) {
        event.preventDefault();
      }
    };
    body.addEventListener("click", handleLink);
    body.addEventListener("auxclick", handleLink);
    body.addEventListener("contextmenu", blockNativeOpen);
    frameLinkCleanup.current = () => {
      body.removeEventListener("click", handleLink);
      body.removeEventListener("auxclick", handleLink);
      body.removeEventListener("contextmenu", blockNativeOpen);
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
    if (!message) return;
    const operation = ++starredOperation.current;
    const viewMailboxId = activeMailboxId;
    const next = !message.isStarred;
    selectMessage({ ...message, isStarred: next });
    setMessages(
      messages.map((summary) =>
        summary.id === message.id ? { ...summary, isStarred: next } : summary,
      ),
      messageCursor,
      hasMoreMessages,
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
    if (!message) return;
    const operation = ++readOperation.current;
    const viewMailboxId = activeMailboxId;
    const next = !message.isRead;
    const previousUnreadCount = mailboxes.find(
      (mailbox) => mailbox.id === message.mailboxId,
    )?.unreadCount;
    selectMessage({ ...message, isRead: next });
    setMailboxes(
      mailboxes.map((mailbox) =>
        mailbox.id === message.mailboxId
          ? {
              ...mailbox,
              unreadCount: Math.max(0, mailbox.unreadCount + (next ? -1 : 1)),
            }
          : mailbox,
      ),
    );
    setMessages(
      messages.map((summary) =>
        summary.id === message.id ? { ...summary, isRead: next } : summary,
      ),
      messageCursor,
      hasMoreMessages,
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
    if (!message) return;
    const destination = mailboxes.find((mailbox) => mailbox.role === role);
    const source = mailboxes.find(
      (mailbox) => mailbox.id === message.mailboxId,
    );
    if (
      destination?.id === message.mailboxId ||
      (destination && source?.name === destination.name)
    )
      return;
    const operation = ++moveOperation.current;
    const viewMailboxId = activeMailboxId;
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
        operation !== moveOperation.current ||
        current.activeAccountId !== message.accountId ||
        current.activeMailboxId !== viewMailboxId ||
        current.activeLocalView
      )
        return;
      const expectedMessages = messages.filter(
        (summary) => summary.id !== message.id,
      );
      const listStillOptimistic =
        previousIndex >= 0 &&
        !current.messages.some((summary) => summary.id === message.id) &&
        current.messages.length === expectedMessages.length &&
        current.messages.every(
          (summary, index) => summary.id === expectedMessages[index]?.id,
        );
      if (listStillOptimistic) {
        const restoredMessages = [...messages];
        restoredMessages.splice(
          Math.min(
            previousIndex < 0 ? restoredMessages.length : previousIndex,
            restoredMessages.length,
          ),
          0,
          message,
        );
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
      if (listStillOptimistic && !current.selectedMessage)
        selectMessage(message);
      setError(String(cause));
    }
  }

  async function moveToMailbox(mailboxId: number) {
    if (!message) return;
    if (mailboxId === message.mailboxId) return;
    const operation = ++moveOperation.current;
    const viewMailboxId = activeMailboxId;
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
        operation !== moveOperation.current ||
        current.activeAccountId !== message.accountId ||
        current.activeMailboxId !== viewMailboxId ||
        current.activeLocalView
      )
        return;
      const expectedMessages = messages.filter(
        (summary) => summary.id !== message.id,
      );
      const listStillOptimistic =
        previousIndex >= 0 &&
        !current.messages.some((summary) => summary.id === message.id) &&
        current.messages.length === expectedMessages.length &&
        current.messages.every(
          (summary, index) => summary.id === expectedMessages[index]?.id,
        );
      if (listStillOptimistic) {
        const restoredMessages = [...messages];
        restoredMessages.splice(
          Math.min(
            previousIndex < 0 ? restoredMessages.length : previousIndex,
            restoredMessages.length,
          ),
          0,
          message,
        );
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
      if (listStillOptimistic && !current.selectedMessage)
        selectMessage(message);
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
        <div className="brand-watermark" aria-hidden="true">
          ✉
        </div>
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
      <div
        className="reader-actions"
        role="toolbar"
        aria-label={strings.reader.actions}
        onKeyDown={moveToolbarFocus}
      >
        <button
          className="mobile-reader-back"
          type="button"
          onClick={() => selectMessage(undefined)}
          aria-label={strings.reader.backToList}
        >
          <ArrowLeft aria-hidden="true" />
          {strings.common.back}
        </button>
        {settings.readingPane === "hidden" ? (
          <button
            className="desktop-reader-close"
            type="button"
            onClick={() => selectMessage(undefined)}
            aria-label={strings.reader.closeMessage}
          >
            <X aria-hidden="true" />
          </button>
        ) : null}
        <div className="reader-primary-actions">
          <button
            type="button"
            onClick={() =>
              openComposer({ sourceMessage: message, composeMode: "reply" })
            }
          >
            <Reply aria-hidden="true" />
            {strings.reader.reply}
          </button>
          <button
            type="button"
            onClick={() =>
              openComposer({ sourceMessage: message, composeMode: "replyAll" })
            }
          >
            <ReplyAll aria-hidden="true" />
            {strings.reader.replyAll}
          </button>
          <button
            type="button"
            onClick={() => void forwardMessage()}
            disabled={preparingForward}
          >
            <Forward aria-hidden="true" />
            {preparingForward
              ? strings.reader.preparing
              : strings.reader.forward}
          </button>
        </div>
        <span className="action-spacer" />
        <div className="reader-secondary-actions">
          <button
            type="button"
            onClick={() => void move("archive")}
            disabled={isArchiveMailbox}
            aria-label={strings.reader.archive}
            title={strings.reader.archive}
          >
            <Archive aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => void move("trash")}
            disabled={isTrashMailbox}
            aria-label={strings.reader.trash}
            title={strings.reader.trash}
          >
            <Trash2 aria-hidden="true" />
          </button>
          <div className="reader-more" ref={moreMenuRef}>
            <button
              type="button"
              onClick={() => setMoreOpen((value) => !value)}
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              aria-label={strings.reader.moreActions}
              title={strings.reader.moreActions}
            >
              <MoreHorizontal aria-hidden="true" />
            </button>
            {moreOpen ? (
              <div className="reader-more-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    printMessage();
                    setMoreOpen(false);
                  }}
                >
                  <Printer aria-hidden="true" />
                  {strings.reader.print}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    void setRead();
                    setMoreOpen(false);
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
                    void setStarred();
                    setMoreOpen(false);
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
                      const inbox = mailboxes.find(
                        (box) => box.role === "inbox",
                      );
                      if (inbox) void moveToMailbox(inbox.id);
                      setMoreOpen(false);
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
                      void move("junk");
                      setMoreOpen(false);
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
                    setSnoozeOpen(true);
                    setMoreOpen(false);
                  }}
                >
                  <Clock aria-hidden="true" />
                  {strings.reader.snooze}
                </button>
                <label
                  className="move-control"
                  title={strings.reader.moveFolder}
                >
                  <FolderInput aria-hidden="true" />
                  <select
                    aria-label={strings.reader.moveFolder}
                    value=""
                    onChange={(event) => {
                      const mailboxId = Number(event.target.value);
                      if (mailboxId) {
                        void moveToMailbox(mailboxId);
                        setMoreOpen(false);
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
      {snoozeOpen ? (
        <SnoozePanel
          onSnooze={(untilIso) => void snoozeCurrentMessage(untilIso)}
          onClose={() => setSnoozeOpen(false)}
        />
      ) : null}
      <header className="message-header">
        <h1
          id="message-title"
          ref={titleRef}
          tabIndex={treatAsOverlay ? -1 : undefined}
        >
          {message.subject || strings.common.noSubject}
        </h1>
        <div className="sender-avatar" aria-hidden="true">
          {(message.senderName || message.senderAddress)
            .slice(0, 1)
            .toUpperCase()}
        </div>
        <div className="sender-details">
          <div className="sender-primary-line">
            <strong className="sender-name">
              {message.senderName || message.senderAddress}
            </strong>
            {message.senderName &&
            message.senderName !== message.senderAddress ? (
              <span className="sender-address-muted">
                &lt;{message.senderAddress}&gt;
              </span>
            ) : null}
          </div>
          <div className="recipient-summary">
            <span className="recipient-label">{strings.reader.to}</span>
            <span className="recipient-preview">
              {message.to.length > 0
                ? message.to.join(", ")
                : strings.reader.noRecipients}
            </span>
          </div>
          <button
            type="button"
            className="details-toggle"
            onClick={() =>
              setShowDetailsFor((id) =>
                id === message.id ? undefined : message.id,
              )
            }
            aria-expanded={showDetails}
            aria-controls="message-details-panel"
            aria-label={
              showDetails
                ? strings.reader.hideDetails
                : strings.reader.showDetails
            }
          >
            {showDetails ? (
              <>
                <ChevronUp size={15} aria-hidden="true" />
                {strings.reader.hideDetails}
              </>
            ) : (
              <>
                <ChevronDown size={15} aria-hidden="true" />
                {strings.reader.showDetails}
              </>
            )}
          </button>
        </div>
        <time dateTime={message.receivedAt}>
          {new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(message.receivedAt))}
        </time>
        {showDetails ? (
          <div
            id="message-details-panel"
            className="message-details-panel"
            role="region"
            aria-label={strings.reader.showDetails}
          >
            <dl className="details-grid">
              <dt>{strings.reader.from}</dt>
              <dd className="address-row">
                <span className="address-chip">
                  <strong>{message.senderName || message.senderAddress}</strong>
                  {message.senderName &&
                  message.senderName !== message.senderAddress ? (
                    <span className="address-spec">
                      &lt;{message.senderAddress}&gt;
                    </span>
                  ) : null}
                </span>
                <CopyButton
                  text={message.senderAddress}
                  title={strings.reader.copyAddress}
                />
              </dd>
              {message.replyTo && message.replyTo !== message.senderAddress ? (
                <>
                  <dt>{strings.reader.replyTo}</dt>
                  <dd className="address-row reply-to-highlight">
                    <span className="address-chip">{message.replyTo}</span>
                    <CopyButton
                      text={message.replyTo}
                      title={strings.reader.copyAddress}
                    />
                  </dd>
                </>
              ) : null}
              <dt>{strings.reader.to}</dt>
              <dd className="recipients-list">
                {message.to.length > 0 ? (
                  message.to.map((addr) => (
                    <span key={addr} className="address-chip">
                      {addr}
                    </span>
                  ))
                ) : (
                  <span>{strings.reader.noRecipients}</span>
                )}
              </dd>
              {message.cc && message.cc.length > 0 ? (
                <>
                  <dt>{strings.reader.cc}</dt>
                  <dd className="recipients-list">
                    {message.cc.map((addr) => (
                      <span key={addr} className="address-chip">
                        {addr}
                      </span>
                    ))}
                  </dd>
                </>
              ) : null}
              <dt>{strings.reader.date}</dt>
              <dd>{formatFullMessageDate(message.receivedAt)}</dd>
              <dt>{strings.reader.subject}</dt>
              <dd>{message.subject || strings.common.noSubject}</dd>
              <dt>{strings.reader.folder}</dt>
              <dd>
                {account ? `${account.displayName || account.email} › ` : ""}
                {currentMailbox?.displayName || "Mailbox"}
              </dd>
              <dt>{strings.reader.security}</dt>
              <dd className="security-badge">
                <ShieldCheck size={16} aria-hidden="true" />
                <span>
                  <strong>{strings.reader.securityTls}</strong> —{" "}
                  {strings.reader.securityTlsDetail}
                </span>
              </dd>
              {message.messageId ? (
                <>
                  <dt>{strings.reader.messageId}</dt>
                  <dd className="message-id-row">
                    <code>{message.messageId}</code>
                    <CopyButton
                      text={message.messageId}
                      title={strings.reader.copyMessageId}
                    />
                  </dd>
                </>
              ) : null}
              <dt>{strings.reader.size}</dt>
              <dd>{formatBytes(message.size)}</dd>
            </dl>
          </div>
        ) : null}
      </header>
      {filteredImages > 0 ? (
        <div className="remote-content-banner" role="status" aria-live="polite">
          <ShieldCheck aria-hidden="true" />
          <span>{strings.reader.filteredImages(filteredImages)}</span>
        </div>
      ) : null}
      {threatImages > 0 ? (
        <div className="remote-content-banner" role="status" aria-live="polite">
          <ShieldAlert aria-hidden="true" />
          <span>{strings.reader.threatImages(threatImages)}</span>
        </div>
      ) : null}
      {sanitized && remainingBlockedImages > 0 ? (
        <div className="remote-content-banner" role="status" aria-live="polite">
          <Image aria-hidden="true" />
          <span>
            {strings.reader.blockedImages(remainingBlockedImages)}{" "}
            {strings.reader.blockedImagesDetail}
          </span>
          <button
            type="button"
            onClick={() => void loadImages()}
            disabled={loadingImages}
          >
            {loadingImages
              ? strings.common.loading
              : currentLoadedHtml
                ? strings.reader.retryImages
                : strings.reader.loadImages}
          </button>
        </div>
      ) : null}
      {findOpen ? (
        <form
          className="message-find"
          onSubmit={(event) => {
            event.preventDefault();
            findInMessage();
          }}
        >
          <input
            ref={findInputRef}
            value={findQuery}
            onChange={(event) => setFindQuery(event.target.value)}
            placeholder={strings.reader.findInMessage}
            aria-label={strings.reader.findInMessage}
          />
          <button type="submit">{strings.reader.findNext}</button>
          <button
            type="button"
            onClick={() => {
              setFindOpen(false);
              setFindQuery("");
            }}
          >
            {strings.common.close}
          </button>
        </form>
      ) : null}
      <div className="message-body" ref={bodyRef}>
        {!message.htmlBody && !message.textBody ? (
          <p className="plain-text-body" role="note">
            {message.size > 50 * 1024 * 1024
              ? strings.mail.messageTooLarge
              : strings.mail.emptyBody}
          </p>
        ) : message.htmlBody ? (
          <iframe
            ref={frame}
            title={strings.reader.messageContent}
            tabIndex={0}
            sandbox="allow-same-origin allow-modals"
            srcDoc={frameHtml}
            onLoad={wireFrameLinks}
          />
        ) : (
          <PlainTextContent
            text={message.textBody}
            onOpenLink={(url) => void handleExternalLink(url)}
            onOpenMailto={(url) => openComposer({ prefill: parseMailto(url) })}
          />
        )}
      </div>
      {(() => {
        const regularAttachments = message.attachments.filter(
          (item) => !item.inline,
        );
        if (regularAttachments.length === 0) return null;
        return (
          <section
            className="attachment-list"
            aria-label={strings.reader.attachments}
          >
            <h2>
              {strings.reader.attachments} ({regularAttachments.length})
            </h2>
            {regularAttachments.map((attachment) => (
              <div key={attachment.id} className="attachment-row">
                {isPreviewable(attachment) ? (
                  <button
                    type="button"
                    className="attachment-preview-button"
                    disabled={
                      downloadingAttachmentId !== undefined ||
                      previewAttachmentId !== undefined
                    }
                    onClick={() => void previewFile(attachment.id)}
                    aria-label={`${strings.reader.preview}: ${attachment.filename}`}
                  >
                    <Eye aria-hidden="true" />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="attachment-download-button"
                  disabled={downloadingAttachmentId !== undefined}
                  onClick={() =>
                    void download(attachment.id, attachment.filename)
                  }
                  aria-label={`${strings.reader.downloadFile}: ${attachment.filename}`}
                >
                  <Download aria-hidden="true" />
                  <span>
                    <strong>{attachment.filename}</strong>
                    <small>{formatBytes(attachment.size)}</small>
                  </span>
                </button>
              </div>
            ))}
          </section>
        );
      })()}
      {preview && message && preview.messageId === message.id ? (
        <AttachmentPreviewDialog
          preview={preview.preview}
          onDownload={() => {
            const current = message.attachments.find(
              (item) =>
                item.filename === preview.preview.filename && !item.inline,
            );
            if (current) void download(current.id, current.filename);
          }}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </article>
  );
}

function AttachmentPreviewDialog({
  preview,
  onDownload,
  onClose,
}: {
  preview: AttachmentPreview;
  onDownload: () => void;
  onClose: () => void;
}) {
  const dialogRef = useDialogFocus(onClose);
  return (
    <div className="modal-layer attachment-preview-layer">
      <button
        type="button"
        className="modal-backdrop"
        aria-label={strings.common.close}
        onClick={onClose}
      />
      <section
        className="attachment-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={strings.reader.previewTitle(preview.filename)}
        ref={dialogRef}
      >
        <header>
          <div>
            <h2>{preview.filename}</h2>
            <small>
              {preview.contentType} · {formatBytes(preview.size)}
            </small>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label={strings.common.close}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="attachment-preview-body">
          {preview.imageDataUrl ? (
            <img src={preview.imageDataUrl} alt={preview.filename} />
          ) : (
            <pre>{preview.text ?? ""}</pre>
          )}
        </div>
        <footer>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              onDownload();
              onClose();
            }}
          >
            <Download aria-hidden="true" /> {strings.reader.downloadFile}
          </button>
        </footer>
      </section>
    </div>
  );
}

function moveCounts(
  mailboxes: ReturnType<typeof useAppStore.getState>["mailboxes"],
  message: NonNullable<
    ReturnType<typeof useAppStore.getState>["selectedMessage"]
  >,
  destinationId?: number,
) {
  return mailboxes.map((mailbox) => {
    if (mailbox.id === message.mailboxId)
      return {
        ...mailbox,
        totalCount: Math.max(0, mailbox.totalCount - 1),
        unreadCount: Math.max(
          0,
          mailbox.unreadCount - (message.isRead ? 0 : 1),
        ),
      };
    if (mailbox.id === destinationId)
      return {
        ...mailbox,
        totalCount: mailbox.totalCount + 1,
        unreadCount: mailbox.unreadCount + (message.isRead ? 0 : 1),
      };
    return mailbox;
  });
}

async function hydrateInlineImages(
  doc: Document,
  accountId: string,
  messageId: number,
  attachments: Attachment[],
): Promise<void> {
  await Promise.all(
    [...doc.querySelectorAll<HTMLImageElement>("img[data-inline-cid]")].map(
      async (image) => {
        const contentId = normalizeContentId(image.dataset.inlineCid ?? "");
        const attachment = attachments.find(
          (item) => normalizeContentId(item.contentId ?? "") === contentId,
        );
        if (!attachment) return;
        try {
          image.src = await api.readMessageInlineImage(
            accountId,
            messageId,
            attachment.id,
          );
          image.removeAttribute("data-inline-cid");
        } catch {
          // A broken inline part should not prevent the message from opening.
        }
      },
    ),
  );
}

function escapePrint(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeContentId(value: string): string {
  return value.trim().replace(/^cid:/i, "").replace(/^<|>$/g, "");
}

function CopyButton({ text, title }: { text: string; title: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <button
      type="button"
      className="copy-mini-btn"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => setCopied(false), 2000);
        } catch {
          // Safe fallback if clipboard write fails
        }
      }}
      title={copied ? strings.reader.copied : title}
      aria-label={copied ? strings.reader.copied : title}
    >
      {copied ? (
        <>
          <Check size={12} aria-hidden="true" />
          <span>{strings.reader.copied}</span>
        </>
      ) : (
        <>
          <Copy size={12} aria-hidden="true" />
          <span>{title}</span>
        </>
      )}
    </button>
  );
}

function SnoozePanel({
  onSnooze,
  onClose,
}: {
  onSnooze: (untilIso: string) => void;
  onClose: () => void;
}) {
  const [custom, setCustom] = useState("");
  function atMorning(date: Date): string {
    date.setHours(8, 0, 0, 0);
    return date.toISOString();
  }
  function tomorrowMorning(): string {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    return atMorning(date);
  }
  function nextMonday(): string {
    const date = new Date();
    date.setDate(date.getDate() + ((8 - date.getDay()) % 7 || 7));
    return atMorning(date);
  }
  return (
    <div
      className="snooze-panel"
      role="group"
      aria-label={strings.reader.snooze}
    >
      <button type="button" onClick={() => onSnooze(tomorrowMorning())}>
        {strings.reader.snoozeTomorrow}
      </button>
      <button type="button" onClick={() => onSnooze(nextMonday())}>
        {strings.reader.snoozeNextWeek}
      </button>
      <label>
        <span className="visually-hidden">{strings.reader.snoozeCustom}</span>
        <input
          type="datetime-local"
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={!custom}
        onClick={() => {
          const parsed = new Date(custom);
          if (Number.isFinite(parsed.getTime())) onSnooze(parsed.toISOString());
        }}
      >
        {strings.reader.snoozeUntil}
      </button>
      <button type="button" className="toolbar-button" onClick={onClose}>
        {strings.common.cancel}
      </button>
    </div>
  );
}

function PlainTextContent({
  text,
  onOpenLink,
  onOpenMailto,
}: {
  text: string;
  onOpenLink: (url: string) => void;
  onOpenMailto: (mailto: string) => void;
}) {
  const parts = useMemo(() => {
    const urlOrEmailRegex =
      /(https?:\/\/[^\s<>"'()]+|mailto:[^\s<>"'()]+|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    const elements: Array<{
      type: "text" | "link" | "mailto";
      content: string;
    }> = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = urlOrEmailRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        elements.push({
          type: "text",
          content: text.slice(lastIndex, match.index),
        });
      }
      const matched = match[0];
      // Trailing sentence punctuation is prose, not address.
      const trimmed = matched.replace(/[.,!?;:]+$/, "");
      const trailing = matched.slice(trimmed.length);
      if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
        elements.push({ type: "link", content: trimmed });
      } else if (trimmed.startsWith("mailto:")) {
        elements.push({ type: "mailto", content: trimmed });
      } else {
        elements.push({ type: "mailto", content: `mailto:${trimmed}` });
      }
      if (trailing) {
        elements.push({ type: "text", content: trailing });
      }
      lastIndex = match.index + matched.length;
    }
    if (lastIndex < text.length) {
      elements.push({ type: "text", content: text.slice(lastIndex) });
    }
    return elements;
  }, [text]);

  return (
    <div className="plain-text-body">
      {parts.map((part, idx) => {
        if (part.type === "text") {
          return <span key={idx}>{part.content}</span>;
        }
        if (part.type === "link") {
          return (
            <a
              key={idx}
              href="#"
              data-external-href={part.content}
              onClick={(e) => {
                e.preventDefault();
                onOpenLink(part.content);
              }}
              onAuxClick={(e) => {
                e.preventDefault();
                onOpenLink(part.content);
              }}
              onContextMenu={(e) => e.preventDefault()}
            >
              {part.content}
            </a>
          );
        }
        return (
          <a
            key={idx}
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onOpenMailto(part.content);
            }}
            onAuxClick={(e) => {
              e.preventDefault();
              onOpenMailto(part.content);
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {part.content.replace(/^mailto:/i, "")}
          </a>
        );
      })}
    </div>
  );
}
