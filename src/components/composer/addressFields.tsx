import type { Dispatch, SetStateAction } from "react";
import { strings } from "../../i18n";
import { validateRecipientFields, validateSubject } from "./composerValidate";
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
  markUnsaved: () => void;
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
  markUnsaved,
}: AddressFieldsProps) {
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
            autoFocus
            ariaInvalid={Boolean(recipientError)}
            ariaDescribedBy={recipientError ? "recipient-error" : undefined}
          />
        </label>
        <button
          type="button"
          className="cc-toggle"
          aria-expanded={showCc}
          aria-pressed={showCc}
          onClick={(event) => {
            event.preventDefault();
            setShowCc((value) => !value);
          }}
        >
          {strings.composer.cc}
        </button>
        <button
          type="button"
          className="cc-toggle"
          aria-expanded={showBcc}
          aria-pressed={showBcc}
          onClick={(event) => {
            event.preventDefault();
            setShowBcc((value) => !value);
          }}
        >
          {strings.composer.bcc}
        </button>
      </div>
      {showCc ? (
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
      {showBcc ? (
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
          value={subject}
          onChange={(event) => {
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
