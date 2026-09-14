import { ShieldCheck } from "lucide-react";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type { AppSettings, SetupStep } from "../../types";
import { SetupWizard } from "../SetupWizard";
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
      <div className="setup-field-grid">
        <label>
          {strings.settings.appearance}
          <select
            aria-label={strings.settings.appearance}
            value={settings.theme}
            onChange={(event) =>
              void persist({
                theme: event.target.value as typeof settings.theme,
              })
            }
          >
            <option value="system">{strings.settings.autoDefault}</option>
            <option value="light">{strings.settings.light}</option>
            <option value="dark">{strings.settings.dark}</option>
          </select>
        </label>
        <small className="setup-field-hint">
          {strings.settings.appearanceHelp}
        </small>
        <label>
          {strings.settings.spacing}
          <select
            aria-label={strings.settings.spacing}
            value={settings.density}
            onChange={(event) =>
              void persist({
                density: event.target.value as typeof settings.density,
              })
            }
          >
            <option value="comfortable">{strings.settings.comfortable}</option>
            <option value="compact">{strings.settings.compact}</option>
          </select>
        </label>
        <small className="setup-field-hint">
          {strings.settings.spacingHelp}
        </small>
        <label>
          {strings.settings.textSize}
          <select
            aria-label={strings.settings.textSize}
            value={settings.textScale}
            onChange={(event) =>
              void persist({ textScale: Number(event.target.value) })
            }
          >
            <option value={0.85}>{strings.settings.small}</option>
            <option value={1}>{strings.settings.normal}</option>
            <option value={1.15}>{strings.settings.large}</option>
            <option value={1.3}>{strings.settings.extraLarge}</option>
            <option value={1.5}>{strings.settings.veryLarge}</option>
            <option value={2}>{strings.settings.largest}</option>
          </select>
        </label>
        <label>
          {strings.settings.readingPane}
          <select
            aria-label={strings.settings.readingPane}
            value={settings.readingPane}
            onChange={(event) =>
              void persist({
                readingPane: event.target.value as typeof settings.readingPane,
              })
            }
          >
            <option value="right">{strings.settings.paneRight}</option>
            <option value="bottom">{strings.settings.paneBottom}</option>
            <option value="hidden">{strings.settings.paneHidden}</option>
          </select>
        </label>
      </div>

      <div
        className="setup-preview"
        aria-label={strings.setup.previewInbox}
        data-reading-pane={settings.readingPane}
      >
        <p className="setup-preview-live">{strings.setup.previewLive}</p>
        <div className="setup-preview-mail">
          <div className="setup-preview-folders" aria-hidden="true">
            <strong>{strings.setup.previewFolders}</strong>
            <span className="active">Inbox</span>
            <span>Sent</span>
            <span>Drafts</span>
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
  saving: boolean;
  go: SetupGo;
  finish: () => Promise<void>;
  handleAccountAdded: () => Promise<void>;
  error?: string;
}

export function AccountStep({
  saving,
  go,
  finish,
  handleAccountAdded,
  error,
}: AccountStepProps) {
  return (
    <div className="setup-step setup-account-embed">
      <p className="setup-intro">{strings.setup.accountIntro}</p>
      <SetupWizard embedded onComplete={handleAccountAdded} />
      <div className="setup-actions split setup-account-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => go("comfort")}
        >
          {strings.setup.backToSetup}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={saving}
          onClick={() => void finish()}
        >
          {strings.setup.skipForNow}
        </button>
      </div>
      {error ? (
        <p className="setup-field-hint" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
