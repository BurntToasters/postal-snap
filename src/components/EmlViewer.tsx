import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Eye, Image, X } from "lucide-react";
import { api } from "../api";
import { errorText } from "../errors";
import { formatBytes, formatFullMessageDate } from "../format";
import { strings } from "../i18n";
import { useIsDark } from "../hooks/useColorScheme";
import {
  hasAuthorColors,
  messageFrameDocument,
  pickLinkUrl,
  sanitizeReceivedHtml,
  withFrameLinks,
} from "../security";
import { useAppStore } from "../store";
import type { Attachment, AttachmentPreview, OpenedMessage } from "../types";
import { inspectAndOpenExternalLink } from "./externalLink";
import { AttachmentPreviewDialog } from "./reader/attachmentList";
import { PlainTextContent } from "./reader/messageBody";
import { useDialogFocus } from "./useDialogFocus";
import { useInertBackground } from "./useInertBackground";

// Matches the reader's frame margin for the normal density.
const FRAME_MARGIN_BLOCK = 12;
const PREVIEWABLE = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
]);

function canPreview(attachment: Attachment): boolean {
  return (
    !attachment.inline && PREVIEWABLE.has(attachment.contentType.toLowerCase())
  );
}

/** A message opened from a file. Same sanitize, sandbox and frame as the reader; remote images stay blocked. */
export function EmlViewer({
  opened,
  onClose,
}: {
  opened: OpenedMessage;
  onClose: () => void;
}) {
  const { token, message } = opened;
  const dialogRef = useDialogFocus(onClose);
  useInertBackground();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const textScale = useAppStore((state) => state.settings.textScale);
  const isDark = useIsDark();
  const [notice, setNotice] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [preview, setPreview] = useState<{
    attachmentId: string;
    value: AttachmentPreview;
  }>();

  const subject = message.subject || strings.common.noSubject;
  const sanitized = useMemo(
    () =>
      message.htmlBody ? sanitizeReceivedHtml(message.htmlBody) : undefined,
    [message.htmlBody],
  );
  const frameHtml = useMemo(
    () =>
      sanitized
        ? messageFrameDocument(
            withFrameLinks(sanitized.html),
            textScale,
            isDark && !hasAuthorColors(sanitized.html),
            FRAME_MARGIN_BLOCK,
          )
        : "",
    [sanitized, textScale, isDark],
  );
  const files = message.attachments.filter((item) => !item.inline);

  // The frame cannot run scripts, so its links and keys are wired from here.
  function wireFrame() {
    const doc = frameRef.current?.contentDocument;
    if (!doc?.body) return;
    const onLink = (event: Event) => {
      const target = event.target;
      const link =
        target instanceof Element
          ? target.closest<HTMLAnchorElement>("a[href], a[data-external-href]")
          : null;
      if (!link) return;
      event.preventDefault();
      const url = pickLinkUrl(
        link.getAttribute("data-external-href")?.trim() ?? "",
        link.getAttribute("href")?.trim() ?? "",
      );
      if (/^https?:/i.test(url))
        void inspectAndOpenExternalLink(url, link.textContent ?? "");
    };
    // Escape and Tab belong to the viewer's dialog, not the frame.
    const forwardKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Tab") return;
      const copy = new KeyboardEvent("keydown", {
        key: event.key,
        shiftKey: event.shiftKey,
        bubbles: true,
        cancelable: true,
      });
      if (!document.dispatchEvent(copy)) event.preventDefault();
    };
    doc.body.addEventListener("click", onLink);
    doc.body.addEventListener("auxclick", onLink);
    doc.addEventListener("keydown", forwardKey);
  }

  async function save(attachment: Attachment) {
    setBusyId(attachment.id);
    setNotice(undefined);
    try {
      await api.saveOpenedAttachment(token, attachment.id);
    } catch (cause) {
      setNotice(errorText(cause));
    } finally {
      setBusyId(undefined);
    }
  }

  async function openPreview(attachment: Attachment) {
    setNotice(undefined);
    try {
      const value = await api.previewOpenedAttachment(token, attachment.id);
      setPreview({ attachmentId: attachment.id, value });
    } catch (cause) {
      setNotice(errorText(cause));
    }
  }

  return createPortal(
    <div className="modal-layer eml-viewer-layer">
      <button
        type="button"
        className="modal-backdrop"
        aria-label={strings.common.close}
        onClick={onClose}
      />
      <section
        className="attachment-preview-dialog eml-viewer"
        role="dialog"
        aria-modal="true"
        aria-label={subject}
        ref={dialogRef}
      >
        <header>
          <div>
            <h2 title={subject}>{subject}</h2>
            <small>{strings.reader.openedFromFile}</small>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label={strings.reader.closeOpenedFile}
            title={strings.reader.closeOpenedFile}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="eml-viewer-body">
          <dl className="eml-headers">
            <dt>{strings.reader.from}</dt>
            <dd>
              {message.senderName
                ? `${message.senderName} <${message.senderAddress}>`
                : message.senderAddress}
            </dd>
            <dt>{strings.reader.to}</dt>
            <dd>{message.to.join(", ") || strings.reader.noRecipients}</dd>
            <dt>{strings.reader.date}</dt>
            <dd>{formatFullMessageDate(message.receivedAt)}</dd>
            <dt>{strings.reader.subject}</dt>
            <dd>{subject}</dd>
          </dl>
          {notice ? (
            <p className="eml-viewer-notice" role="alert">
              {notice}
            </p>
          ) : null}
          {sanitized && sanitized.blockedImages > 0 ? (
            <div className="remote-content-banner" role="status">
              <Image aria-hidden="true" />
              <span>
                {strings.reader.blockedImages(sanitized.blockedImages)}
              </span>
            </div>
          ) : null}
          <div className="message-body eml-message-body">
            {sanitized ? (
              <iframe
                ref={frameRef}
                title={strings.reader.messageContent}
                tabIndex={0}
                // Same sandbox as the reader: no scripts, no network.
                sandbox="allow-same-origin allow-popups"
                srcDoc={frameHtml}
                onLoad={wireFrame}
              />
            ) : message.textBody ? (
              <PlainTextContent
                text={message.textBody}
                onOpenLink={(url) => void inspectAndOpenExternalLink(url)}
                onOpenMailto={() => undefined}
              />
            ) : (
              <p className="plain-text-body" role="note">
                {strings.mail.emptyBody}
              </p>
            )}
          </div>
          {files.length > 0 ? (
            <section
              className="eml-attachments"
              aria-label={strings.reader.attachments}
            >
              <h3>
                {strings.reader.attachments} ({files.length})
              </h3>
              <ul>
                {files.map((attachment) => (
                  <li key={attachment.id} data-attachment-id={attachment.id}>
                    <span className="eml-attachment-name">
                      <strong>{attachment.filename}</strong>{" "}
                      <small>{formatBytes(attachment.size)}</small>
                    </span>
                    {canPreview(attachment) ? (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busyId !== undefined}
                        onClick={() => void openPreview(attachment)}
                        aria-label={`${strings.reader.preview}: ${attachment.filename}`}
                      >
                        <Eye aria-hidden="true" /> {strings.reader.preview}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busyId !== undefined}
                      onClick={() => void save(attachment)}
                      aria-label={strings.reader.saveNamedFile(
                        attachment.filename,
                      )}
                    >
                      <Download aria-hidden="true" /> {strings.reader.saveFile}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </section>
      {preview ? (
        <AttachmentPreviewDialog
          preview={preview.value}
          onDownload={() => {
            const attachment = files.find(
              (item) => item.id === preview.attachmentId,
            );
            if (attachment) void save(attachment);
          }}
          onClose={() => setPreview(undefined)}
        />
      ) : null}
    </div>,
    document.body,
  );
}
