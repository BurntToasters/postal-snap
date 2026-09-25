import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { strings } from "../../i18n";
import { roleLabels } from "../../i18n/mail";
import { useAppStore } from "../../store";
import type { AppSettings, SetupStep } from "../../types";
import { SetupWizard } from "../SetupWizard";
import { DisplayOptions } from "../setup/displayOptions";
import { CloseToTraySwitch } from "../settings/closeToTray";

export type SetupGo = (next: SetupStep) => void;
export type SetupPersist = (patch: Partial<AppSettings>) => Promise<void>;

interface WelcomeStepProps {
  go: SetupGo;
  onOpenSettings?: () => void;
}

export function WelcomeStep({ go, onOpenSettings }: WelcomeStepProps) {
  return (
    <div className="setup-step">
      <p className="setup-intro">{strings.setup.welcomeIntro}</p>
      <p className="setup-intro">{strings.setup.welcomeComfort}</p>
      <div className="privacy-note">
        <ShieldCheck aria-hidden="true" />
        <span>{strings.setup.privacy}</span>
      </div>
      <div className="setup-actions">
        <button
          type="button"
          className="primary-button full-button"
          onClick={() => go("appearance")}
        >
          {strings.setup.continue}
        </button>
        {onOpenSettings ? (
          <button
            type="button"
            className="secondary-button full-button setup-settings-button"
            onClick={onOpenSettings}
          >
            {strings.setup.openSettings}
          </button>
        ) : null}
      </div>
    </div>
  );
}

interface AppearanceStepProps {
  saving: boolean;
  persist: SetupPersist;
  go: SetupGo;
}

export function AppearanceStep({ saving, persist, go }: AppearanceStepProps) {
  const settings = useAppStore((state) => state.settings);

  return (
    <div className="setup-step">
      <p className="setup-intro">{strings.setup.appearanceIntro}</p>
      <DisplayOptions onChange={(patch) => void persist(patch)} />

      <div
        className="setup-preview"
        aria-label={strings.setup.previewInbox}
        data-reading-pane={settings.readingPane}
      >
        <p className="setup-preview-live">{strings.setup.previewLive}</p>
        <div className="setup-preview-mail">
          <div className="setup-preview-folders" aria-hidden="true">
            <strong>{strings.setup.previewFolders}</strong>
            <span className="active">{roleLabels.inbox}</span>
            <span>{roleLabels.sent}</span>
            <span>{roleLabels.drafts}</span>
          </div>
          <div className="setup-preview-list" aria-hidden="true">
            <div className="setup-preview-row">
              <strong>{strings.setup.previewSender}</strong>
              <span>{strings.setup.previewSubject}</span>
            </div>
            <div className="setup-preview-row muted">
              <strong>{strings.setup.previewSender}</strong>
              <span>{strings.setup.previewSubject}</span>
            </div>
          </div>
          <div className="setup-preview-reader" aria-hidden="true">
            <strong>
              {settings.readingPane === "bottom"
                ? strings.setup.previewReadingBottom
                : settings.readingPane === "hidden"
                  ? strings.setup.previewReadingHidden
                  : strings.setup.previewReadingRight}
            </strong>
            <span>{strings.setup.previewSubject}</span>
          </div>
        </div>
      </div>
      {settings.density === "compact" && settings.textScale >= 1.5 ? (
        <p className="setup-field-hint" role="status">
          {strings.setup.comfortLargeText}
        </p>
      ) : null}

      <div className="setup-actions split">
        <button
          type="button"
          className="secondary-button"
          onClick={() => go("welcome")}
        >
          {strings.common.back}
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={saving}
          onClick={() => go("comfort")}
        >
          {strings.setup.continue}
        </button>
      </div>
    </div>
  );
}

interface ComfortStepProps {
  saving: boolean;
  persist: SetupPersist;
  go: SetupGo;
}

export function ComfortStep({ saving, persist, go }: ComfortStepProps) {
  const settings = useAppStore((state) => state.settings);

  return (
    <div className="setup-step">
      <p className="setup-intro">{strings.setup.comfortIntro}</p>
      <div className="setup-switches">
        <label className="switch-row">
          <span>
            <strong>{strings.settings.notifyNewMail}</strong>
            <small>{strings.settings.notifyNewMailHelp}</small>
          </span>
          <input
            type="checkbox"
            checked={settings.notifyNewMail}
            onChange={(event) =>
              void persist({ notifyNewMail: event.target.checked })
            }
          />
        </label>
        <label className="switch-row">
          <span>
            <strong>{strings.settings.privateNotifications}</strong>
            <small>{strings.settings.privateNotificationsHelp}</small>
          </span>
          <input
            type="checkbox"
            checked={settings.privateNotifications}
            onChange={(event) =>
              void persist({
                privateNotifications: event.target.checked,
              })
            }
          />
        </label>
        <label className="switch-row">
          <span>
            <strong>{strings.settings.groupThreads}</strong>
            <small>{strings.settings.groupThreadsHelp}</small>
          </span>
          <input
            type="checkbox"
            checked={settings.groupThreads}
            onChange={(event) =>
              void persist({ groupThreads: event.target.checked })
            }
          />
        </label>
        <label className="switch-row">
          <span>
            <strong>{strings.settings.windowEffects}</strong>
            <small>{strings.settings.windowEffectsHelp}</small>
          </span>
          <input
            type="checkbox"
            checked={settings.windowEffects}
            onChange={(event) =>
              void persist({ windowEffects: event.target.checked })
            }
          />
        </label>
        <CloseToTraySwitch
          checked={settings.closeToTray}
          onChecked={(checked) => void persist({ closeToTray: checked })}
        />
        <label className="switch-row">
          <span>
            <strong>{strings.settings.blockAds}</strong>
            <small>{strings.settings.blockAdsHelp}</small>
          </span>
          <input
            type="checkbox"
            checked={settings.blockAdvertisingAndTracking}
            onChange={(event) =>
              void persist({
                blockAdvertisingAndTracking: event.target.checked,
              })
            }
          />
        </label>
      </div>
      <div className="setup-actions split">
        <button
          type="button"
          className="secondary-button"
          onClick={() => go("appearance")}
        >
          {strings.common.back}
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={saving}
          onClick={() => go("account")}
        >
          {strings.setup.continue}
        </button>
      </div>
    </div>
  );
}

interface AccountStepProps {
  go: SetupGo;
  handleAccountAdded: () => Promise<void>;
  onOpenSettings?: () => void;
  error?: string;
}

export function AccountStep({
  go,
  handleAccountAdded,
  onOpenSettings,
  error,
}: AccountStepProps) {
  // Once saved, going back would drop the first-sync screen and invite a
  // duplicate account, so only "Open mailbox" remains.
  const [accountSaved, setAccountSaved] = useState(false);

  return (
    <div className="setup-step setup-account-embed">
      {accountSaved ? null : (
        <p className="setup-intro">{strings.setup.accountIntro}</p>
      )}
      <SetupWizard
        embedded
        onComplete={handleAccountAdded}
        onOpenSettings={onOpenSettings}
        onAccountSaved={() => setAccountSaved(true)}
      />
      {accountSaved ? null : (
        <div className="setup-actions setup-account-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => go("comfort")}
          >
            {strings.setup.backToSetup}
          </button>
        </div>
      )}
      {error ? (
        <p className="setup-field-hint" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
