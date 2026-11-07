import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { strings } from "../../i18n";
import { moveMenuFocus } from "../toolbarNav";
import { SearchTips } from "./searchTips";

interface SearchScopeMenuProps {
  allFolders: boolean;
  onSelectAllFolders: (allFolders: boolean) => void;
}

/** Trailing scope menu inside the search capsule; ends with Search tips. */
export function SearchScopeMenu({
  allFolders,
  onSelectAllFolders,
}: SearchScopeMenuProps) {
  const [open, setOpen] = useState(false);
  const [tipsOpen, setTipsOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, right: 8 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const label = allFolders
    ? strings.mail.searchAllFolders
    : strings.mail.searchScopeCurrent;

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({
        top: rect.bottom + 4,
        right: Math.max(8, window.innerWidth - rect.right),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  // Menus portal to body, so outside-click checks cover trigger and menu.
  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLElement>(
        "[role='menuitemradio'][aria-checked='true']",
      )
      ?.focus();
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      )
        return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Tab") return;
      if (event.key === "Escape") {
        event.preventDefault();
        triggerRef.current?.focus();
      }
      setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function choose(all: boolean) {
    setOpen(false);
    if (all !== allFolders) onSelectAllFolders(all);
    triggerRef.current?.focus();
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    moveMenuFocus(event);
  }

  return (
    <>
      <button
        ref={triggerRef}
        className="search-scope"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{label}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              className="search-scope-menu app-menu"
              role="menu"
              aria-label={strings.mail.searchScopeMenu}
              style={{ top: position.top, right: position.right }}
              onKeyDown={onMenuKeyDown}
            >
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!allFolders}
                tabIndex={-1}
                onClick={() => choose(false)}
              >
                {strings.mail.searchScopeCurrent}
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={allFolders}
                tabIndex={-1}
                onClick={() => choose(true)}
              >
                {strings.mail.searchAllFolders}
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  setOpen(false);
                  setTipsOpen(true);
                }}
              >
                {strings.mail.searchTipsMenuItem}
              </button>
            </div>,
            document.body,
          )
        : null}
      <SearchTips
        anchorRef={triggerRef}
        open={tipsOpen}
        onClose={() => setTipsOpen(false)}
      />
    </>
  );
}
