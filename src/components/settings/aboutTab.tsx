import { api } from "../../api";
import { strings } from "../../i18n";
import { version as appVersion } from "../../../package.json";
import { SettingsPanel } from "./primitives";

async function openAboutLink(url: string) {
  try {
    const check = await api.inspectExternalUrl(url);
    const shownUrl =
      check.url.length > 1400 ? `${check.url.slice(0, 1400)}…` : check.url;

    if (check.reportedThreat) {
      const proceed = await api.showNativeConfirm(
        strings.reader.reportedThreatTitle,
        strings.reader.reportedThreat(check.hostname, shownUrl),
      );
      if (!proceed) return;

      const anyway = await api.showNativeConfirm(
        strings.reader.reportedThreatTitle,
        strings.reader.reportedThreatOpenAnyway,
      );
      if (!anyway) return;
    } else {
      const confirmed = await api.showNativeConfirm(
        strings.appName,
        strings.reader.openLink(check.hostname, shownUrl),
      );
      if (!confirmed) return;
    }

    await api.openExternalUrl(check.url, check.reportedThreat);
  } catch {
    // Native inspection, confirmation, and opening failures are intentionally
    // kept out of settings so URLs and backend details are never surfaced.
  }
}

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
            void openAboutLink("https://github.com/BurntToasters/postal-snap")
          }
        >
          {strings.settings.aboutSource}
        </button>
      </p>
      <p>
        <button
          type="button"
          className="text-button"
          onClick={() => void openAboutLink("https://www.mozilla.org/MPL/2.0/")}
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
