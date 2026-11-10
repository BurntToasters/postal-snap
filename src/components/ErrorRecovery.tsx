import type { ReactNode, RefObject } from "react";
import { strings } from "../i18n";
import { useDialogFocus } from "./useDialogFocus";
import { useInertBackground } from "./useInertBackground";

interface RecoveryContentProps {
  help?: string;
  retrying: boolean;
  retryFailed: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onTryAgain: () => void;
  onReload: () => void;
  onClose?: () => void;
}

export function RecoveryContent({
  help,
  retrying,
  retryFailed,
  headingRef,
  onTryAgain,
  onReload,
  onClose,
}: RecoveryContentProps) {
  return (
    <>
      <h2 ref={headingRef} tabIndex={-1}>
        {strings.app.crashTitle}
      </h2>
      <p>{help ?? strings.app.crashHelp}</p>
      {retryFailed ? <p role="status">{strings.app.crashRetryFailed}</p> : null}
      <div className="crash-recovery-actions">
        <button
          type="button"
          className="primary-button"
          disabled={retrying}
          onClick={onTryAgain}
        >
          {strings.app.crashTryAgain}
        </button>
        <button type="button" className="secondary-button" onClick={onReload}>
          {strings.app.crashReload}
        </button>
        {onClose ? (
          <button type="button" className="secondary-button" onClick={onClose}>
            {strings.app.crashClose}
          </button>
        ) : null}
      </div>
    </>
  );
}

export function ModalRecoveryFallback({
  className,
  retrying,
  children,
  onClose,
}: {
  className: string;
  retrying: boolean;
  children: ReactNode;
  onClose?: () => void;
}) {
  const dialogRef = useDialogFocus(onClose ?? (() => undefined));
  useInertBackground();
  return (
    <div
      ref={dialogRef as unknown as RefObject<HTMLDivElement | null>}
      className={className}
      role="dialog"
      aria-modal="true"
      aria-label={strings.app.crashTitle}
      aria-busy={retrying || undefined}
    >
      {children}
    </div>
  );
}
