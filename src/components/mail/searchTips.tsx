import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleHelp } from "lucide-react";
import { strings } from "../../i18n";

/** Operator cheat sheet. Escape or an outside click closes it. */
export function SearchTips() {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, right: 8 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({
        top: rect.bottom + 8,
        right: Math.max(8, window.innerWidth - rect.right),
      });
    };
    place();
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        panelRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      )
        return;
      setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", keydown, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", keydown, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="search-tips-button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={strings.mail.searchTips}
        title={strings.mail.searchTips}
        onClick={() => setOpen((value) => !value)}
      >
        <CircleHelp aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              className="search-tips-panel"
              role="region"
              aria-label={strings.mail.searchTipsTitle}
              style={{ top: position.top, right: position.right }}
            >
              <strong>{strings.mail.searchTipsTitle}</strong>
              <p>{strings.mail.searchTipsIntro}</p>
              <dl>
                {strings.mail.searchTipsItems.map((item) => (
                  <div key={item.syntax}>
                    <dt>
                      <code>{item.syntax}</code>
                    </dt>
                    <dd>{item.meaning}</dd>
                  </div>
                ))}
              </dl>
              <button
                type="button"
                className="search-tips-close"
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                {strings.mail.searchTipsClose}
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
