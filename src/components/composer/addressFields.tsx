import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { strings } from "../../i18n";
import {
  splitAddresses,
  validateRecipientFields,
  validateSubject,
} from "./composerValidate";
import { RecipientField } from "./recipientField";

export interface AddressFieldsProps {
  accountId: string;
  availableSenders: { email: string; label: string }[];
  fromAddress: string;
  fromValue: string;
  setFromAddress: (value: string) => void;
  to: string;
  setTo: (value: string) => void;
  cc: string;
  setCc: (value: string) => void;
  bcc: string;
  setBcc: (value: string) => void;
  showCc: boolean;
  setShowCc: Dispatch<SetStateAction<boolean>>;
  showBcc: boolean;
  setShowBcc: Dispatch<SetStateAction<boolean>>;
  subject: string;
  setSubject: (value: string) => void;
  recipientError?: string;
  setRecipientError: (value: string | undefined) => void;
  subjectError?: string;
  setSubjectError: (value: string | undefined) => void;
  subjectLocked?: boolean;
  replyTo?: string;
  setReplyTo?: (value: string) => void;
  replyToError?: string;
  setReplyToError?: (value: string | undefined) => void;
  markUnsaved: () => void;
  /** When the letter already has recipients, the cursor starts in the letter. */
  focusTo?: boolean;
}

export function AddressFields({
  accountId,
  availableSenders,
  fromAddress,
  fromValue,
  setFromAddress,
  to,
  setTo,
  cc,
  setCc,
  bcc,
  setBcc,
  showCc,
  setShowCc,
  showBcc,
  setShowBcc,
  subject,
  setSubject,
  recipientError,
  setRecipientError,
  subjectError,
  setSubjectError,
  subjectLocked = false,
  replyTo,
  setReplyTo,
  replyToError,
  setReplyToError,
  markUnsaved,
  focusTo = true,
}: AddressFieldsProps) {
  // Recipients are never hidden: a field that holds addresses stays open.
  const ccOpen = showCc || Boolean(cc.trim());
  const bccOpen = showBcc || Boolean(bcc.trim());
  // Reply-To stays tucked away like Cc and Bcc unless it already has a value.
  const [showReplyTo, setShowReplyTo] = useState(() =>
    Boolean(replyTo?.trim()),
  );
  const replyToOpen =
    Boolean(setReplyTo) && (showReplyTo || Boolean(replyToError));
  return (
    <div className="address-fields">
      <label className="from-field">
        <span>{strings.composer.from}</span>
        {availableSenders.length > 1 ? (
          <select
            className="composer-from-select"
            value={fromAddress}
            onChange={(event) => {
              setFromAddress(event.target.value);
              markUnsaved();
            }}
            aria-label={strings.composer.fromAlias}
          >
            {availableSenders.map((item) => (
              <option key={item.email} value={item.email}>
                {item.label}
              </option>
            ))}
          </select>
        ) : (
          <input readOnly value={fromValue} aria-readonly="true" />
        )}
      </label>
      {replyToOpen && setReplyTo ? (
        <label className="from-field">
          <span>{strings.composer.replyTo}</span>
          <input
            id="composer-reply-to"
            value={replyTo ?? ""}
            maxLength={320}
            autoComplete="off"
            spellCheck={false}
            placeholder={strings.composer.replyToPlaceholder}
            aria-invalid={Boolean(replyToError)}
            aria-describedby={replyToError ? "reply-to-error" : undefined}
            onChange={(event) => {
              setReplyTo(event.target.value);
              if (replyToError) setReplyToError?.(undefined);
              markUnsaved();
            }}
          />
        </label>
      ) : null}
      {replyToError ? (
        <p id="reply-to-error" className="field-error" role="alert">
          {replyToError}
        </p>
      ) : null}
      <div className="to-field-row">
        <label className="to-field">
          <span>{strings.composer.to}</span>
          <RecipientField
            id="composer-to"
            accountId={accountId}
            value={to}
            onChange={(value) => {
              setTo(value);
              if (recipientError) {
                setRecipientError(validateRecipientFields(value, cc, bcc));
              }
              markUnsaved();
            }}
            onBlur={() => {
              if (to.trim() || cc.trim() || bcc.trim()) {
                setRecipientError(validateRecipientFields(to, cc, bcc));
              }
            }}
            placeholder={strings.composer.addressPlaceholder}
            autoFocus={focusTo}
            ariaInvalid={Boolean(recipientError)}
            ariaDescribedBy={recipientError ? "recipient-error" : undefined}
          />
        </label>
        <button
          type="button"
          className="cc-toggle"
          aria-expanded={ccOpen}
          aria-pressed={ccOpen}
          onClick={(event) => {
            event.preventDefault();
            toggleCopyField(cc, ccOpen, setShowCc, "composer-cc");
          }}
        >
          {withCount(strings.composer.cc, cc)}
        </button>
        <button
          type="button"
          className="cc-toggle"
          aria-expanded={bccOpen}
          aria-pressed={bccOpen}
          onClick={(event) => {
            event.preventDefault();
            toggleCopyField(bcc, bccOpen, setShowBcc, "composer-bcc");
          }}
        >
          {withCount(strings.composer.bcc, bcc)}
        </button>
        {setReplyTo ? (
          <button
            type="button"
            className="cc-toggle"
            aria-expanded={replyToOpen}
            aria-pressed={replyToOpen}
            onClick={(event) => {
              event.preventDefault();
              setShowReplyTo((value) => !value);
            }}
          >
            {strings.composer.replyTo}
          </button>
        ) : null}
      </div>
      {ccOpen ? (
        <label>
          <span>{strings.composer.cc}</span>
          <RecipientField
            id="composer-cc"
            accountId={accountId}
            value={cc}
            onChange={(value) => {
              setCc(value);
              if (recipientError) {
                setRecipientError(validateRecipientFields(to, value, bcc));
              }
              markUnsaved();
            }}
            onBlur={() => {
              if (to.trim() || cc.trim() || bcc.trim()) {
                setRecipientError(validateRecipientFields(to, cc, bcc));
              }
            }}
            ariaInvalid={Boolean(recipientError)}
          />
        </label>
      ) : null}
      {bccOpen ? (
        <label>
          <span>{strings.composer.bcc}</span>
          <RecipientField
            id="composer-bcc"
            accountId={accountId}
            value={bcc}
            onChange={(value) => {
              setBcc(value);
              if (recipientError) {
                setRecipientError(validateRecipientFields(to, cc, value));
              }
              markUnsaved();
            }}
            onBlur={() => {
              if (to.trim() || cc.trim() || bcc.trim()) {
                setRecipientError(validateRecipientFields(to, cc, bcc));
              }
            }}
            ariaInvalid={Boolean(recipientError)}
          />
        </label>
      ) : null}
      {recipientError ? (
        <p id="recipient-error" className="field-error" role="alert">
          {recipientError}
        </p>
      ) : null}
      <label>
        <span>{strings.composer.subject}</span>
        <input
          id="composer-subject"
          value={subject}
          readOnly={subjectLocked}
          onChange={(event) => {
            if (subjectLocked) return;
            setSubject(event.target.value);
            markUnsaved();
          }}
          onBlur={() => setSubjectError(validateSubject(subject))}
          maxLength={998}
          aria-invalid={Boolean(subjectError)}
          aria-describedby={subjectError ? "subject-error" : undefined}
        />
      </label>
      {subjectError ? (
        <p id="subject-error" className="field-error" role="alert">
          {subjectError}
        </p>
      ) : null}
    </div>
  );
}

function withCount(label: string, value: string): string {
  const count = splitAddresses(value).length;
  return count > 0 ? `${label} (${count})` : label;
}

/** Hide only an empty field; a field with recipients gets focus instead. */
function toggleCopyField(
  value: string,
  shown: boolean,
  setShown: Dispatch<SetStateAction<boolean>>,
  inputId: string,
) {
  if (shown && value.trim()) {
    document.getElementById(inputId)?.focus();
    return;
  }
  setShown(!shown);
}
