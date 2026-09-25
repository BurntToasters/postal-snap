import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  CONTEXT_ACTION_EVENT,
  CONTEXT_DISMISS_EVENT,
  IFRAME_CONTEXT_EVENT,
  iframeTargetFromDetail,
  itemsForTarget,
  resolveContextTarget,
  type ContextMenuActionDetail,
  type ContextMenuItem,
  type ContextMenuTarget,
  type IframeContextMenuDetail,
} from "../contextMenu";
import { inspectAndOpenExternalLink } from "./externalLink";
import { strings } from "../i18n";
import { parseMailto } from "../mailto";
import { useAppStore } from "../store";
import { moveMenuFocus } from "./toolbarNav";

interface OpenMenu {
  x: number;
  y: number;
  target: ContextMenuTarget;
  items: ContextMenuItem[];
}

interface SavedFieldSelection {
  field: HTMLInputElement | HTMLTextAreaElement;
  start: number;
  end: number;
}

interface SavedDomSelection {
  ranges: Range[];
  editable: HTMLElement | null;
}

type SavedEditSelection = SavedFieldSelection | SavedDomSelection;

function snapshotEditSelection(
  start: EventTarget | null,
): SavedEditSelection | null {
  const field =
    start instanceof HTMLInputElement || start instanceof HTMLTextAreaElement
      ? start
      : start instanceof Element
        ? start.closest("input, textarea")
        : null;
  if (
    field instanceof HTMLInputElement ||
    field instanceof HTMLTextAreaElement
  ) {
    return {
      field,
      start: field.selectionStart ?? 0,
      end: field.selectionEnd ?? 0,
    };
  }
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const ranges = Array.from({ length: selection.rangeCount }, (_, index) =>
    selection.getRangeAt(index).cloneRange(),
  );
  const node = ranges[0]?.startContainer;
  const element =
    node instanceof Element ? node : (node?.parentElement ?? null);
  return {
    ranges,
    editable: element?.closest<HTMLElement>("[contenteditable='true']") ?? null,
  };
}

function restoreEditSelection(saved: SavedEditSelection | null): boolean {
  if (!saved) return false;
  if ("field" in saved) {
    saved.field.focus();
    try {
      saved.field.setSelectionRange(saved.start, saved.end);
    } catch {
      // Some input types reject setSelectionRange.
    }
    return true;
  }
  saved.editable?.focus();
  const selection = document.getSelection();
  if (!selection) return false;
  selection.removeAllRanges();
  for (const range of saved.ranges) {
    try {
      selection.addRange(range);
    } catch {
      return false;
    }
  }
  return selection.rangeCount > 0;
}

function dispatchContextAction(id: string, target: ContextMenuTarget) {
  window.dispatchEvent(
    new CustomEvent<ContextMenuActionDetail>(CONTEXT_ACTION_EVENT, {
      detail: { id, target },
    }),
  );
}

async function runHostAction(
  id: string,
  target: ContextMenuTarget,
  savedEdit: SavedEditSelection | null,
) {
  if (id === "copy-link" && target.kind === "link") {
    await navigator.clipboard.writeText(target.href).catch(() => undefined);
    return true;
  }
  if (id === "copy-address") {
    const value =
      target.kind === "address"
        ? target.address
        : target.kind === "mailto"
          ? target.href.replace(/^mailto:/i, "").split("?")[0]
          : "";
    if (value) {
      await navigator.clipboard.writeText(value).catch(() => undefined);
    }
    return true;
  }
  if (id === "open-link" && target.kind === "link") {
    void inspectAndOpenExternalLink(target.href);
    return true;
  }
  if (id === "open" && target.kind === "mailto") {
    useAppStore.getState().openComposer({ prefill: parseMailto(target.href) });
    return true;
  }
  if (id === "copy" && target.kind === "reader") return false;
  if (id === "cut" || id === "copy" || id === "paste") {
    restoreEditSelection(savedEdit);
    document.execCommand(id);
    return true;
  }
  if (id === "select-all") {
    if (target.kind === "composer") return false;
    restoreEditSelection(savedEdit);
    if (savedEdit && "field" in savedEdit) {
      savedEdit.field.select();
      return true;
    }
    document.execCommand("selectAll");
    return true;
  }
  if ((id === "undo" || id === "redo") && target.kind === "editable") {
    restoreEditSelection(savedEdit);
    document.execCommand(id);
    return true;
  }
  return false;
}

export function ContextMenuHost() {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const savedEditRef = useRef<SavedEditSelection | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    savedEditRef.current = null;
    setMenu(null);
    if (openerRef.current && document.contains(openerRef.current)) {
      openerRef.current.focus();
      openerRef.current = null;
    }
  }, []);

  const openAt = useCallback(
    (
      x: number,
      y: number,
      target: ContextMenuTarget,
      savedEdit: SavedEditSelection | null = null,
    ) => {
      const items = itemsForTarget(target);
      if (items.length === 0) {
        savedEditRef.current = null;
        setMenu(null);
        return;
      }
      savedEditRef.current = savedEdit;
      setMenu({ x, y, target, items });
    },
    [],
  );

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (
        event.target instanceof Element &&
        event.target.closest(".context-menu")
      ) {
        return;
      }
      openerRef.current =
        event.target instanceof HTMLElement ? event.target : null;
      openAt(
        event.clientX,
        event.clientY,
        resolveContextTarget(event.target),
        snapshotEditSelection(event.target),
      );
    };
    const onIframe = (event: Event) => {
      const detail = (event as CustomEvent<IframeContextMenuDetail>).detail;
      if (!detail) return;
      openAt(detail.x, detail.y, iframeTargetFromDetail(detail), null);
    };
    const onKeyOpen = (event: KeyboardEvent) => {
      if (
        event.key === "ContextMenu" ||
        (event.shiftKey && (event.key === "F10" || event.key === "f10"))
      ) {
        const active = document.activeElement as HTMLElement | null;
        if (!active || active.closest(".context-menu")) return;
        event.preventDefault();
        const rect = active.getBoundingClientRect();
        openerRef.current = active;
        openAt(
          rect.left + rect.width / 2,
          rect.bottom,
          resolveContextTarget(active),
          snapshotEditSelection(active),
        );
      }
    };
    const onDismiss = () => close();
    document.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("keydown", onKeyOpen, true);
    window.addEventListener(IFRAME_CONTEXT_EVENT, onIframe);
    window.addEventListener(CONTEXT_DISMISS_EVENT, onDismiss);
    return () => {
      document.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("keydown", onKeyOpen, true);
      window.removeEventListener(IFRAME_CONTEXT_EVENT, onIframe);
      window.removeEventListener(CONTEXT_DISMISS_EVENT, onDismiss);
    };
  }, [close, openAt]);

  useEffect(() => {
    if (!menu) return;
    const onPointer = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      ) {
        return;
      }
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    const onScroll = (event: Event) => {
      if (
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      ) {
        return;
      }
      close();
    };
    window.addEventListener("mousedown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [close, menu]);

  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!node || !menu) return;
    const pad = 8;
    const rect = node.getBoundingClientRect();
    let left = menu.x;
    let top = menu.y;
    if (left + rect.width > window.innerWidth - pad) {
      left = Math.max(pad, menu.x - rect.width);
    }
    if (top + rect.height > window.innerHeight - pad) {
      top = Math.max(pad, menu.y - rect.height);
    }
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    node
      .querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
  }, [menu]);

  if (!menu) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label={strings.contextMenu.menu}
      style={{ left: menu.x, top: menu.y }}
      onKeyDown={moveMenuFocus}
    >
      {menu.items.map((entry, index) =>
        entry.type === "separator" ? (
          <div
            key={`sep-${index}`}
            className="context-menu-separator"
            role="separator"
          />
        ) : (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            className={entry.danger ? "danger" : undefined}
            onClick={() => {
              const { id, target } = { id: entry.id, target: menu.target };
              const savedEdit = savedEditRef.current;
              close();
              void runHostAction(id, target, savedEdit).then((handled) => {
                if (!handled) dispatchContextAction(id, target);
              });
            }}
          >
            {entry.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
