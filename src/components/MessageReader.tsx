import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FolderInput,
  Forward,
  Image,
  Mail,
  MailOpen,
  Printer,
  Reply,
  ReplyAll,
  ShieldAlert,
  ShieldCheck,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { formatBytes, formatFullMessageDate } from "../format";
import { strings } from "../i18n";
import { parseMailto } from "../mailto";
import { messageFrameDocument, sanitizeReceivedHtml } from "../security";
import { useAppStore } from "../store";
import type { Attachment } from "../types";

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
  const [showDetailsFor, setShowDetailsFor] = useState<number>();

  const account = accounts.find((a) => a.id === message?.accountId);
  const currentMailbox = mailboxes.find((m) => m.id === message?.mailboxId);
  const isArchiveMailbox = currentMailbox?.role === "archive";
  const isTrashMailbox = currentMailbox?.role === "trash";
  const isJunkMailbox = currentMailbox?.role === "junk";

  async function handleExternalLink(url: string) {
    if (!/^https?:/i.test(url)) return;
    const confirmed = await api.showNativeConfirm(
      strings.appName,
      strings.reader.openLink(url),
    );
    if (confirmed) {
      await openUrl(url);
    }
  }

  useEffect(() => {
    if (settings.readingPane !== "hidden" || !message) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") selectMessage(undefined);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [message, selectMessage, settings.readingPane]);

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
    };
    window.addEventListener("postal:menu-action", menuAction);
    return () => window.removeEventListener("postal:menu-action", menuAction);
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
  const remainingBlockedImages = useMemo(() => {
    if (!sanitized) return 0;
    if (!currentLoadedHtml) return sanitized.blockedImages;
    return (currentLoadedHtml.match(/data-remote-src=/g) || []).length;
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

  function wireFrameLinks() {
    const body = frame.current?.contentDocument?.body;
    if (!body) return;
    const handleLink = async (event: MouseEvent) => {
      if (event.button > 1) return;
      const target = (event.target as HTMLElement).closest<HTMLAnchorElement>(
        "a[href]",
      );
      if (!target) return;
      event.preventDefault();
      const url = target.href;
      if (/^https?:/i.test(url)) {
        const confirmed = await api.showNativeConfirm(
          strings.appName,
          strings.reader.openLink(url),
        );
        if (confirmed) {
          void openUrl(url);
        }
      }
      if (/^mailto:/i.test(url)) openComposer({ prefill: parseMailto(url) });
    };
    body.addEventListener("click", handleLink);
    body.addEventListener("auxclick", handleLink);
  }

  async function loadImages() {
    if (!sanitized || loadingImages || !messageId) return;
    setLoadingImagesFor(messageId);
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
              image.src = await api.fetchRemoteImage(url);
              image.removeAttribute("data-remote-src");
              image.classList.remove("remote-image-blocked");
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
      if (contentOperation.current === operation)
        setLoadingImagesFor(undefined);
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
    if (!message) return;
    try {
      await api.saveAttachment(
        message.accountId,
        message.id,
        attachmentId,
        filename,
      );
    } catch (cause) {
      setError(String(cause));
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
    return <section className="reader-pane reader-hidden" aria-hidden="true" />;
  if (!message)
    return (
      <section className="reader-pane empty-reader">
        <div className="brand-watermark" aria-hidden="true">
          ✉
        </div>
        <p>{strings.mail.noMessage}</p>
      </section>
    );

  const showDetails = showDetailsFor === message.id;

  return (
    <article className="reader-pane" aria-labelledby="message-title">
      <div className="reader-actions">
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
        <button
          type="button"
          onClick={() =>
            openComposer({ sourceMessage: message, composeMode: "reply" })
          }
        >
          <Reply />
          {strings.reader.reply}
        </button>
        <button
          type="button"
          onClick={() =>
            openComposer({ sourceMessage: message, composeMode: "replyAll" })
          }
        >
          <ReplyAll />
          {strings.reader.replyAll}
        </button>
        <button
          type="button"
          onClick={() => void forwardMessage()}
          disabled={preparingForward}
        >
          <Forward />
          {preparingForward ? strings.reader.preparing : strings.reader.forward}
        </button>
        <button
          type="button"
          onClick={() => {
            if (frame.current?.contentWindow) {
              frame.current.contentWindow.focus();
              frame.current.contentWindow.print();
            } else {
              window.print();
            }
          }}
          aria-label={strings.reader.print}
          title={strings.reader.print}
        >
          <Printer />
        </button>
        <span className="action-spacer" />
        <button
          type="button"
          onClick={() => void setRead()}
          aria-label={
            message.isRead ? strings.reader.markUnread : strings.reader.markRead
          }
          title={
            message.isRead ? strings.reader.markUnread : strings.reader.markRead
          }
        >
          {message.isRead ? <Mail /> : <MailOpen />}
        </button>
        <button
          type="button"
          onClick={() => void setStarred()}
          aria-label={
            message.isStarred
              ? strings.reader.removeStar
              : strings.reader.addStar
          }
          title={
            message.isStarred
              ? strings.reader.removeStar
              : strings.reader.addStar
          }
        >
          <Star fill={message.isStarred ? "currentColor" : "none"} />
        </button>
        <button
          type="button"
          onClick={() => void move("archive")}
          disabled={isArchiveMailbox}
          aria-label={strings.reader.archive}
          title={strings.reader.archive}
        >
          <Archive />
        </button>
        <button
          type="button"
          onClick={() => void move("junk")}
          disabled={isJunkMailbox}
          aria-label={strings.reader.junk}
          title={strings.reader.junk}
        >
          <ShieldAlert />
        </button>
        <button
          type="button"
          onClick={() => void move("trash")}
          disabled={isTrashMailbox}
          aria-label={strings.reader.trash}
          title={strings.reader.trash}
        >
          <Trash2 />
        </button>
        <label className="move-control" title={strings.reader.moveFolder}>
          <FolderInput aria-hidden="true" />
          <select
            aria-label={strings.reader.moveFolder}
            value=""
            onChange={(event) => {
              const mailboxId = Number(event.target.value);
              if (mailboxId) void moveToMailbox(mailboxId);
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
      <header className="message-header">
        <h1 id="message-title">
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
                ? "Retry loading images"
                : strings.reader.loadImages}
          </button>
        </div>
      ) : null}
      <div className="message-body">
        {message.htmlBody ? (
          <iframe
            ref={frame}
            title={strings.reader.messageContent}
            sandbox="allow-same-origin"
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
              <button
                type="button"
                key={attachment.id}
                onClick={() =>
                  void download(attachment.id, attachment.filename)
                }
              >
                <Download aria-hidden="true" />
                <span>
                  <strong>{attachment.filename}</strong>
                  <small>{formatBytes(attachment.size)}</small>
                </span>
              </button>
            ))}
          </section>
        );
      })()}
    </article>
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
      if (matched.startsWith("http://") || matched.startsWith("https://")) {
        elements.push({ type: "link", content: matched });
      } else if (matched.startsWith("mailto:")) {
        elements.push({ type: "mailto", content: matched });
      } else {
        elements.push({ type: "mailto", content: `mailto:${matched}` });
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
              href={part.content}
              onClick={(e) => {
                e.preventDefault();
                onOpenLink(part.content);
              }}
            >
              {part.content}
            </a>
          );
        }
        return (
          <a
            key={idx}
            href={part.content}
            onClick={(e) => {
              e.preventDefault();
              onOpenMailto(part.content);
            }}
          >
            {part.content.replace(/^mailto:/i, "")}
          </a>
        );
      })}
    </div>
  );
}
