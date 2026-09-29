import { useId, type KeyboardEvent } from "react";

export interface ConfirmDialogProps {
  title: string;
  detail: string;
  /** Focused first; the safe or recommended choice. */
  primaryLabel: string;
  secondaryLabel: string;
  onPrimary: () => void;
  onSecondary: () => void;
  /** Escape or a backdrop click. */
  onCancel: () => void;
}

const focusable = "button:not([disabled])";

/** Modal confirm inside the composer. Traps Tab; Escape cancels. */
export function ConfirmDialog({
  title,
  detail,
  primaryLabel,
  secondaryLabel,
  onPrimary,
  onSecondary,
  onCancel,
}: ConfirmDialogProps) {
  const id = useId();

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(focusable),
    ];
    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = document.activeElement;
    if (
      event.shiftKey &&
      (active === first || !controls.includes(active as HTMLElement))
    ) {
      event.preventDefault();
      last?.focus();
    } else if (
      !event.shiftKey &&
      (active === last || !controls.includes(active as HTMLElement))
    ) {
      event.preventDefault();
      first?.focus();
    }
    // The composer-wide trap listens on document; keep Tab in this dialog.
    event.stopPropagation();
  }

  return (
    <div
      className="settings-confirm-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="settings-confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-detail`}
        onKeyDown={onKeyDown}
      >
        <h2 id={`${id}-title`}>{title}</h2>
        <p id={`${id}-detail`}>{detail}</p>
        <div className="settings-confirm-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={onSecondary}
          >
            {secondaryLabel}
          </button>
          <button
            className="primary-button"
            type="button"
            autoFocus
            onClick={onPrimary}
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
