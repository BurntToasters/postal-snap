import { useMemo, type RefObject } from "react";
import { Image, ShieldAlert, ShieldCheck } from "lucide-react";
import { strings } from "../../i18n";
import type { SanitizedMail } from "../../security";
import type { MessageDetail } from "../../types";

export function PlainTextContent({
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
              data-context="link"
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
            data-context="link"
            data-external-href={part.content}
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

function missingBodyNote(message: MessageDetail): string {
  if (message.bodyStatus === "offline") return strings.mail.bodyOffline;
  if (message.bodyStatus === "signInNeeded")
    return strings.mail.bodySignInNeeded;
  if (message.bodyStatus === "tooLarge" || message.size > 50 * 1024 * 1024)
    return strings.mail.messageTooLarge;
  return strings.mail.emptyBody;
}

export function MessageBody({
  message,
  sanitized,
  showHtml = Boolean(message.htmlBody),
  currentLoadedHtml,
  frameHtml,
  filteredImages,
  threatImages,
  remainingBlockedImages,
  loadingImages,
  findOpen,
  findQuery,
  findInputRef,
  bodyRef,
  frameRef,
  onFindQueryChange,
  onCloseFind,
  onSubmitFind,
  onLoadImages,
  onFrameLoad,
  onOpenLink,
  onOpenMailto,
}: {
  message: MessageDetail;
  sanitized?: SanitizedMail;
  showHtml?: boolean;
  currentLoadedHtml?: string;
  frameHtml: string;
  filteredImages: number;
  threatImages: number;
  remainingBlockedImages: number;
  loadingImages: boolean;
  findOpen: boolean;
  findQuery: string;
  findInputRef: RefObject<HTMLInputElement | null>;
  bodyRef: RefObject<HTMLDivElement | null>;
  frameRef: RefObject<HTMLIFrameElement | null>;
  onFindQueryChange: (value: string) => void;
  onCloseFind: () => void;
  onSubmitFind: () => void;
  onLoadImages: () => void;
  onFrameLoad: () => void;
  onOpenLink: (url: string) => void;
  onOpenMailto: (mailto: string) => void;
}) {
  return (
    <>
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
          <button type="button" onClick={onLoadImages} disabled={loadingImages}>
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
            onSubmitFind();
          }}
        >
          <input
            ref={findInputRef}
            value={findQuery}
            onChange={(event) => onFindQueryChange(event.target.value)}
            placeholder={strings.reader.findInMessage}
            aria-label={strings.reader.findInMessage}
          />
          <button type="submit">{strings.reader.findNext}</button>
          <button type="button" onClick={onCloseFind}>
            {strings.common.close}
          </button>
        </form>
      ) : null}
      <div className="message-body" ref={bodyRef} data-context="reader">
        {!showHtml && !message.textBody ? (
          <p className="plain-text-body" role="note">
            {missingBodyNote(message)}
          </p>
        ) : showHtml ? (
          <iframe
            ref={frameRef}
            title={strings.reader.messageContent}
            tabIndex={0}
            // allow-same-origin is required so the parent can reach
            // contentDocument for link wiring, scroll, and find; the document
            // itself stays scriptless and networkless (no allow-scripts).
            // allow-popups lets WebKit hand link clicks to the native
            // new-window hook, which always denies and routes them to the
            // link confirmation flow.
            sandbox="allow-same-origin allow-popups"
            srcDoc={frameHtml}
            onLoad={onFrameLoad}
          />
        ) : (
          <PlainTextContent
            text={message.textBody}
            onOpenLink={onOpenLink}
            onOpenMailto={onOpenMailto}
          />
        )}
      </div>
    </>
  );
}
