import { useEffect, useState } from "react";
import { Check, ShieldCheck } from "lucide-react";
import { api } from "../api";
import { strings } from "../i18n";
import { applySettings } from "../settings";
import { useAppStore } from "../store";
import type { SetupStep } from "../types";
import { SetupWizard } from "./SetupWizard";
import { AppMark } from "./AppMark";

interface Props {
  startupNotice?: string | null;
  onComplete: () => Promise<void>;
  onOpenSettings?: () => void;
}

const STEPS: SetupStep[] = ["welcome", "appearance", "comfort", "account"];

function stepIndex(step: SetupStep): number {
  return STEPS.indexOf(step);
}

export function SetupFlow({
  startupNotice,
  onComplete,
  onOpenSettings,
}: Props) {
  const settings = useAppStore((state) => state.settings);
  const setSettings = useAppStore((state) => state.setSettings);
  const [step, setStep] = useState<SetupStep>(() => {
    const saved = settings.setupStep;
    return saved && STEPS.includes(saved) ? saved : "welcome";
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    // Persist progress so an unfinished setup re-appears on next launch.
    const current = useAppStore.getState().settings;
    if (current.setupStep === step || current.setupCompleted) return;
    const next = { ...current, setupStep: step };
    setSettings(next);
    applySettings(next);
    void api.saveSettings(next).catch(() => undefined);
  }, [step, setSettings]);

  async function persist(patch: Partial<typeof settings>) {
    const current = useAppStore.getState().settings;
    const next = { ...current, ...patch };
    setSettings(next);
    applySettings(next);
    setSaving(true);
    try {
      const saved = await api.saveSettings(next);
      setSettings(saved);
      applySettings(saved);
    } catch {
      setError(strings.settings.saving);
    } finally {
      setSaving(false);
    }
  }

  async function finish() {
    setSaving(true);
    try {
      const current = useAppStore.getState().settings;
      const next = {
        ...current,
        setupCompleted: true,
        setupStep: null,
      };
      const saved = await api.saveSettings(next);
      setSettings(saved);
      applySettings(saved);
      await onComplete();
    } catch {
      setError(strings.settings.saving);
    } finally {
      setSaving(false);
    }
  }

  async function handleAccountAdded() {
    // Account already saved by SetupWizard. Mark first-run done, then reload.
    try {
      const current = useAppStore.getState().settings;
      const saved = await api.saveSettings({
        ...current,
        setupCompleted: true,
        setupStep: null,
      });
      setSettings(saved);
      applySettings(saved);
    } catch {
      // Best-effort: mailbox still works, flag retries on next save.
    }
    await onComplete();
  }

  function go(next: SetupStep) {
    setError(undefined);
    setStep(next);
  }

  const index = stepIndex(step);

  return (
    <div className="setup-page">
      <section
        className="setup-card setup-flow"
        aria-labelledby="setup-flow-title"
      >
        <header className="setup-brand" data-tauri-drag-region="deep">
          <AppMark size={52} />
          <span>
            <p>{strings.appName}</p>
            <h1 id="setup-flow-title">
              {step === "welcome"
                ? strings.setup.welcomeTitle
                : step === "appearance"
                  ? strings.setup.appearanceTitle
                  : step === "comfort"
                    ? strings.setup.comfortTitle
                    : strings.setup.accountTitle}
            </h1>
          </span>
        </header>

        <div
          className="setup-progress setup-flow-progress"
          role="list"
          aria-label={strings.setup.steps}
        >
          {STEPS.map((value, position) => (
            <span
              key={value}
              role="listitem"
              aria-current={value === step ? "step" : undefined}
              aria-label={
                strings.setup[
                  value === "welcome"
                    ? "stepWelcome"
                    : value === "appearance"
                      ? "stepAppearance"
                      : value === "comfort"
                        ? "stepComfort"
                        : "stepAccount"
                ]
              }
              className={
                position < index ? "done" : position === index ? "active" : ""
              }
            >
              {position < index ? <Check aria-hidden="true" /> : position + 1}
            </span>
          ))}
        </div>

        {startupNotice ? (
          <div className="setup-help" role="status">
            <span>{startupNotice}</span>
            <span>{strings.setup.settingsRestored}</span>
          </div>
        ) : null}

        {step === "welcome" ? (
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
        ) : null}

        {step === "appearance" ? (
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
                  <option value="comfortable">
                    {strings.settings.comfortable}
                  </option>
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
                      readingPane: event.target
                        .value as typeof settings.readingPane,
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
        ) : null}

        {step === "comfort" ? (
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
        ) : null}

        {step === "account" ? (
          <div className="setup-step setup-account-embed">
            <p className="setup-intro">{strings.setup.accountIntro}</p>
            <div className="setup-actions split">
              <button
                type="button"
                className="secondary-button"
                onClick={() => go("comfort")}
              >
                {strings.common.back}
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
            <SetupWizard onComplete={handleAccountAdded} />
            {error ? (
              <p className="setup-field-hint" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}

        {error && step !== "account" ? (
          <p className="setup-field-hint" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    </div>
  );
}
