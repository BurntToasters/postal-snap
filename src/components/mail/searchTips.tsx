import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { strings } from "../../i18n";

interface SearchTipsProps {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
}

/** Operator cheat sheet, opened from the search scope menu. */
export function SearchTips({ anchorRef, open, onClose }: SearchTipsProps) {
  const [position, setPosition] = useState({ top: 0, right: 8 });
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({
        top: rect.bottom + 8,
        right: Math.max(8, window.innerWidth - rect.right),
      });
    };
    place();
    panelRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        panelRef.current?.contains(target) ||
        anchorRef.current?.contains(target)
      )
        return;
      close.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close.current();
      anchorRef.current?.focus();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", place);
    };
  }, [open, anchorRef]);

  if (!open) return null;
  return createPortal(
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
          close.current();
          anchorRef.current?.focus();
        }}
      >
        {strings.mail.searchTipsClose}
      </button>
    </div>,
    document.body,
  );
}
