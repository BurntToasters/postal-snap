import { useEffect, useRef } from "react";

const focusable =
  'button, input, select, textarea, iframe, a[href], area[href], [tabindex], summary, [contenteditable]:not([contenteditable="false"]), audio[controls], video[controls]';

function isFocusEligible(item: HTMLElement): boolean {
  const explicitTabIndex = item.getAttribute("tabindex");
  if (
    (explicitTabIndex !== null && item.tabIndex < 0) ||
    (explicitTabIndex === null &&
      item.tabIndex < 0 &&
      !isNaturallyTabbable(item)) ||
    item.matches(":disabled") ||
    item.closest("[hidden], [inert], [aria-hidden='true']")
  ) {
    return false;
  }
  return true;
}

function isSequentiallyFocusable(item: HTMLElement): boolean {
  if (!isFocusEligible(item)) return false;
  return typeof item.checkVisibility === "function"
    ? item.checkVisibility()
    : item.offsetParent !== null || item.getClientRects().length > 0;
}

function hasLayoutGeometry(dialog: HTMLElement): boolean {
  return (
    typeof dialog.checkVisibility === "function" ||
    dialog.getClientRects().length > 0 ||
    document.documentElement.getClientRects().length > 0
  );
}

function isNaturallyTabbable(item: HTMLElement): boolean {
  if (item.isContentEditable) {
    return !item.parentElement?.isContentEditable;
  }
  if (item.matches("iframe, audio[controls], video[controls]")) return true;
  if (item.matches("summary") && item.parentElement?.matches("details")) {
    return (
      Array.from(item.parentElement.children).find(
        (child) => child.localName === "summary",
      ) === item
    );
  }
  return false;
}

export function useDialogFocus(
  onClose: () => void,
  options?: { trapFocus?: boolean },
) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  const trapFocus = options?.trapFocus ?? true;

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    if (dialog) {
      if (trapFocus) dialog.setAttribute("data-dialog-focus-trap", "");
      // React applies autoFocus without leaving an attribute or property
      // behind, so detect it by position: if focus already landed inside
      // the dialog, leave it alone instead of yanking it to the first
      // button (which also clears pending input work like debounces).
      const eligibleControls = [
        ...dialog.querySelectorAll<HTMLElement>(focusable),
      ].filter(isFocusEligible);
      const visibleControls = eligibleControls.filter(isSequentiallyFocusable);
      const controls =
        visibleControls.length > 0
          ? visibleControls
          : hasLayoutGeometry(dialog)
            ? []
            : eligibleControls;
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
      if (
        currentDialog.hasAttribute("inert") ||
        currentDialog.closest("[inert]")
      ) {
        return;
      }
      const activeTrap =
        document.activeElement instanceof Element
          ? document.activeElement.closest<HTMLElement>(
              "[data-dialog-focus-trap]",
            )
          : null;
      if (activeTrap && activeTrap !== currentDialog) return;
      if (event.key === "Escape") {
        if (event.defaultPrevented) return;
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !trapFocus || event.defaultPrevented) return;
      const items = [
        ...currentDialog.querySelectorAll<HTMLElement>(focusable),
        ...document.querySelectorAll<HTMLElement>(
          ".global-window-caption-controls button",
        ),
      ].filter(isSequentiallyFocusable);
      if (items.length === 0) return;
      const firstItem = items[0];
      const lastItem = items.at(-1)!;
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      // Include the real window controls without leaking focus into inert mail.
      // Explicit traversal also handles the caption controls' separate DOM root.
      if (currentIndex >= 0) {
        event.preventDefault();
        items[
          (currentIndex + (event.shiftKey ? -1 : 1) + items.length) %
            items.length
        ].focus();
        return;
      }
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
      if (trapFocus) dialog?.removeAttribute("data-dialog-focus-trap");
      previous?.focus();
    };
  }, [trapFocus]);

  return ref;
}
