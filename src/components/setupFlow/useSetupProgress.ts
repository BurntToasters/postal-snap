import { useEffect } from "react";
import { useAppStore } from "../../store";
import type { SetupStep } from "../../types";
import type { SettingsSaveUpdate } from "../settings/useSettingsSave";

export function useSetupProgress(step: SetupStep, update: SettingsSaveUpdate) {
  useEffect(() => {
    // Persist progress so an unfinished setup re-appears on next launch.
    const current = useAppStore.getState().settings;
    if (current.setupStep === step || current.setupCompleted) return;
    void update({ setupStep: step }, undefined, { quiet: true });
  }, [step, update]);
}
