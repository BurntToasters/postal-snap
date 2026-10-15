import { useEffect, type RefObject } from "react";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { MEDIA_QUERIES } from "../../breakpoints";
import type { AppSettings, MessageDetail } from "../../types";

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
    const inertTargets = shell
      ? [...shell.children].filter(
          (child) =>
            child !== folderPaneRef.current &&
            !child.classList.contains("sidebar-scrim") &&
            !child.classList.contains("folder-pane"),
        )
      : [];
    for (const target of inertTargets) {
      target.setAttribute("inert", "");
    }
    return () => {
      for (const target of inertTargets) {
        target.removeAttribute("inert");
      }
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
    const inertTargets = [...shell.children].filter(
      (child) => child.id !== "reader-pane",
    );
    for (const target of inertTargets) {
      target.setAttribute("inert", "");
    }
    return () => {
      for (const target of inertTargets) {
        target.removeAttribute("inert");
      }
    };
  }, [readerOverlay]);
}
