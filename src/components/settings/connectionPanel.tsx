import { useEffect, useState } from "react";
import { describeSetupError, normalizeIpcError } from "../../errors";
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
  onOpenOutbox,
}: {
  account: AccountSummary;
  onDirty: (dirty: boolean) => void;
  onOpenOutbox: (accountId: string) => void;
}) {
  const [saved, setSaved] = useState<AccountConnection>();
  const [draft, setDraft] = useState<AccountConnection>();
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [reloadCount, setReloadCount] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [blockerError, setBlockerError] = useState(false);
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
          setLoadState("ready");
        }
      })
      .catch((cause) => {
        if (!disposed) {
          setLoadError(normalizeIpcError(cause).message);
          setLoadState("error");
        }
      });
    return () => {
      disposed = true;
    };
  }, [account.id, reloadCount]);
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
    } catch (cause) {
      const error = normalizeIpcError(cause);
      const detail = describeSetupError(cause, account.provider);
      setBlockerError(error.code === "pendingOperations");
      setStatus(
        `${strings.settings.connectionFailed} ${detail.text} ${detail.hint ?? ""}`,
      );
      if (error.code === "pendingOperations") {
        void api
          .getAccountConnection(account.id)
          .then((value) => {
            setSaved(value);
            setDraft((current) =>
              current
                ? {
                    ...current,
                    certificate: value.certificate,
                    blockers: value.blockers,
                  }
                : value,
            );
          })
          .catch(() => undefined);
      }
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
      setStatus(normalizeIpcError(cause).message);
    }
  }
  return (
    <div className="connection-panel">
      {loadState === "loading" ? (
        <p role="status">{strings.settings.connectionLoading}</p>
      ) : null}
      {loadState === "error" ? (
        <div role="alert" className="settings-load-error">
          <span>
            {strings.settings.connectionLoadFailed} {loadError}
          </span>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setSaved(undefined);
              setDraft(undefined);
              setStatus("");
              setBlockerError(false);
              setLoadError("");
              setLoadState("loading");
              setReloadCount((count) => count + 1);
            }}
          >
            {strings.settings.retry}
          </button>
        </div>
      ) : null}
      {account.provider === "protonBridge" ? (
        <p className="settings-lead">{strings.setup.bridgeIntro}</p>
      ) : null}
      {loadState === "ready" && draft ? (
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
      {loadState === "ready" && account.provider === "protonBridge" ? (
        <BridgeCertificateControl
          accountId={account.id}
          current={saved?.certificate}
          onApproved={() => void refreshCertificate()}
        />
      ) : null}
      {status ? <p role="status">{status}</p> : null}
      {blockerError ? (
        <div className="connection-blockers" role="status">
          {saved?.blockers?.queuedChanges ? (
            <p>
              {strings.settings.queuedChangesRemaining(
                saved.blockers.queuedChanges,
              )}
            </p>
          ) : null}
          {saved?.blockers?.unsentMessages ? (
            <>
              <p>
                {strings.settings.unsentMessagesRemaining(
                  saved.blockers.unsentMessages,
                )}
              </p>
              <button
                type="button"
                className="text-button"
                onClick={() => onOpenOutbox(account.id)}
              >
                {strings.settings.openAccountOutbox}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
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
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [reloadCount, setReloadCount] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [status, setStatus] = useState("");
  const [saveError, setSaveError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    void api
      .getFolderAssignments(accountId)
      .then((value) => {
        if (!disposed) {
          setAssignments(value);
          setLoadState("ready");
        }
      })
      .catch((cause) => {
        if (!disposed) {
          setLoadError(normalizeIpcError(cause).message);
          setLoadState("error");
        }
      });
    return () => {
      disposed = true;
    };
  }, [accountId, reloadCount]);
  async function assign(role: FolderAssignment["role"], value: string) {
    setBusy(true);
    setStatus("");
    setSaveError("");
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
      setSaveError(normalizeIpcError(cause).message);
    } finally {
      setBusy(false);
    }
  }
  const labels = roleLabels;
  return (
    <div className="settings-section">
      {loadState === "loading" ? (
        <p role="status">{strings.settings.foldersLoading}</p>
      ) : null}
      {loadState === "error" ? (
        <div role="alert" className="settings-load-error">
          <span>
            {strings.settings.foldersLoadFailed} {loadError}
          </span>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setAssignments([]);
              setStatus("");
              setSaveError("");
              setLoadError("");
              setLoadState("loading");
              setReloadCount((count) => count + 1);
            }}
          >
            {strings.settings.retry}
          </button>
        </div>
      ) : null}
      {loadState === "ready"
        ? assignments.map((assignment) => (
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
                aria-label={strings.settings.folderLabel(
                  labels[assignment.role],
                )}
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
          ))
        : null}
      {status ? <p role="status">{status}</p> : null}
      {saveError ? <p role="alert">{saveError}</p> : null}
    </div>
  );
}
