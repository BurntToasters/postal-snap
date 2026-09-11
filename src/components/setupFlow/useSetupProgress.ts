import { useEffect } from "react";
import { api } from "../../api";
import { applySettings } from "../../settings";
import { useAppStore } from "../../store";
import type { SetupStep } from "../../types";

export function useSetupProgress(step: SetupStep) {
  const setSettings = useAppStore((state) => state.setSettings);

  useEffect(() => {
    // Persist progress so an unfinished setup re-appears on next launch.
    const current = useAppStore.getState().settings;
    if (current.setupStep === step || current.setupCompleted) return;
    const next = { ...current, setupStep: step };
    setSettings(next);
    applySettings(next);
    void api.saveSettings(next).catch(() => undefined);
  }, [step, setSettings]);
}
