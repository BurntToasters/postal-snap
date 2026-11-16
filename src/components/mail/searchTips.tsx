import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { strings } from "../../i18n";
import { placeAnchoredMenu } from "../popupPlacement";

/**
 * Re-runs place when the window or the toolbar changes size. Toolbar fit
 * drops labels without resizing the window, so the toolbar is observed too.
 */
// Plain helper shared by the search popups; not a component.
// eslint-disable-next-line react-refresh/only-export-components
export function watchAnchorLayout(
  anchor: HTMLElement,
  place: () => void,
): () => void {
  window.addEventListener("resize", place);
  const toolbar = anchor.closest<HTMLElement>(".app-toolbar") ?? anchor;
  const observer =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(place);
  observer?.observe(toolbar);
  return () => {
    window.removeEventListener("resize", place);
    observer?.disconnect();
  };
}

interface SearchTipsProps {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
}

/** Operator cheat sheet, opened from the search scope menu or the local-view button. */
export function SearchTips({ anchorRef, open, onClose }: SearchTipsProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  // Fixed placement beside the anchor, flipped and height-capped by the shared helper.
  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const anchor = anchorRef.current;
    if (!panel || !anchor) return;
    const place = () => placeAnchoredMenu(panel, anchor);
    place();
    return watchAnchorLayout(anchor, place);
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
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
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown, true);
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

/** Search tips for local views (Drafts, Outbox, Snoozed), which have no scope menu. */
export function SearchTipsButton() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={triggerRef}
        className="search-scope"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{strings.mail.searchTips}</span>
      </button>
      <SearchTips
        anchorRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
