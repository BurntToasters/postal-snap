import { useState } from "react";
import { api } from "../../api";
import { mergeAccountFields } from "../../accountMerge";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type { AccountSummary, BodyFormat } from "../../types";

/** Per-account default format for new messages. */
export function BodyFormatControl({ account }: { account: AccountSummary }) {
  const setError = useAppStore((state) => state.setError);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const id = `account-body-format-${account.id}`;

  async function change(format: BodyFormat) {
    setSaving(true);
    setStatus("");
    try {
      const updated = await api.updateAccountDefaultBodyFormat(
        account.id,
        format,
      );
      mergeAccountFields(account.id, {
        defaultBodyFormat: updated.defaultBodyFormat,
      });
      setStatus(strings.settings.newMessageFormatSaved);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="account-password-section">
      <label htmlFor={id}>{strings.settings.newMessageFormat}</label>
      <p className="settings-note">{strings.settings.newMessageFormatHelp}</p>
      <select
        id={id}
        value={account.defaultBodyFormat ?? "html"}
        disabled={saving}
        onChange={(event) => void change(event.target.value as BodyFormat)}
      >
        <option value="html">{strings.composer.richText}</option>
        <option value="plain">{strings.composer.plainText}</option>
      </select>
      {status ? (
        <div className="alias-status-message" role="status" aria-live="polite">
          {status}
        </div>
      ) : null}
    </div>
  );
}
