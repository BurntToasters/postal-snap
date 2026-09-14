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

function dispatchContextAction(id: string, target: ContextMenuTarget) {
  window.dispatchEvent(
    new CustomEvent<ContextMenuActionDetail>(CONTEXT_ACTION_EVENT, {
      detail: { id, target },
    }),
  );
}

async function runHostAction(id: string, target: ContextMenuTarget) {
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
  if (id === "cut" || id === "copy" || id === "paste" || id === "select-all") {
    document.execCommand(id === "select-all" ? "selectAll" : id);
    return true;
  }
  if ((id === "undo" || id === "redo") && target.kind === "editable") {
    document.execCommand(id);
    return true;
  }
  return false;
}

export function ContextMenuHost() {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setMenu(null), []);

  const openAt = useCallback(
    (x: number, y: number, target: ContextMenuTarget) => {
      const items = itemsForTarget(target);
      if (items.length === 0) {
        setMenu(null);
        return;
      }
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
      openAt(event.clientX, event.clientY, resolveContextTarget(event.target));
    };
    const onIframe = (event: Event) => {
      const detail = (event as CustomEvent<IframeContextMenuDetail>).detail;
      if (!detail) return;
      openAt(detail.x, detail.y, iframeTargetFromDetail(detail));
    };
    document.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener(IFRAME_CONTEXT_EVENT, onIframe);
    return () => {
      document.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener(IFRAME_CONTEXT_EVENT, onIframe);
    };
  }, [openAt]);

  useEffect(() => {
    if (!menu) return;
    const onPointer = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    const onScroll = () => close();
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
              close();
              void runHostAction(id, target).then((handled) => {
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
