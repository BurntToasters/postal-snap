import { strings } from "../../i18n";
import { getShortcutsRegistry } from "../../shortcuts";
import { SettingsPanel } from "./primitives";

export function ShortcutsTab() {
  const items = getShortcutsRegistry();
  return (
    <SettingsPanel id="shortcuts" title={strings.settings.shortcutsTitle}>
      <div className="shortcuts-list">
        {items.map((item) => (
          <div key={item.id} className="shortcut-row">
            <span>{item.label}</span>
            <kbd>{item.keys}</kbd>
          </div>
        ))}
      </div>
    </SettingsPanel>
  );
}
