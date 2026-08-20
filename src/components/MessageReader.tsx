import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  Download,
  FolderInput,
  Forward,
  Image,
  Mail,
  MailOpen,
  Reply,
  ReplyAll,
  ShieldAlert,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { strings } from "../i18n";
import { parseMailto } from "../mailto";
import { messageFrameDocument, sanitizeReceivedHtml } from "../security";
import { useAppStore } from "../store";
import type { Attachment } from "../types";

export function MessageReader() {
  const message = useAppStore((state) => state.selectedMessage);
  const selectMessage = useAppStore((state) => state.selectMessage);
  const mailboxes = useAppStore((state) => state.mailboxes);
  const setMailboxes = useAppStore((state) => state.setMailboxes);
  const messages = useAppStore((state) => state.messages);
  const messageCursor = useAppStore((state) => state.messageCursor);
  const hasMoreMessages = useAppStore((state) => state.hasMoreMessages);
  const setMessages = useAppStore((state) => state.setMessages);
  const openComposer = useAppStore((state) => state.openComposer);
  const settings = useAppStore((state) => state.settings);
  const setError = useAppStore((state) => state.setError);
  const frame = useRef<HTMLIFrameElement>(null);
  const contentOperation = useRef(0);
  const [loadedHtml, setLoadedHtml] = useState<{
    messageId: number;
    html: string;
  }>();
  const [loadingImages, setLoadingImages] = useState(false);
  const [preparingForward, setPreparingForward] = useState(false);

  useEffect(() => {
    if (settings.readingPane !== "hidden" || !message) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") selectMessage(undefined);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [message, selectMessage, settings.readingPane]);

  useEffect(() => {
    if (!message) return;
    const menuAction = (event: Event) => {
      const action = (event as CustomEvent<string>).detail;
      if (action === "reply")
        openComposer({ sourceMessage: message, composeMode: "reply" });
      if (action === "reply-all")
        openComposer({ sourceMessage: message, composeMode: "replyAll" });
      if (action === "forward") void forwardMessage();
      if (action === "archive") void move("archive");
      if (action === "trash") void move("trash");
    };
    window.addEventListener("postal:menu-action", menuAction);
    return () => window.removeEventListener("postal:menu-action", menuAction);
  });

  const htmlBody = message?.htmlBody;
  const attachments = message?.attachments;
  const sanitized = useMemo(
    () => (htmlBody ? sanitizeReceivedHtml(htmlBody) : undefined),
    [htmlBody],
  );
  const inlineAttachments = useMemo(
    () => attachments?.filter((attachment) => attachment.inline) ?? [],
    [attachments],
  );
  const messageId = message?.id;
  const messageAccountId = message?.accountId;
  const currentLoadedHtml =
    loadedHtml && loadedHtml.messageId === message?.id
      ? loadedHtml.html
      : undefined;
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
    body.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLAnchorElement>(
        "a[href]",
      );
      if (!target) return;
      event.preventDefault();
      const url = target.href;
      if (/^https?:/i.test(url) && window.confirm(strings.reader.openLink(url)))
        void openUrl(url);
      if (/^mailto:/i.test(url)) openComposer({ prefill: parseMailto(url) });
    });
  }

  async function loadImages() {
    if (!sanitized || loadingImages) return;
    setLoadingImages(true);
    const operation = ++contentOperation.current;
    try {
      const doc = new DOMParser().parseFromString(
        currentLoadedHtml ?? sanitized.html,
        "text/html",
      );
      const images = [
        ...doc.querySelectorAll<HTMLImageElement>("img[data-remote-src]"),
      ];
      await Promise.all(
        images.map(async (image) => {
          const url = image.dataset.remoteSrc;
          if (!url) return;
          image.src = await api.fetchRemoteImage(url);
          image.removeAttribute("data-remote-src");
          image.classList.remove("remote-image-blocked");
        }),
      );
      if (message)
        await hydrateInlineImages(
          doc,
          message.accountId,
          message.id,
          inlineAttachments,
        );
      if (message && contentOperation.current === operation)
        setLoadedHtml({ messageId: message.id, html: doc.body.innerHTML });
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoadingImages(false);
    }
  }

  async function setStarred() {
    if (!message) return;
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
      selectMessage(message);
      setMessages(messages, messageCursor, hasMoreMessages);
      setError(String(cause));
    }
  }

  async function setRead() {
    if (!message) return;
    const next = !message.isRead;
    const previousMailboxes = mailboxes;
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
      selectMessage(message);
      setMessages(messages, messageCursor, hasMoreMessages);
      setMailboxes(previousMailboxes);
      setError(String(cause));
    }
  }

  async function move(role: "archive" | "trash" | "junk") {
    if (!message) return;
    const previousMailboxes = mailboxes;
    const destination = mailboxes.find((mailbox) => mailbox.role === role);
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
      setMailboxes(previousMailboxes);
      setMessages(messages, messageCursor, hasMoreMessages);
      selectMessage(message);
      setError(String(cause));
    }
  }

  async function moveToMailbox(mailboxId: number) {
    if (!message) return;
    const previousMailboxes = mailboxes;
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
      setMailboxes(previousMailboxes);
      setMessages(messages, messageCursor, hasMoreMessages);
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
    setPreparingForward(true);
    try {
      const attachments = await api.prepareForwardAttachments(
        message.accountId,
        message.id,
      );
      openComposer({
        sourceMessage: message,
        composeMode: "forward",
        prefill: { attachments },
      });
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPreparingForward(false);
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

  return (
    <article className="reader-pane" aria-labelledby="message-title">
      <div className="reader-actions">
        <button
          className="mobile-reader-back"
          type="button"
          onClick={() => selectMessage(undefined)}
          aria-label={strings.reader.backToList}
        >
          <ArrowLeft />
          {strings.common.back}
        </button>
        {settings.readingPane === "hidden" ? (
          <button
            className="desktop-reader-close"
            type="button"
            onClick={() => selectMessage(undefined)}
            aria-label={strings.reader.closeMessage}
          >
            <X />
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
        >
          <Star fill={message.isStarred ? "currentColor" : "none"} />
        </button>
        <button
          type="button"
          onClick={() => void move("archive")}
          aria-label={strings.reader.archive}
        >
          <Archive />
        </button>
        <button
          type="button"
          onClick={() => void move("junk")}
          aria-label={strings.reader.junk}
        >
          <ShieldAlert />
        </button>
        <button
          type="button"
          onClick={() => void move("trash")}
          aria-label={strings.reader.trash}
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
              .filter((mailbox) => mailbox.id !== message.mailboxId)
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
          <strong>{message.senderName || message.senderAddress}</strong>
          <span>{message.senderAddress}</span>
          <span>
            {strings.reader.to} {message.to.join(", ")}
          </span>
        </div>
        <time dateTime={message.receivedAt}>
          {new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(message.receivedAt))}
        </time>
      </header>
      {sanitized && sanitized.blockedImages > 0 && !currentLoadedHtml ? (
        <div className="remote-content-banner">
          <Image />
          <span>{strings.reader.blockedImages(sanitized.blockedImages)}</span>
          <button
            type="button"
            onClick={() => void loadImages()}
            disabled={loadingImages}
          >
            {loadingImages ? strings.common.loading : strings.reader.loadImages}
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
          <pre>{message.textBody}</pre>
        )}
      </div>
      {message.attachments.length > 0 ? (
        <section
          className="attachment-list"
          aria-label={strings.reader.attachments}
        >
          <h2>{strings.reader.attachments}</h2>
          {message.attachments
            .filter((item) => !item.inline)
            .map((attachment) => (
              <button
                type="button"
                key={attachment.id}
                onClick={() =>
                  void download(attachment.id, attachment.filename)
                }
              >
                <Download />
                <span>
                  <strong>{attachment.filename}</strong>
                  <small>{formatBytes(attachment.size)}</small>
                </span>
              </button>
            ))}
        </section>
      ) : null}
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
