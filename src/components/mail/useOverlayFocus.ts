import { useEffect, type RefObject } from "react";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { MEDIA_QUERIES } from "../../breakpoints";
import type { AppSettings, MessageDetail } from "../../types";

// Safari 15.4+ and Chromium 102+ ship `inert`. Older engines still need the
// drawer and reader overlays to be unreachable, so hide them and trap focus.
const INERT_SUPPORTED =
  typeof HTMLElement !== "undefined" && "inert" in HTMLElement.prototype;

const OVERLAY_FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [href], [tabindex]:not([tabindex="-1"]), summary, [contenteditable="true"], audio[controls], video[controls]';

// Same focusability rules as the dialog trap: hidden content never takes Tab.
function visibleOverlayItems(overlay: HTMLElement): HTMLElement[] {
  return [...overlay.querySelectorAll<HTMLElement>(OVERLAY_FOCUSABLE)].filter(
    (item) =>
      !item.hidden &&
      !item.closest("[inert]") &&
      (typeof item.checkVisibility === "function"
        ? item.checkVisibility()
        : item.offsetParent !== null || item.getClientRects().length > 0),
  );
}

/** Keeps Tab inside the overlay when `inert` cannot move the context. */
function trapOverlayFocus(overlay: HTMLElement | null): () => void {
  if (!overlay) return () => undefined;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Tab" || event.defaultPrevented) return;
    const items = visibleOverlayItems(overlay);
    if (items.length === 0) return;
    const firstItem = items[0];
    const lastItem = items.at(-1)!;
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    if (currentIndex >= 0) {
      event.preventDefault();
      items[
        (currentIndex + (event.shiftKey ? -1 : 1) + items.length) % items.length
      ].focus();
      return;
    }
    if (
      event.shiftKey &&
      (document.activeElement === firstItem ||
        !overlay.contains(document.activeElement))
    ) {
      event.preventDefault();
      lastItem.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === lastItem ||
        !overlay.contains(document.activeElement))
    ) {
      event.preventDefault();
      firstItem.focus();
    }
  };
  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}

interface Options {
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  sidebarDrawerViewport: boolean;
  folderPaneRef: RefObject<HTMLElement | null>;
  sidebarToggleRef: RefObject<HTMLButtonElement | null>;
  selectedMessage: MessageDetail | undefined;
  settings: AppSettings;
}

export function useOverlayFocus({
  sidebarOpen,
  setSidebarOpen,
  sidebarDrawerViewport,
  folderPaneRef,
  sidebarToggleRef,
  selectedMessage,
  settings,
}: Options) {
  useEffect(() => {
    if (!sidebarOpen) return;
    const pane = folderPaneRef.current;
    const toggle = sidebarToggleRef.current;
    const previous = document.activeElement as HTMLElement | null;
    const firstFocusable = pane?.querySelector<HTMLElement>(
      "button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
    );
    window.setTimeout(() => firstFocusable?.focus(), 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (previous && document.contains(previous)) previous.focus();
      else toggle?.focus();
    };
  }, [sidebarOpen, setSidebarOpen, folderPaneRef, sidebarToggleRef]);

  useEffect(() => {
    if (!sidebarOpen || !sidebarDrawerViewport) return;
    const shell = document.querySelector(".mail-shell");
    const overlay = folderPaneRef.current;
    const inertTargets = shell
      ? [...shell.children].filter(
          (child) =>
            child !== overlay &&
            !child.classList.contains("sidebar-scrim") &&
            !child.classList.contains("folder-pane"),
        )
      : [];
    if (INERT_SUPPORTED) {
      for (const target of inertTargets) {
        target.setAttribute("inert", "");
      }
      return () => {
        for (const target of inertTargets) {
          target.removeAttribute("inert");
        }
      };
    }
    for (const target of inertTargets) {
      target.setAttribute("aria-hidden", "true");
    }
    const restoreFocusTrap = trapOverlayFocus(overlay ?? null);
    return () => {
      for (const target of inertTargets) {
        target.removeAttribute("aria-hidden");
      }
      restoreFocusTrap();
    };
  }, [sidebarDrawerViewport, sidebarOpen, folderPaneRef]);

  const narrowViewport = useMediaQuery(MEDIA_QUERIES.narrowViewport);
  const readerOverlay =
    Boolean(selectedMessage) &&
    (settings.readingPane === "hidden" || narrowViewport);

  useEffect(() => {
    if (!readerOverlay) return;
    const shell = document.querySelector(".mail-shell");
    if (!shell) return;
    const overlay = document.getElementById("reader-pane");
    const inertTargets = [...shell.children].filter(
      (child) => child.id !== "reader-pane",
    );
    if (INERT_SUPPORTED) {
      for (const target of inertTargets) {
        target.setAttribute("inert", "");
      }
      return () => {
        for (const target of inertTargets) {
          target.removeAttribute("inert");
        }
      };
    }
    for (const target of inertTargets) {
      target.setAttribute("aria-hidden", "true");
    }
    const restoreFocusTrap = trapOverlayFocus(overlay);
    return () => {
      for (const target of inertTargets) {
        target.removeAttribute("aria-hidden");
      }
      restoreFocusTrap();
    };
  }, [readerOverlay]);
}
