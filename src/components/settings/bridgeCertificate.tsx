import { useState } from "react";
import { api } from "../../api";
import { strings } from "../../i18n";
import type { BridgeCertificate } from "../../types";

export function BridgeCertificateControl({
  accountId,
  current,
  onApproved,
}: {
  accountId?: string;
  current?: BridgeCertificate | null;
  onApproved: (reference?: string) => void;
}) {
  const [pending, setPending] = useState<BridgeCertificate | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  async function importCertificate() {
    setBusy(true);
    setStatus("");
    try {
      setPending(await api.importBridgeCertificate());
    } catch (cause) {
      setStatus(String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function approve() {
    if (!pending || busy) return;
    setBusy(true);
    try {
      if (
        !(await api.showNativeConfirm(
          strings.settings.approveCertificate,
          strings.settings.certificateConfirm,
        ))
      )
        return;
      const reference = await api.approveBridgeCertificate(
        pending.reference,
        accountId,
      );
      onApproved(reference);
      setPending(null);
      setStatus(strings.settings.certificateApproved);
    } catch (cause) {
      setStatus(String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!accountId || busy) return;
    setBusy(true);
    try {
      if (
        !(await api.showNativeConfirm(
          strings.settings.removeCertificate,
          strings.settings.certificateConfirm,
        ))
      )
        return;
      await api.removeBridgeCertificate(accountId);
      onApproved(undefined);
      setStatus("");
    } catch (cause) {
      setStatus(String(cause));
    } finally {
      setBusy(false);
    }
  }
  const certificate = pending ?? current;
  return (
    <section className="bridge-certificate-control">
      <p className="settings-note">{strings.setup.bridgeCertificateHint}</p>
      {certificate ? (
        <dl className="certificate-details">
          <dt>{strings.settings.certificateFingerprint}</dt>
          <dd>{certificate.fingerprint}</dd>
          <dt>{strings.settings.certificateExpiry}</dt>
          <dd>{new Date(certificate.expiresAt).toLocaleString()}</dd>
        </dl>
      ) : null}
      <div className="settings-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => void importCertificate()}
        >
          {strings.settings.importCertificate}
        </button>
        {pending ? (
          <>
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void approve()}
            >
              {strings.settings.approveCertificate}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              {strings.common.cancel}
            </button>
          </>
        ) : null}
        {current && accountId ? (
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void remove()}
          >
            {strings.settings.removeCertificate}
          </button>
        ) : null}
      </div>
      {status ? <p role="status">{status}</p> : null}
    </section>
  );
}
