import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { api } from "../api";
import { strings } from "../i18n";
import { applySettings } from "../settings";
import { useAppStore } from "../store";
import type { SetupStep } from "../types";
import { AppMark } from "./AppMark";
import {
  AccountStep,
  AppearanceStep,
  ComfortStep,
  WelcomeStep,
} from "./setupFlow/steps";
import { useSetupProgress } from "./setupFlow/useSetupProgress";

interface Props {
  startupNotice?: string | null;
  onComplete: () => Promise<void>;
  onOpenSettings?: () => void;
}

const STEPS: SetupStep[] = ["welcome", "appearance", "comfort", "account"];

const STEP_LABELS: Record<SetupStep, string> = {
  welcome: strings.setup.stepWelcome,
  appearance: strings.setup.stepAppearance,
  comfort: strings.setup.stepComfort,
  account: strings.setup.stepAccount,
};

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
  const pageRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousStepRef = useRef(step);

  useSetupProgress(step);

  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    page.scrollTop = 0;
    const host = page.closest<HTMLElement>(".setup-host");
    if (host) host.scrollTop = 0;
    if (previousStepRef.current !== step)
      headingRef.current?.focus({ preventScroll: true });
    previousStepRef.current = step;
  }, [step]);

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
    <div className="setup-page" ref={pageRef}>
      <section
        className="setup-card setup-flow"
        aria-labelledby="setup-flow-title"
      >
        <header className="setup-brand" data-tauri-drag-region="deep">
          <AppMark size={52} />
          <span>
            <p>{strings.appName}</p>
            <h1 id="setup-flow-title" ref={headingRef} tabIndex={-1}>
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
            <div
              key={value}
              role="listitem"
              aria-current={value === step ? "step" : undefined}
              className={
                position < index ? "done" : position === index ? "active" : ""
              }
            >
              <span aria-hidden="true">
                {position < index ? <Check /> : position + 1}
              </span>
              <small>{STEP_LABELS[value]}</small>
            </div>
          ))}
        </div>

        {startupNotice ? (
          <div className="setup-help" role="status">
            <span>{startupNotice}</span>
            <span>{strings.setup.settingsRestored}</span>
          </div>
        ) : null}

        {step === "welcome" ? (
          <WelcomeStep go={go} onOpenSettings={onOpenSettings} />
        ) : null}

        {step === "appearance" ? (
          <AppearanceStep saving={saving} persist={persist} go={go} />
        ) : null}

        {step === "comfort" ? (
          <ComfortStep saving={saving} persist={persist} go={go} />
        ) : null}

        {step === "account" ? (
          <AccountStep
            saving={saving}
            go={go}
            finish={finish}
            handleAccountAdded={handleAccountAdded}
            error={error}
          />
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
