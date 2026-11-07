import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, type LucideIcon } from "lucide-react";
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
import { iconFor } from "./menuIcons";
import { parseMailto } from "../mailto";
import { useAppStore } from "../store";
import { placeSubmenuPanel, syncScrollCue } from "./popupPlacement";
import { moveMenuFocus } from "./toolbarNav";

type MenuActionItem = Extract<ContextMenuItem, { type: "item" }>;

/** Render model shared by the row menu, reader More, and mailbox More. */
export type PopupEntry =
  | { kind: "separator" }
  | { kind: "group"; label: string; entries: PopupEntry[] }
  | {
      kind: "action";
      id: string;
      label: string;
      icon?: LucideIcon;
      ariaLabel?: string;
      chord?: string;
      disabled?: boolean;
      danger?: boolean;
      role?: "menuitem" | "menuitemradio" | "menuitemcheckbox";
      checked?: boolean;
      onSelect: () => void;
    }
  | {
      kind: "submenu";
      id: string;
      label: string;
      icon?: LucideIcon;
      disabled?: boolean;
      entries: PopupEntry[];
    };

const ITEM_SELECTOR =
  '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)';

/** Headings own the items after them, up to the next separator. */
function toPopupEntries(
  items: ContextMenuItem[],
  onSelect: (entry: MenuActionItem) => () => void,
): PopupEntry[] {
  const entries: PopupEntry[] = [];
  let group: Extract<PopupEntry, { kind: "group" }> | null = null;
  for (const entry of items) {
    if (entry.type === "heading") {
      group = { kind: "group", label: entry.label, entries: [] };
      entries.push(group);
      continue;
    }
    if (entry.type === "separator") {
      group = null;
      entries.push({ kind: "separator" });
      continue;
    }
    const converted: PopupEntry =
      entry.type === "submenu"
        ? {
            kind: "submenu",
            id: entry.id,
            label: entry.label,
            icon: iconFor(entry.icon),
            entries: toPopupEntries(entry.items, onSelect),
          }
        : {
            kind: "action",
            id: entry.id,
            label: entry.label,
            icon: iconFor(entry.icon),
            ariaLabel: entry.ariaLabel,
            chord: entry.chord,
            disabled: entry.disabled,
            danger: entry.danger,
            onSelect: onSelect(entry),
          };
    (group ? group.entries : entries).push(converted);
  }
  return entries;
}

function PopupGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <div role="group" aria-labelledby={headingId}>
      <div id={headingId} className="context-menu-heading">
        {label}
      </div>
      {children}
    </div>
  );
}

function PopupActionRow({
  entry,
}: {
  entry: Extract<PopupEntry, { kind: "action" }>;
}) {
  const checkable =
    entry.role === "menuitemradio" || entry.role === "menuitemcheckbox";
  const Icon = entry.icon ?? (checkable && entry.checked ? Check : undefined);
  return (
    <button
      type="button"
      role={entry.role ?? "menuitem"}
      aria-checked={checkable ? entry.checked : undefined}
      disabled={entry.disabled}
      aria-label={entry.ariaLabel}
      className={entry.danger ? "danger" : undefined}
      onClick={entry.onSelect}
    >
      <span className="context-menu-icon" aria-hidden="true">
        {Icon ? <Icon /> : null}
      </span>
      <span className="context-menu-label">{entry.label}</span>
      {entry.chord ? <kbd aria-hidden="true">{entry.chord}</kbd> : null}
    </button>
  );
}

/** A submenu opens on hover, ArrowRight, Enter, or Space; ArrowLeft or Escape closes it. */
function PopupSubmenu({
  entry,
}: {
  entry: Extract<PopupEntry, { kind: "submenu" }>;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusFirstRef = useRef(false);
  const panelId = useId();
  const closeTimer = useRef<number | undefined>(undefined);
  const Icon = entry.icon;

  // Leaving the row closes after a short grace period, so the pointer can
  // cross the gap into the panel.
  const cancelClose = () => window.clearTimeout(closeTimer.current);
  useEffect(() => cancelClose, []);

  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    if (!panel || !trigger) return;
    placeSubmenuPanel(panel, trigger);
    if (focusFirstRef.current) {
      focusFirstRef.current = false;
      panel.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus();
    }
  }, [open]);

  function openFromKeyboard() {
    focusFirstRef.current = true;
    setOpen(true);
    const panel = panelRef.current;
    if (panel) {
      focusFirstRef.current = false;
      panel.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus();
    }
  }

  return (
    <div
      className="popup-submenu"
      onMouseEnter={() => {
        cancelClose();
        if (!entry.disabled) setOpen(true);
      }}
      onMouseLeave={() => {
        cancelClose();
        closeTimer.current = window.setTimeout(() => setOpen(false), 250);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        className="popup-submenu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        disabled={entry.disabled}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault();
            event.stopPropagation();
            openFromKeyboard();
          } else if (event.key === "Enter" || event.key === " ") {
            focusFirstRef.current = true;
          }
        }}
      >
        <span className="context-menu-icon" aria-hidden="true">
          {Icon ? <Icon /> : null}
        </span>
        <span className="context-menu-label">{entry.label}</span>
        <ChevronRight className="popup-submenu-chevron" aria-hidden="true" />
      </button>
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          className="app-menu popup-submenu-panel"
          role="menu"
          aria-label={entry.label}
          onScroll={(event) => syncScrollCue(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              triggerRef.current?.focus();
              return;
            }
            moveMenuFocus(event);
          }}
        >
          <PopupEntries entries={entry.entries} />
        </div>
      ) : null}
    </div>
  );
}

/** Renders popup entries; submenus and groups nest inside the same menu. */
export function PopupEntries({ entries }: { entries: PopupEntry[] }) {
  return (
    <>
      {entries.map((entry, index) => {
        if (entry.kind === "separator") {
          return (
            <div
              key={`sep-${index}`}
              className="context-menu-separator"
              role="separator"
            />
          );
        }
        if (entry.kind === "group") {
          return (
            <PopupGroup key={`group-${index}`} label={entry.label}>
              <PopupEntries entries={entry.entries} />
            </PopupGroup>
          );
        }
        if (entry.kind === "submenu") {
          return <PopupSubmenu key={`sub-${entry.id}`} entry={entry} />;
        }
        return <PopupActionRow key={entry.id} entry={entry} />;
      })}
    </>
  );
}

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
    void inspectAndOpenExternalLink(target.href, target.text);
    return true;
  }
  if (id === "open" && target.kind === "mailto") {
    useAppStore.getState().openComposer({ prefill: parseMailto(target.href) });
    return true;
  }
  if (id === "copy" && target.kind === "reader") return false;
  if (id === "paste-plain") {
    restoreEditSelection(savedEdit);
    return false;
  }
  if (id === "paste") {
    restoreEditSelection(savedEdit);
    // WebView2 and WebKit usually refuse execCommand("paste") from page
    // script; fall back to the async clipboard and insert the text.
    if (document.execCommand("paste")) return true;
    const text = await navigator.clipboard.readText().catch(() => "");
    if (text) {
      restoreEditSelection(savedEdit);
      document.execCommand("insertText", false, text);
    }
    return true;
  }
  if (id === "cut" || id === "copy") {
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
  // Scroll offsets of the opener's ancestors when the menu opened.
  const openingScrollsRef = useRef<
    Array<{ element: Element; top: number; left: number }>
  >([]);

  const close = useCallback(() => {
    savedEditRef.current = null;
    setMenu(null);
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener && document.contains(opener)) opener.focus();
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
      const scrolls: typeof openingScrollsRef.current = [];
      for (
        let node = openerRef.current?.parentElement;
        node;
        node = node.parentElement
      ) {
        scrolls.push({
          element: node,
          top: node.scrollTop,
          left: node.scrollLeft,
        });
      }
      openingScrollsRef.current = scrolls;
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
      // Return focus to the message body once the menu closes.
      openerRef.current = document.querySelector<HTMLElement>(
        ".message-body iframe",
      );
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
      // Submenus handle their own Escape and ArrowLeft.
      if (
        event.key === "Escape" &&
        event.target instanceof Element &&
        event.target.closest(".popup-submenu-panel")
      ) {
        return;
      }
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        close();
      }
    };
    // A stale position after resize, or a menu left behind when the window
    // loses focus, reads as a stuck popup.
    const onDismiss = () => close();
    const onScroll = (event: Event) => {
      if (
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      ) {
        return;
      }
      // Ignore a queued pre-open scroll with unchanged ancestor offsets.
      const openingScroll = openingScrollsRef.current.find(
        (entry) => entry.element === event.target,
      );
      if (
        openingScroll &&
        openingScroll.element.scrollTop === openingScroll.top &&
        openingScroll.element.scrollLeft === openingScroll.left
      ) {
        return;
      }
      close();
    };
    window.addEventListener("mousedown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("blur", onDismiss);
    return () => {
      window.removeEventListener("mousedown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("blur", onDismiss);
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
  const openMenu = menu;

  const entries = toPopupEntries(openMenu.items, (entry) => () => {
    const { id, target } = { id: entry.id, target: openMenu.target };
    const savedEdit = savedEditRef.current;
    close();
    void runHostAction(id, target, savedEdit).then((handled) => {
      if (!handled) dispatchContextAction(id, target);
    });
  });

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu app-menu"
      role="menu"
      aria-label={strings.contextMenu.menu}
      style={{ left: menu.x, top: menu.y }}
      onKeyDown={moveMenuFocus}
      onScroll={(event) => syncScrollCue(event.currentTarget)}
    >
      <PopupEntries entries={entries} />
    </div>,
    document.body,
  );
}
