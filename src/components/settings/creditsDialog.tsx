import { X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { strings } from "../../i18n";
import type {
  LicenseCredit,
  LicenseCredits,
  LicensePackage,
} from "../../types";
import { inspectAndOpenExternalLink } from "../externalLink";
import { useDialogFocus } from "../useDialogFocus";
import { useInertBackground } from "../useInertBackground";

function httpsRepositoryUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.replace(/^git\+/, ""));
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function PackageCard({ entry }: { entry: LicensePackage }) {
  const repository = httpsRepositoryUrl(entry.repository);
  return (
    <details className="license-card">
      <summary className="license-card-header">
        <strong>{entry.id}</strong>
        <span className="license-card-tag">{entry.licenses}</span>
      </summary>
      <div className="license-card-body">
        {repository ? (
          <p>
            <button
              type="button"
              className="text-button"
              onClick={() => void inspectAndOpenExternalLink(repository)}
            >
              {strings.settings.aboutCreditsOpenSource}
            </button>
          </p>
        ) : null}
        {entry.licenseText ? (
          <pre>{entry.licenseText}</pre>
        ) : (
          <p>{strings.settings.aboutCreditsMissingText(entry.licenses)}</p>
        )}
      </div>
    </details>
  );
}

function NoticeSection({ notice }: { notice: LicenseCredit }) {
  return (
    <details className="license-card" open={notice.id === "mpl"}>
      <summary className="license-card-header">
        <strong>{notice.title}</strong>
      </summary>
      <div className="license-card-body">
        <pre>{notice.body}</pre>
      </div>
    </details>
  );
}

export function CreditsDialog({
  credits,
  onClose,
}: {
  credits: LicenseCredits;
  onClose: () => void;
}) {
  const dialogRef = useDialogFocus(onClose);
  useInertBackground();
  useEffect(() => {
    const settings = document.querySelector<HTMLElement>(".settings-window");
    if (!settings) return;
    const alreadyInert = settings.hasAttribute("inert");
    settings.setAttribute("inert", "");
    return () => {
      if (!alreadyInert) settings.removeAttribute("inert");
    };
  }, []);

  return createPortal(
    <div className="modal-layer license-credits-layer">
      <button
        type="button"
        className="modal-backdrop license-credits-dismiss"
        aria-label={strings.common.close}
        onClick={onClose}
      />
      <section
        className="attachment-preview-dialog license-credits-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="license-credits-title"
        ref={dialogRef}
      >
        <header>
          <div>
            <h2 id="license-credits-title">
              {strings.settings.aboutCreditsTitle}
            </h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label={strings.common.close}
            title={strings.common.close}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="license-credits-body">
          <p>{strings.settings.aboutCreditsLead}</p>
          {credits.notices.map((notice) => (
            <NoticeSection key={notice.id} notice={notice} />
          ))}
          {credits.packages.length > 0 ? (
            <section className="license-package-list">
              <h3>{strings.settings.aboutCreditsPackages}</h3>
              {credits.packages.map((entry) => (
                <PackageCard key={entry.id} entry={entry} />
              ))}
            </section>
          ) : null}
        </div>
      </section>
    </div>,
    document.body,
  );
}
