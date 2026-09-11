import { api } from "../../api";
import { strings } from "../../i18n";
import { version as appVersion } from "../../../package.json";
import { SettingsPanel } from "./primitives";

export function AboutTab() {
  return (
    <SettingsPanel id="about" title={strings.settings.about}>
      <p className="settings-lead">{strings.settings.aboutLead}</p>
      <p>{strings.settings.aboutVersion(appVersion)}</p>
      <p>
        <button
          type="button"
          className="text-button"
          onClick={() =>
            void api.openExternalUrl(
              "https://github.com/BurntToasters/postal-snap",
            )
          }
        >
          {strings.settings.aboutSource}
        </button>
      </p>
      <p>
        <button
          type="button"
          className="text-button"
          onClick={() =>
            void api.openExternalUrl("https://www.mozilla.org/MPL/2.0/")
          }
        >
          {strings.settings.aboutLicense}
        </button>
      </p>
      <p>
        <small>{strings.settings.aboutFilters}</small>
      </p>
    </SettingsPanel>
  );
}
