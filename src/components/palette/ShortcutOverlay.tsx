import { useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { getAction } from "../../actions/registry";
import type { ActionId, ActionScope } from "../../actions/types";
import { strings } from "../../i18n";
import { palette } from "../../i18n/palette";
import { getShortcutsRegistry } from "../../shortcuts";
import { useDialogFocus } from "../useDialogFocus";
import { useInertBackground } from "../useInertBackground";

const SCOPE_ORDER: ActionScope[] = ["global", "list", "reader", "composer"];
const SCOPE_LABELS: Record<ActionScope, string> = {
  global: palette.scopeGlobal,
  list: palette.scopeList,
  reader: palette.scopeReader,
  composer: palette.scopeComposer,
};

export function ShortcutOverlay({ onClose }: { onClose: () => void }) {
  // Captured during render, before the dialog can move focus.
  const [invoker] = useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const dismiss = () => {
    onClose();
    // The dialog restores focus before the inert background clears.
    window.setTimeout(() => invoker?.focus(), 0);
  };
  const dialogRef = useDialogFocus(dismiss);
  useInertBackground();
  const titleId = useId();
  // Same entries as Settings > Shortcuts, grouped by the action's scope.
  const groups = useMemo(() => {
    const items = getShortcutsRegistry();
    return SCOPE_ORDER.map((scope) => ({
      scope,
      items: items.filter(
        (item) => (getAction(item.id as ActionId)?.scope ?? "global") === scope,
      ),
    })).filter((group) => group.items.length > 0);
  }, []);

  return createPortal(
    <div className="modal-layer shortcut-layer">
      <div
        className="modal-backdrop"
        aria-hidden="true"
        onMouseDown={dismiss}
      />
      <section
        className="shortcut-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
      >
        <header className="shortcut-header">
          <h2 id={titleId}>{palette.shortcutsTitle}</h2>
          <button type="button" className="secondary-button" onClick={dismiss}>
            {strings.common.close}
          </button>
        </header>
        <p className="shortcut-intro">{palette.shortcutsIntro}</p>
        {groups.map((group) => (
          <section
            key={group.scope}
            className="shortcut-group"
            aria-labelledby={`${titleId}-${group.scope}`}
          >
            <h3 id={`${titleId}-${group.scope}`}>
              {SCOPE_LABELS[group.scope]}
            </h3>
            <div className="shortcuts-list">
              {group.items.map((item) => (
                <div key={item.id} className="shortcut-row">
                  <span>{item.label}</span>
                  <kbd>{item.keys}</kbd>
                </div>
              ))}
            </div>
          </section>
        ))}
      </section>
    </div>,
    document.body,
  );
}
