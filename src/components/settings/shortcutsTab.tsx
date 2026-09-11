import { strings } from "../../i18n";
import { shortcutAltMod, shortcutMod, shortcutShiftMod } from "../../format";
import { SettingsPanel } from "./primitives";

export function ShortcutsTab() {
  return (
    <SettingsPanel id="shortcuts" title={strings.settings.shortcutsTitle}>
      <div className="shortcuts-list">
        <div className="shortcut-row">
          <span>{strings.composer.newMessage}</span>
          <kbd>{`${shortcutMod()} N`}</kbd>
        </div>
        <div className="shortcut-row">
          <span>{strings.mail.getMail}</span>
          <kbd>{`${shortcutShiftMod()} N`}</kbd>
        </div>
        <div className="shortcut-row">
          <span>{strings.reader.reply}</span>
          <kbd>{`${shortcutMod()} R`}</kbd>
        </div>
        <div className="shortcut-row">
          <span>{strings.reader.replyAll}</span>
          <kbd>{`${shortcutShiftMod()} R`}</kbd>
        </div>
        <div className="shortcut-row">
          <span>{strings.reader.forward}</span>
          <kbd>{`${shortcutShiftMod()} F`}</kbd>
        </div>
        <div className="shortcut-row">
          <span>{strings.reader.archive}</span>
          <kbd>{`${shortcutMod()} E`}</kbd>
        </div>
        <div className="shortcut-row">
          <span>{strings.reader.trash}</span>
          <kbd>{`${shortcutMod()} ⌫`}</kbd>
        </div>
        <div className="shortcut-row">
          <span>{strings.mail.search}</span>
          <kbd>{`${shortcutMod()} F / /`}</kbd>
        </div>
        <div className="shortcut-row">
          <span>{strings.reader.findInMessage}</span>
          <kbd>{`${shortcutAltMod()} F`}</kbd>
        </div>
        <div className="shortcut-row">
          <span>{strings.composer.send}</span>
          <kbd>{`${shortcutMod()} ↵`}</kbd>
        </div>
        <div className="shortcut-row">
          <span>{strings.composer.saveDraft}</span>
          <kbd>{`${shortcutMod()} S`}</kbd>
        </div>
        <div className="shortcut-row">
          <span>{strings.settings.textSize}</span>
          <kbd>{`${shortcutMod()} + / ${shortcutMod()} -`}</kbd>
        </div>
        <div className="shortcut-row">
          <span>{strings.mail.settings}</span>
          <kbd>{`${shortcutMod()} ,`}</kbd>
        </div>
      </div>
    </SettingsPanel>
  );
}
