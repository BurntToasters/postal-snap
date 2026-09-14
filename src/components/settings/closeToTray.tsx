import { strings } from "../../i18n";
import { offersCloseToTray } from "../../settings";

export function CloseToTraySwitch({
  checked,
  onChecked,
}: {
  checked: boolean;
  onChecked: (checked: boolean) => void;
}) {
  if (!offersCloseToTray()) return null;
  const mac = document.documentElement.dataset.platform === "macos";
  return (
    <label className="switch-row">
      <span>
        <strong>
          {mac
            ? strings.settings.closeToTrayMac
            : strings.settings.closeToTrayWindows}
        </strong>
        <small>
          {mac
            ? strings.settings.closeToTrayMacHelp
            : strings.settings.closeToTrayWindowsHelp}
        </small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChecked(event.target.checked)}
      />
    </label>
  );
}
