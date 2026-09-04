import { useEffect, useRef } from "react";

const focusable =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function useDialogFocus(onClose: () => void) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    if (dialog) {
      // React applies autoFocus without leaving an attribute or property
      // behind, so detect it by position: if focus already landed inside
      // the dialog, leave it alone instead of yanking it to the first
      // button (which also clears pending input work like debounces).
      const controls = [...dialog.querySelectorAll<HTMLElement>(focusable)];
      const first =
        controls.find((element) => element.hasAttribute("autofocus")) ??
        controls[0];
      window.setTimeout(() => {
        if (
          document.activeElement &&
          document.activeElement !== document.body &&
          dialog.contains(document.activeElement)
        ) {
          return;
        }
        first?.focus();
      }, 0);
    }

    function onKeyDown(event: KeyboardEvent) {
      const currentDialog = ref.current;
      if (!currentDialog || !document.contains(currentDialog)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = [
        ...currentDialog.querySelectorAll<HTMLElement>(focusable),
      ].filter(
        (item) =>
          !item.hidden &&
          (typeof item.checkVisibility === "function"
            ? item.checkVisibility()
            : item.offsetParent !== null || item.getClientRects().length > 0),
      );
      if (items.length === 0) return;
      const firstItem = items[0];
      const lastItem = items.at(-1)!;
      if (
        event.shiftKey &&
        (document.activeElement === firstItem ||
          !currentDialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        lastItem.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === lastItem ||
          !currentDialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        firstItem.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, []);

  return ref;
}
