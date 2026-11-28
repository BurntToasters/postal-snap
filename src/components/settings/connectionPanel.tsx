import { useEffect, useId, useRef, useState } from "react";
import { describeSetupError, normalizeIpcError } from "../../errors";
import { api } from "../../api";
import { roleLabels } from "../../i18n/mail";
import { strings } from "../../i18n";
import type {
  AccountConnection,
  AccountSummary,
  ConnectionBlockers,
  FailedOfflineOperation,
  FolderAssignment,
  MailboxSummary,
} from "../../types";
import { ServerFields } from "../setup/serverFields";
import { BridgeCertificateControl } from "./bridgeCertificate";
import { SettingsGroup } from "./primitives";
import { ConfirmDialog } from "../composer/confirmDialog";

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
        draft.imap.port !== saved.imap.port ||
        draft.imap.tlsMode !== saved.imap.tlsMode ||
        draft.imap.username !== saved.imap.username;
      if (
        changed &&
        !(await api.showNativeConfirm(
          strings.settings.identityChangeTitle,
          strings.settings.identityChangeHelp,
        ))
      )
        return;
      // The saved password is sent to the new outgoing server too.
      const outgoingChanged =
        draft.smtp.host.trim().toLowerCase() !==
          saved.smtp.host.trim().toLowerCase() ||
        draft.smtp.username.trim() !== saved.smtp.username.trim();
      if (
        outgoingChanged &&
        !(await api.showNativeConfirm(
          strings.settings.outgoingChangeTitle,
          strings.settings.outgoingChangeHelp,
        ))
      )
        return;
      const value = await api.updateAccountConnection(
        account.id,
        draft.imap,
        draft.smtp,
        changed || outgoingChanged,
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
      {loadState === "ready" ? (
        <ConnectionRecovery
          key={account.id}
          accountId={account.id}
          onBlockersChange={(blockers) => {
            setSaved((current) =>
              current ? { ...current, blockers } : current,
            );
            setDraft((current) =>
              current ? { ...current, blockers } : current,
            );
          }}
        />
      ) : null}
    </div>
  );
}

function ConnectionRecovery({
  accountId,
  onBlockersChange,
}: {
  accountId: string;
  onBlockersChange: (blockers: ConnectionBlockers) => void;
}) {
  const [items, setItems] = useState<FailedOfflineOperation[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [reloadCount, setReloadCount] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [confirmingOperations, setConfirmingOperations] = useState<
    FailedOfflineOperation[] | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [dismissError, setDismissError] = useState(false);
  const [status, setStatus] = useState("");
  const id = useId();
  const reviewButtonRef = useRef<HTMLButtonElement>(null);
  const recoveryHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let disposed = false;
    void api
      .getFailedOfflineOperations(accountId)
      .then((result) => {
        if (!disposed) {
          setItems(result.items);
          setTotalCount(result.totalCount);
          setSelectedIds(new Set());
          setLoadState("ready");
        }
      })
      .catch(() => {
        if (!disposed) {
          setLoadState("error");
        }
      });
    return () => {
      disposed = true;
    };
  }, [accountId, reloadCount]);

  function recoveryKind(item: FailedOfflineOperation): string {
    return strings.settings.connectionRecoveryKinds[item.kind];
  }

  function toggleSelected(itemId: number, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
  }

  function refresh() {
    setLoadState("loading");
    setReloadCount((count) => count + 1);
  }

  async function dismissConfirmed() {
    if (!confirmingOperations?.length || busy) return;
    setBusy(true);
    setDismissError(false);
    let dismissed: Awaited<
      ReturnType<typeof api.dismissFailedOfflineOperations>
    >;
    try {
      dismissed = await api.dismissFailedOfflineOperations(
        accountId,
        confirmingOperations.map(({ id, reviewToken }) => ({
          id,
          reviewToken,
        })),
      );
    } catch {
      setConfirmingOperations(null);
      setDismissError(true);
      setLoadState("loading");
      setReloadCount((count) => count + 1);
      setBusy(false);
      reviewButtonRef.current?.focus();
      return;
    }
    onBlockersChange(dismissed.blockers);
    setSelectedIds(new Set());
    setConfirmingOperations(null);
    setStatus(
      strings.settings.connectionRecoveryDismissed(dismissed.dismissedCount),
    );
    try {
      const updated = await api.getFailedOfflineOperations(accountId);
      setItems(updated.items);
      setTotalCount(updated.totalCount);
      setLoadState("ready");
    } catch {
      setLoadState("error");
    } finally {
      setBusy(false);
      recoveryHeadingRef.current?.focus();
    }
  }

  function cancelConfirmation() {
    setConfirmingOperations(null);
    reviewButtonRef.current?.focus();
  }

  const chosenIds = [...selectedIds].sort((left, right) => left - right);
  const confirmedIds = (confirmingOperations ?? []).map((item) => item.id);
  const showLoading = loadState === "loading" && reloadCount > 0;
  const showRecovery =
    showLoading ||
    loadState === "error" ||
    (loadState === "ready" && totalCount > 0) ||
    dismissError ||
    Boolean(status);
  if (!showRecovery) return null;

  return (
    <section
      className="connection-recovery settings-section"
      role="region"
      aria-labelledby={`${id}-title`}
    >
      <h3 ref={recoveryHeadingRef} id={`${id}-title`} tabIndex={-1}>
        {strings.settings.connectionRecovery}
      </h3>
      {showLoading ? (
        <p role="status">{strings.settings.connectionRecoveryLoading}</p>
      ) : null}
      {loadState === "error" ? (
        <div role="alert" className="settings-load-error">
          <span>{strings.settings.connectionRecoveryLoadFailed}</span>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void refresh()}
          >
            {strings.settings.connectionRecoveryRetry}
          </button>
        </div>
      ) : null}
      {loadState === "ready" ? (
        <>
          {totalCount > 0 ? (
            <>
              <p className="settings-note">
                {strings.settings.connectionRecoveryHelp}
              </p>
              <p role="status">
                {strings.settings.connectionRecoveryCount(totalCount)}
              </p>
              <fieldset
                className="connection-recovery-list"
                disabled={busy || confirmingOperations !== null}
              >
                <legend className="visually-hidden">
                  {strings.settings.connectionRecovery}
                </legend>
                <SettingsGroup>
                  {items.map((item) => (
                    <label className="settings-row" key={item.id}>
                      <span>
                        <strong>
                          {recoveryKind(item)} ·{" "}
                          {strings.settings.connectionRecoveryChange(item.id)}
                        </strong>
                      </span>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(item.id)}
                        onChange={(event) =>
                          toggleSelected(item.id, event.currentTarget.checked)
                        }
                      />
                    </label>
                  ))}
                </SettingsGroup>
              </fieldset>
              {totalCount > items.length ? (
                <p className="settings-note">
                  {strings.settings.connectionRecoveryMore}
                </p>
              ) : null}
              <button
                ref={reviewButtonRef}
                type="button"
                className="secondary-button"
                disabled={busy || chosenIds.length === 0}
                onClick={() => {
                  setDismissError(false);
                  setConfirmingOperations(
                    items.filter((item) => selectedIds.has(item.id)),
                  );
                }}
              >
                {strings.settings.reviewFailedChanges}
              </button>
            </>
          ) : null}
        </>
      ) : null}
      {dismissError ? (
        <p role="alert">{strings.settings.connectionRecoveryDismissFailed}</p>
      ) : null}
      {status ? <p role="status">{status}</p> : null}
      {confirmingOperations ? (
        <ConfirmDialog
          title={strings.settings.connectionRecoveryConfirmTitle}
          detail={strings.settings.connectionRecoveryConfirmHelp(
            confirmedIds.join(", "),
          )}
          primaryLabel={strings.settings.connectionRecoveryCancel}
          secondaryLabel={strings.settings.connectionRecoveryDismiss}
          onPrimary={cancelConfirmation}
          onSecondary={() => void dismissConfirmed()}
          onCancel={cancelConfirmation}
        />
      ) : null}
    </section>
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
      {loadState === "ready" && assignments.length > 0 ? (
        <SettingsGroup>
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
          ))}
        </SettingsGroup>
      ) : null}
      {status ? <p role="status">{status}</p> : null}
      {saveError ? <p role="alert">{saveError}</p> : null}
    </div>
  );
}
