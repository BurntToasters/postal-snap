import { useEffect, useRef, useState, type RefObject } from "react";
import { Check, ChevronDown, ChevronUp, Copy, ShieldCheck } from "lucide-react";
import { formatBytes, formatFullMessageDate } from "../../format";
import { strings } from "../../i18n";
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

export function MessageHeader({
  message,
  account,
  currentMailbox,
  showDetails,
  onToggleDetails,
  titleRef,
  treatAsOverlay,
}: {
  message: MessageDetail;
  account?: AccountSummary;
  currentMailbox?: MailboxSummary;
  showDetails: boolean;
  onToggleDetails: () => void;
  titleRef: RefObject<HTMLHeadingElement | null>;
  treatAsOverlay: boolean;
}) {
  return (
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
        <div
          className="sender-primary-line"
          data-context="address"
          data-address={message.senderAddress}
        >
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
            <dt>{strings.reader.date}</dt>
            <dd>{formatFullMessageDate(message.receivedAt)}</dd>
            <dt>{strings.reader.subject}</dt>
            <dd>{message.subject || strings.common.noSubject}</dd>
            <dt>{strings.reader.folder}</dt>
            <dd>
              {account ? `${account.displayName || account.email} › ` : ""}
              {currentMailbox?.displayName || strings.mail.mailboxFallback}
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
