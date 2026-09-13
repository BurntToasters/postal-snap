import { X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { strings } from "../../i18n";
import type { LicenseCredit } from "../../types";
import { useDialogFocus } from "../useDialogFocus";
import { useInertBackground } from "../useInertBackground";

export function CreditsDialog({
  credits,
  onClose,
}: {
  credits: LicenseCredit[];
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
        className="modal-backdrop"
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
          {credits.map((credit) => (
            <section key={credit.id}>
              <h3>{credit.title}</h3>
              <pre>{credit.body}</pre>
            </section>
          ))}
        </div>
      </section>
    </div>,
    document.body,
  );
}
