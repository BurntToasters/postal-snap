import { useEffect, useRef, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { strings } from "../../i18n";

interface Props {
  busy: boolean;
  syncingAll: boolean;
  onRefreshAll: () => void;
}

/** Extra Get Mail choices; shown only when several accounts exist. */
export function GetMailMenu({ busy, syncingAll, onRefreshAll }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    rootRef.current
      ?.querySelector<HTMLButtonElement>("[role='menuitem']")
      ?.focus();
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", keydown);
    };
  }, [open]);

  return (
    <div className="get-mail-menu-wrap" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="icon-button get-mail-more"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={strings.mail.moreGetMailOptions}
        title={strings.mail.moreGetMailOptions}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="get-mail-menu app-menu"
          role="menu"
          aria-label={strings.mail.moreGetMailOptions}
        >
          <button
            type="button"
            role="menuitem"
            disabled={syncingAll || busy}
            aria-keyshortcuts="Shift+F5"
            onClick={() => {
              setOpen(false);
              triggerRef.current?.focus();
              onRefreshAll();
            }}
          >
            <RefreshCw aria-hidden="true" />
            <span>{strings.mail.getMailAllAccounts}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
