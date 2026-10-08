import { useEffect, useState } from "react";
import { api } from "../../api";
import { roleLabels } from "../../i18n/mail";
import { strings } from "../../i18n";
import type {
  AccountConnection,
  AccountSummary,
  FolderAssignment,
  MailboxSummary,
} from "../../types";
import { ServerFields } from "../setup/serverFields";
import { BridgeCertificateControl } from "./bridgeCertificate";

export function ConnectionPanel({
  account,
  onDirty,
}: {
  account: AccountSummary;
  onDirty: (dirty: boolean) => void;
}) {
  const [saved, setSaved] = useState<AccountConnection>();
  const [draft, setDraft] = useState<AccountConnection>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const dirty =
    !!saved &&
    !!draft &&
    JSON.stringify([saved.imap, saved.smtp]) !==
      JSON.stringify([draft.imap, draft.smtp]);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    let disposed = false;
    void api
      .getAccountConnection(account.id)
      .then((value) => {
        if (!disposed) {
          setSaved(value);
          setDraft(value);
        }
      })
      .catch((cause) => {
        if (!disposed) setStatus(String(cause));
      });
    return () => {
      disposed = true;
    };
  }, [account.id]);
  async function save() {
    if (!draft || !saved || busy) return;
    setBusy(true);
    setStatus("");
    try {
      const changed =
        draft.imap.host !== saved.imap.host ||
        draft.imap.username !== saved.imap.username;
      if (
        changed &&
        !(await api.showNativeConfirm(
          strings.settings.identityChangeTitle,
          strings.settings.identityChangeHelp,
        ))
      )
        return;
      const value = await api.updateAccountConnection(
        account.id,
        draft.imap,
        draft.smtp,
        changed,
      );
      setSaved(value);
      setDraft(value);
      setStatus(strings.settings.connectionSaved);
    } catch {
      setStatus(strings.settings.connectionFailed);
    } finally {
      setBusy(false);
    }
  }
  async function refreshCertificate() {
    try {
      const value = await api.getAccountConnection(account.id);
      setSaved(value);
      setDraft((old) =>
        old ? { ...old, certificate: value.certificate } : value,
      );
    } catch (cause) {
      setStatus(String(cause));
    }
  }
  return (
    <div className="connection-panel">
      {account.provider === "protonBridge" ? (
        <p className="settings-lead">{strings.setup.bridgeIntro}</p>
      ) : null}
      {draft ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={busy} className="connection-fields">
            <ServerFields
              title={strings.setup.incoming}
              value={draft.imap}
              onChange={(patch) =>
                setDraft({ ...draft, imap: { ...draft.imap, ...patch } })
              }
            />
            <ServerFields
              title={strings.setup.outgoing}
              value={draft.smtp}
              onChange={(patch) =>
                setDraft({ ...draft, smtp: { ...draft.smtp, ...patch } })
              }
            />
          </fieldset>
          <button className="primary-button" disabled={busy} type="submit">
            {busy
              ? strings.settings.testingConnection
              : strings.settings.testSave}
          </button>
        </form>
      ) : null}
      {account.provider === "protonBridge" ? (
        <BridgeCertificateControl
          accountId={account.id}
          current={saved?.certificate}
          onApproved={() => void refreshCertificate()}
        />
      ) : null}
      {status ? <p role="status">{status}</p> : null}
    </div>
  );
}

export function FoldersPanel({
  accountId,
  mailboxes,
}: {
  accountId: string;
  mailboxes: MailboxSummary[];
}) {
  const [assignments, setAssignments] = useState<FolderAssignment[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    void api
      .getFolderAssignments(accountId)
      .then((value) => {
        if (!disposed) setAssignments(value);
      })
      .catch((cause) => {
        if (!disposed) setStatus(String(cause));
      });
    return () => {
      disposed = true;
    };
  }, [accountId]);
  async function assign(role: FolderAssignment["role"], value: string) {
    setBusy(true);
    try {
      setAssignments(
        await api.setFolderAssignment(
          accountId,
          role,
          value ? Number(value) : null,
        ),
      );
      setStatus(strings.settings.folderSaved);
    } catch (cause) {
      setStatus(String(cause));
    } finally {
      setBusy(false);
    }
  }
  const labels = roleLabels;
  return (
    <div className="settings-section">
      {assignments.map((assignment) => (
        <label className="settings-row" key={assignment.role}>
          <span>
            <strong>
              {strings.settings.folderLabel(labels[assignment.role])}
            </strong>
            {assignment.missing ? (
              <small>{strings.settings.folderMissing}</small>
            ) : null}
          </span>
          <select
            disabled={busy}
            value={assignment.mailboxId ?? ""}
            onChange={(event) =>
              void assign(assignment.role, event.target.value)
            }
          >
            <option value="">{strings.settings.automatic}</option>
            {assignment.missing ? (
              <option value={assignment.mailboxId!}>
                {strings.settings.folderMissing}
              </option>
            ) : null}
            {mailboxes
              .filter((mailbox) => mailbox.accountId === accountId)
              .map((mailbox) => (
                <option key={mailbox.id} value={mailbox.id}>
                  {mailbox.displayName || mailbox.name}
                </option>
              ))}
          </select>
        </label>
      ))}
      {status ? <p role="status">{status}</p> : null}
    </div>
  );
}
