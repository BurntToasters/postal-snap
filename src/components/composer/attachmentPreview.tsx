import { useEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { strings } from "../../i18n";

export interface AttachmentPreviewProps {
  preview: { filename: string; src: string };
  onClose: () => void;
  /** The control that opened the preview; focus returns to it on close. */
  triggerRef: RefObject<HTMLElement | null>;
}

/** Modal picture preview. It owns focus and Escape until it closes. */
export function AttachmentPreview({
  preview,
  onClose,
  triggerRef,
}: AttachmentPreviewProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const trigger = triggerRef.current;
    closeRef.current?.focus();
    // Capture phase: the composer's own Escape and Tab handling never sees these keys.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      // Close is the only control, so Tab and Shift+Tab stay on it.
      event.preventDefault();
      event.stopPropagation();
      closeRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (trigger?.isConnected) trigger.focus();
    };
  }, [triggerRef]);

  // Body-level, so the composer's inert layer cannot cover or disable it.
  return createPortal(
    <div
      className="compose-preview-layer"
      role="presentation"
      onMouseDown={() => onClose()}
    >
      <div
        className="settings-confirm-card compose-image-preview"
        role="dialog"
        aria-modal="true"
        aria-label={preview.filename}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <img src={preview.src} alt={preview.filename} />
        <div className="settings-confirm-actions">
          <button
            ref={closeRef}
            type="button"
            className="toolbar-button"
            onClick={() => onClose()}
          >
            {strings.common.close}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
