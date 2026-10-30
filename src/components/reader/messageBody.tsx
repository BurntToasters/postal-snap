import { useMemo, type RefObject } from "react";
import { Image, ShieldAlert, ShieldCheck } from "lucide-react";
import { strings } from "../../i18n";
import type { SanitizedMail } from "../../security";
import type { MessageDetail } from "../../types";
import { HighlightedText } from "../HighlightedText";
import { InviteCard } from "./inviteCard";

type PlainTextPart = {
  type: "text" | "link" | "mailto";
  content: string;
};

function isUrlBodyChar(ch: string): boolean {
  return ch.length > 0 && !/\s/.test(ch) && !"<>'\"()".includes(ch);
}

function isEmailLocalChar(ch: string): boolean {
  return /[a-zA-Z0-9._%+-]/.test(ch);
}

function isEmailDomainChar(ch: string): boolean {
  return /[a-zA-Z0-9.-]/.test(ch);
}

function httpUrlLength(text: string, i: number): number | null {
  const start = i;
  if (text.startsWith("https://", i)) i += 8;
  else if (text.startsWith("http://", i)) i += 7;
  else return null;
  while (i < text.length && isUrlBodyChar(text[i]!)) i += 1;
  return i - start;
}

function findNextHttpUrl(text: string, from: number): number {
  let cursor = from;
  while (cursor <= text.length) {
    const idx = text.indexOf("http://", cursor);
    if (idx === -1) return -1;
    if (text.startsWith("https://", idx)) {
      cursor = idx + 1;
      continue;
    }
    return idx;
  }
  return -1;
}

function findNextHttpsUrl(text: string, from: number): number {
  return text.indexOf("https://", from);
}

function findNextMailto(text: string, from: number): number {
  return text.indexOf("mailto:", from);
}

function mailtoLength(text: string, i: number): number | null {
  if (!text.startsWith("mailto:", i)) return null;
  i += 7;
  const start = i - 7;
  while (i < text.length && isUrlBodyChar(text[i]!)) i += 1;
  return i - start;
}

function findNextBareEmail(
  text: string,
  from: number,
): { start: number; length: number } | null {
  let search = from;
  while (search < text.length) {
    const at = text.indexOf("@", search);
    if (at === -1) return null;
    let localStart = at;
    while (localStart > 0 && isEmailLocalChar(text[localStart - 1]!)) {
      localStart -= 1;
    }
    if (localStart < from || localStart >= at) {
      search = at + 1;
      continue;
    }
    const length = tryBareEmail(text, localStart);
    if (length !== null) {
      return { start: localStart, length };
    }
    search = at + 1;
  }
  return null;
}

function tryBareEmail(text: string, i: number): number | null {
  if (!text[i] || !isEmailLocalChar(text[i]!)) return null;
  let j = i;
  while (j < text.length && isEmailLocalChar(text[j]!)) j += 1;
  if (j >= text.length || text[j] !== "@") return null;
  j += 1;
  const domainStart = j;
  while (j < text.length && isEmailDomainChar(text[j]!)) j += 1;
  if (j === domainStart) return null;
  for (let dot = j - 1; dot > domainStart; dot -= 1) {
    if (text[dot] !== ".") continue;
    const tld = text.slice(dot + 1, j);
    if (!/^[a-zA-Z]{2,}$/.test(tld)) continue;
    const host = text.slice(domainStart, dot);
    if (host.length > 0 && /^[a-zA-Z0-9.-]+$/.test(host)) {
      return j - i;
    }
  }
  return null;
}

function splitTrailingPunctuation(matched: string): {
  trimmed: string;
  trailing: string;
} {
  const trimmed = matched.replace(/[.,!?;:]+$/, "");
  return { trimmed, trailing: matched.slice(trimmed.length) };
}

type LinkCandidate = {
  start: number;
  length: number;
  kind: "url" | "mailto" | "email";
};

function nextLinkCandidate(text: string, from: number): LinkCandidate | null {
  const candidates: LinkCandidate[] = [];
  const httpsAt = findNextHttpsUrl(text, from);
  if (httpsAt !== -1) {
    const length = httpUrlLength(text, httpsAt);
    if (length !== null)
      candidates.push({ start: httpsAt, length, kind: "url" });
  }
  const httpAt = findNextHttpUrl(text, from);
  if (httpAt !== -1) {
    const length = httpUrlLength(text, httpAt);
    if (length !== null)
      candidates.push({ start: httpAt, length, kind: "url" });
  }
  const mailtoAt = findNextMailto(text, from);
  if (mailtoAt !== -1) {
    const length = mailtoLength(text, mailtoAt);
    if (length !== null)
      candidates.push({ start: mailtoAt, length, kind: "mailto" });
  }
  const email = findNextBareEmail(text, from);
  if (email) {
    candidates.push({
      start: email.start,
      length: email.length,
      kind: "email",
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.start - b.start);
  return candidates[0]!;
}

function tokenizePlainTextLinks(text: string): PlainTextPart[] {
  const elements: PlainTextPart[] = [];
  let lastIndex = 0;
  while (lastIndex < text.length) {
    const candidate = nextLinkCandidate(text, lastIndex);
    if (!candidate) {
      elements.push({ type: "text", content: text.slice(lastIndex) });
      break;
    }
    if (candidate.start > lastIndex) {
      elements.push({
        type: "text",
        content: text.slice(lastIndex, candidate.start),
      });
    }
    const matched = text.slice(
      candidate.start,
      candidate.start + candidate.length,
    );
    const { trimmed, trailing } = splitTrailingPunctuation(matched);
    if (candidate.kind === "url") {
      elements.push({ type: "link", content: trimmed });
    } else if (candidate.kind === "mailto") {
      elements.push({ type: "mailto", content: trimmed });
    } else {
      elements.push({ type: "mailto", content: `mailto:${trimmed}` });
    }
    if (trailing) {
      elements.push({ type: "text", content: trailing });
    }
    lastIndex = candidate.start + matched.length;
  }
  return elements;
}

export function PlainTextContent({
  text,
  onOpenLink,
  onOpenMailto,
  searchTerms = [],
}: {
  text: string;
  onOpenLink: (url: string) => void;
  onOpenMailto: (mailto: string) => void;
  searchTerms?: string[];
}) {
  const parts = useMemo(() => tokenizePlainTextLinks(text), [text]);

  return (
    <div className="plain-text-body">
      {parts.map((part, idx) => {
        if (part.type === "text") {
          return (
            <span key={idx}>
              <HighlightedText text={part.content} terms={searchTerms} />
            </span>
          );
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
  if (message.bodyStatus === "unreadable") return strings.mail.bodyUnreadable;
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
  plainText,
  followsTheme = false,
  currentLoadedHtml,
  frameHtml,
  filteredImages,
  threatImages,
  remainingBlockedImages,
  loadingImages,
  findOpen,
  findQuery,
  findStatus,
  findInputRef,
  bodyRef,
  frameRef,
  onFindQueryChange,
  onCloseFind,
  onSubmitFind,
  onFindPrevious,
  onLoadImages,
  onFrameLoad,
  onOpenLink,
  onOpenMailto,
  searchTerms,
}: {
  message: MessageDetail;
  sanitized?: SanitizedMail;
  showHtml?: boolean;
  /** Text to show instead of the HTML part. */
  plainText?: string;
  /** Dark mode and no sender colors: draw the body in the app theme. */
  followsTheme?: boolean;
  currentLoadedHtml?: string;
  frameHtml: string;
  filteredImages: number;
  threatImages: number;
  remainingBlockedImages: number;
  loadingImages: boolean;
  findOpen: boolean;
  findQuery: string;
  findStatus?: string;
  findInputRef: RefObject<HTMLInputElement | null>;
  bodyRef: RefObject<HTMLDivElement | null>;
  frameRef: RefObject<HTMLIFrameElement | null>;
  onFindQueryChange: (value: string) => void;
  onCloseFind: () => void;
  onSubmitFind: () => void;
  onFindPrevious: () => void;
  onLoadImages: () => void;
  onFrameLoad: () => void;
  onOpenLink: (url: string) => void;
  onOpenMailto: (mailto: string) => void;
  searchTerms?: string[];
}) {
  return (
    <>
      {message.invite ? <InviteCard invite={message.invite} /> : null}
      {filteredImages > 0 ? (
        <div className="remote-content-banner" role="status" aria-live="polite">
          <ShieldCheck aria-hidden="true" />
          <span>{strings.reader.filteredImages(filteredImages)}</span>
        </div>
      ) : null}
      {threatImages > 0 ? (
        <div
          className="remote-content-banner warning"
          role="status"
          aria-live="polite"
        >
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
            {sanitized?.blockedImageHosts.length ? (
              <strong className="remote-image-hosts">
                {" "}
                {sanitized.blockedImageHosts.join(", ")}
              </strong>
            ) : null}
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
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.shiftKey) {
                event.preventDefault();
                onFindPrevious();
              }
            }}
            placeholder={strings.reader.findInMessage}
            aria-label={strings.reader.findInMessage}
          />
          <button
            type="button"
            className="secondary-button"
            onClick={onFindPrevious}
          >
            {strings.reader.findPrevious}
          </button>
          <button type="submit" className="secondary-button">
            {strings.reader.findNext}
          </button>
          {findStatus ? (
            <span className="message-find-status" role="status">
              {findStatus}
            </span>
          ) : null}
          <button
            type="button"
            className="secondary-button"
            onClick={onCloseFind}
          >
            {strings.common.close}
          </button>
        </form>
      ) : null}
      <div
        className="message-body"
        ref={bodyRef}
        data-context="reader"
        data-follows-theme={followsTheme ? "true" : undefined}
      >
        {!showHtml && !(plainText ?? message.textBody) ? (
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
            text={plainText ?? message.textBody}
            onOpenLink={onOpenLink}
            onOpenMailto={onOpenMailto}
            searchTerms={searchTerms}
          />
        )}
      </div>
    </>
  );
}
