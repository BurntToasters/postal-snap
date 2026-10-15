import { useEffect, useRef, type RefObject } from "react";

const ITEMS =
  "[role='menuitem']:not(:disabled), [role='menuitemradio']:not(:disabled)";

// Focus on open, outside click closes, Escape/Tab close. Escape returns
// focus to the trigger button inside rootRef.
export function usePopupMenu(
  open: boolean,
  rootRef: RefObject<HTMLElement | null>,
  onClose: (restoreFocus: boolean) => void,
) {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const trigger = root?.querySelector<HTMLElement>(
      "button[aria-haspopup='menu']",
    );
    const checked = root?.querySelector<HTMLElement>(
      "[role='menuitemradio'][aria-checked='true']:not(:disabled)",
    );
    (checked ?? root?.querySelector<HTMLElement>(ITEMS))?.focus();
    const onMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        close.current(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Tab") return;
      if (event.key === "Escape") event.preventDefault();
      close.current(event.key === "Escape");
      if (event.key === "Escape") trigger?.focus();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, rootRef]);
}
