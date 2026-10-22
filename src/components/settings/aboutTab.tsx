import { useState } from "react";
import { api } from "../../api";
import { strings } from "../../i18n";
import { version as appVersion } from "../../../package.json";
import type { LicenseCredits } from "../../types";
import { inspectAndOpenExternalLink } from "../externalLink";
import { CreditsDialog } from "./creditsDialog";
import { SettingsGroup, SettingsPanel } from "./primitives";

export function AboutTab() {
  const [credits, setCredits] = useState<LicenseCredits | null>(null);
  const [loadingCredits, setLoadingCredits] = useState(false);

  async function openCredits() {
    if (loadingCredits) return;
    setLoadingCredits(true);
    try {
      setCredits(await api.getLicenseCredits());
    } catch {
      setCredits(null);
      await api.showNativeMessage(
        strings.settings.aboutCreditsTitle,
        strings.settings.aboutCreditsError,
      );
    } finally {
      setLoadingCredits(false);
    }
  }

  return (
    <SettingsPanel id="about" title={strings.settings.about}>
      <SettingsGroup>
        <p className="settings-lead">{strings.settings.aboutLead}</p>
        <p>{strings.settings.aboutVersion(appVersion)}</p>
        <button
          type="button"
          className="settings-link-row"
          onClick={() =>
            void inspectAndOpenExternalLink(
              "https://github.com/BurntToasters/postal-snap",
            )
          }
        >
          {strings.settings.aboutSource}
        </button>
        <button
          type="button"
          className="settings-link-row"
          disabled={loadingCredits}
          onClick={() => void openCredits()}
        >
          {strings.settings.aboutLicense}
        </button>
      </SettingsGroup>
      <p className="settings-note">{strings.settings.aboutFilters}</p>
      {credits ? (
        <CreditsDialog credits={credits} onClose={() => setCredits(null)} />
      ) : null}
    </SettingsPanel>
  );
}
