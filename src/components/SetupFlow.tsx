import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { strings } from "../i18n";
import { useAppStore } from "../store";
import type { SettingsPatch, SetupStep } from "../types";
import { AppMark } from "./AppMark";
import {
  AccountStep,
  AppearanceStep,
  ComfortStep,
  WelcomeStep,
} from "./setupFlow/steps";
import { useSetupProgress } from "./setupFlow/useSetupProgress";
import { useSettingsSave } from "./settings/useSettingsSave";

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
  const [step, setStep] = useState<SetupStep>(() => {
    const saved = useAppStore.getState().settings.setupStep;
    return saved && STEPS.includes(saved) ? saved : "welcome";
  });
  const [error, setError] = useState<string>();
  // One queued writer for every setup save, so quick changes cannot race.
  const { saving, update } = useSettingsSave(() =>
    setError(strings.setup.saveFailed),
  );
  const pageRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousStepRef = useRef(step);

  useSetupProgress(step, update);

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

  async function persist(patch: SettingsPatch) {
    setError(undefined);
    await update(patch);
  }

  async function handleAccountAdded() {
    // App reloads accounts and repairs setupCompleted once an account exists.
    // Setting the flag here first would briefly show the standalone wizard.
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
            go={go}
            handleAccountAdded={handleAccountAdded}
            onOpenSettings={onOpenSettings}
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
