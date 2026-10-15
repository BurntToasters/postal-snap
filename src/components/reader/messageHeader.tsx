import { useEffect, useRef, useState, type RefObject } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Forward,
  Reply,
  ShieldCheck,
} from "lucide-react";
import {
  formatBytes,
  formatFullMessageDate,
  notableArrival,
} from "../../format";
import { strings } from "../../i18n";
import { recipientLines, recipientPreview } from "./readerUtils";
import { listPostAddress } from "../composer/composerSeed";
import { conflictingNameAddress } from "../../senderName";
import { HighlightedText } from "../HighlightedText";
import { highlightTerms } from "../../searchHighlight";
import { folderPathLabel } from "../../i18n/mail";
import type {
  AccountSummary,
  MailboxSummary,
  MessageDetail,
} from "../../types";

export function CopyButton({ text, title }: { text: string; title: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <>
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
      <span className="visually-hidden" role="status">
        {copied ? strings.reader.copied : ""}
      </span>
    </>
  );
}

function RecipientPreview({ addresses }: { addresses: string[] }) {
  const full = addresses.join(", ");
  const extra = addresses.length > 2;
  return (
    <span className="recipient-preview" title={extra ? full : undefined}>
      <span aria-hidden={extra ? true : undefined}>
        {recipientPreview(addresses)}
      </span>
      {extra ? <span className="visually-hidden">{full}</span> : null}
    </span>
  );
}

export function MessageHeader({
  message,
  account,
  currentMailbox,
  showDetails,
  onToggleDetails,
  titleRef,
  treatAsOverlay,
  answered = false,
  forwarded = false,
  onShowInFolder,
  onOpenEarlier,
  searchQuery,
}: {
  message: MessageDetail;
  account?: AccountSummary;
  currentMailbox?: MailboxSummary;
  showDetails: boolean;
  onToggleDetails: () => void;
  titleRef: RefObject<HTMLHeadingElement | null>;
  treatAsOverlay: boolean;
  answered?: boolean;
  forwarded?: boolean;
  onShowInFolder?: () => void;
  onOpenEarlier?: () => void;
  searchQuery?: string;
}) {
  const folderName = currentMailbox
    ? folderPathLabel(currentMailbox)
    : strings.mail.mailboxFallback;
  const nameConflict = conflictingNameAddress(
    message.senderName,
    message.senderAddress,
  );
  const arrived = notableArrival(message.receivedAt, message.arrivedAt);
  const nameConflictLabel = nameConflict
    ? strings.reader.nameIncludesDifferentAddress(nameConflict)
    : "";
  const listAddress = listPostAddress(message.listPost);
  const files = message.attachments.filter((item) => !item.inline);
  const fileCount = files.length;
  const fileBytes = files.reduce((total, item) => total + item.size, 0);
  const mailingListLabel = listAddress
    ? strings.reader.mailingList(listAddress)
    : "";
  const marks = highlightTerms(searchQuery ?? "");
  return (
    <header className="message-header">
      <h1
        id="message-title"
        ref={titleRef}
        tabIndex={treatAsOverlay ? -1 : undefined}
      >
        <HighlightedText
          text={message.subject || strings.common.noSubject}
          terms={marks.subject}
        />
      </h1>
      <div className="sender-avatar" aria-hidden="true">
        {(message.senderName || message.senderAddress)
          .slice(0, 1)
          .toUpperCase()}
      </div>
      <div className="sender-details">
        <div
          className="sender-primary-line"
          data-context="address"
          data-address={message.senderAddress}
        >
          <strong className="sender-name">
            <HighlightedText
              text={message.senderName || message.senderAddress}
              terms={marks.correspondent}
            />
          </strong>
          {message.senderName &&
          message.senderName !== message.senderAddress ? (
            <span className="sender-address-muted">
              &lt;{message.senderAddress}&gt;
            </span>
          ) : null}
        </div>
        {nameConflictLabel ? (
          <p
            className="sender-name-conflict"
            role="note"
            aria-label={nameConflictLabel}
          >
            {nameConflictLabel}
          </p>
        ) : null}
        {mailingListLabel ? (
          <p
            className="mailing-list-note"
            role="note"
            aria-label={mailingListLabel}
          >
            {mailingListLabel}
          </p>
        ) : null}
        {message.conversationMuted ? (
          <p className="message-muted" role="status">
            {strings.mail.muted}
          </p>
        ) : null}
        {message.importance === "high" || message.importance === "low" ? (
          <p
            className={`message-importance ${message.importance}`}
            role="status"
          >
            {message.importance === "high"
              ? strings.mail.highImportance
              : strings.mail.lowImportance}
          </p>
        ) : null}
        {answered || forwarded ? (
          <div className="reply-state" data-testid="reply-state">
            {answered ? (
              <span>
                <Reply aria-hidden="true" size={14} />
                {strings.mail.replied}
              </span>
            ) : null}
            {forwarded ? (
              <span>
                <Forward aria-hidden="true" size={14} />
                {strings.mail.forwarded}
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="recipient-summary">
          <span className="recipient-label">{strings.reader.to}</span>
          {message.to.length > 0 ? (
            <RecipientPreview addresses={message.to} />
          ) : (
            <span className="recipient-preview">
              {strings.reader.noRecipients}
            </span>
          )}
        </div>
        {message.cc && message.cc.length > 0 ? (
          <div className="recipient-summary">
            <span className="recipient-label">{strings.reader.cc}</span>
            <RecipientPreview addresses={message.cc} />
          </div>
        ) : null}
        {message.bcc && message.bcc.length > 0 ? (
          <div className="recipient-summary">
            <span className="recipient-label">{strings.reader.bcc}</span>
            <RecipientPreview addresses={message.bcc} />
          </div>
        ) : null}
        {message.replyTo && message.replyTo !== message.senderAddress ? (
          <div className="recipient-summary">
            <span className="recipient-label">{strings.reader.replyTo}</span>
            <span className="recipient-preview" title={message.replyTo}>
              {message.replyTo}
            </span>
          </div>
        ) : null}
        <div className="message-header-links">
          {onOpenEarlier ? (
            <button
              type="button"
              className="header-files"
              onClick={onOpenEarlier}
            >
              {strings.reader.openEarlier}
            </button>
          ) : null}
          {fileCount > 0 ? (
            <button
              type="button"
              className="header-files"
              onClick={() => {
                const target = document.getElementById("message-attachments");
                target?.scrollIntoView({ block: "nearest" });
                target?.focus();
              }}
            >
              {strings.reader.showFiles(fileCount)}
              <span className="header-file-size">{formatBytes(fileBytes)}</span>
            </button>
          ) : null}
          {onShowInFolder && currentMailbox ? (
            <button
              type="button"
              className="header-files"
              onClick={onShowInFolder}
            >
              {strings.reader.showInFolder(folderName)}
            </button>
          ) : null}
          <button
            type="button"
            className="details-toggle"
            onClick={onToggleDetails}
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
      </div>
      <div className="message-stamp">
        <time
          dateTime={message.receivedAt}
          title={formatFullMessageDate(message.receivedAt)}
        >
          {new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(message.receivedAt))}
        </time>
        <span className="message-header-size">{formatBytes(message.size)}</span>
      </div>
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
              <span
                className="address-chip"
                data-context="address"
                data-address={message.senderAddress}
              >
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
            {listAddress ? (
              <>
                <dt>{strings.reader.mailingListLabel}</dt>
                <dd className="address-row">
                  <span
                    className="address-chip"
                    data-context="address"
                    data-address={listAddress}
                  >
                    {listAddress}
                  </span>
                  <CopyButton
                    text={listAddress}
                    title={strings.reader.copyAddress}
                  />
                </dd>
              </>
            ) : null}
            {message.replyTo && message.replyTo !== message.senderAddress ? (
              <>
                <dt>{strings.reader.replyTo}</dt>
                <dd className="address-row reply-to-highlight">
                  <span
                    className="address-chip"
                    data-context="address"
                    data-address={message.replyTo}
                  >
                    {message.replyTo}
                  </span>
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
                  <span
                    key={addr}
                    className="address-chip"
                    data-context="address"
                    data-address={addr}
                  >
                    {addr}
                  </span>
                ))
              ) : (
                <span>{strings.reader.noRecipients}</span>
              )}
              {recipientLines(message.to, message.cc, message.bcc) ? (
                <CopyButton
                  text={recipientLines(message.to, message.cc, message.bcc)}
                  title={strings.reader.copyRecipients}
                />
              ) : null}
            </dd>
            {message.cc && message.cc.length > 0 ? (
              <>
                <dt>{strings.reader.cc}</dt>
                <dd className="recipients-list">
                  {message.cc.map((addr) => (
                    <span
                      key={addr}
                      className="address-chip"
                      data-context="address"
                      data-address={addr}
                    >
                      {addr}
                    </span>
                  ))}
                </dd>
              </>
            ) : null}
            {message.bcc && message.bcc.length > 0 ? (
              <>
                <dt>{strings.reader.bcc}</dt>
                <dd className="recipients-list">
                  {message.bcc.map((addr) => (
                    <span
                      key={`bcc-${addr}`}
                      className="address-chip"
                      data-context="address"
                      data-address={addr}
                    >
                      {addr}
                    </span>
                  ))}
                </dd>
              </>
            ) : null}
            <dt>{strings.reader.date}</dt>
            <dd>{formatFullMessageDate(message.receivedAt)}</dd>
            {arrived ? (
              <>
                <dt>{strings.reader.arrived}</dt>
                <dd>{formatFullMessageDate(arrived)}</dd>
              </>
            ) : null}
            <dt>{strings.reader.subject}</dt>
            <dd className="message-id-row">
              <span>
                <HighlightedText
                  text={message.subject || strings.common.noSubject}
                  terms={marks.subject}
                />
              </span>
              {message.subject.trim() ? (
                <CopyButton
                  text={message.subject}
                  title={strings.reader.copySubject}
                />
              ) : null}
            </dd>
            <dt>{strings.reader.folder}</dt>
            <dd className="message-id-row">
              <span>
                {account ? `${account.displayName || account.email} › ` : ""}
                {folderName}
              </span>
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
  );
}
