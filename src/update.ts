import { api } from "./api";
import { useAppStore } from "./store";

export interface UpdateCheckResult {
  available: boolean;
  version?: string;
}

export type UpdateFoundListener = (version?: string) => void;

let updateInFlight: Promise<UpdateCheckResult> | undefined;
const updateFoundListeners = new Set<UpdateFoundListener>();
let updateFound = false;
let updateVersion: string | undefined;
let updateReadyVersion: string | undefined;

export function removeUpdateFoundListener(listener: UpdateFoundListener): void {
  updateFoundListeners.delete(listener);
}

export function getUpdateReadyVersion(): string | undefined {
  return updateReadyVersion;
}

export function runUpdateSingleFlight(
  onUpdateFound?: UpdateFoundListener,
): Promise<UpdateCheckResult> {
  if (onUpdateFound) {
    updateFoundListeners.add(onUpdateFound);
    if (updateInFlight && updateFound) {
      try {
        onUpdateFound(updateVersion);
      } catch {
        // A remounted status view must not interrupt the update transaction.
      }
    }
  }
  if (updateInFlight) return updateInFlight;
  const task = (async (): Promise<UpdateCheckResult> => {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return { available: false };
    updateFound = true;
    updateVersion = update.version;
    for (const listener of updateFoundListeners) {
      try {
        listener(update.version);
      } catch {
        // A status listener must never interrupt the update transaction.
      }
    }
    await update.downloadAndInstall();
    updateReadyVersion = update.version;
    useAppStore.getState().setUpdateReady(update.version);
    return { available: true, version: update.version };
  })();
  updateInFlight = task;
  void task.then(
    () => {
      if (updateInFlight === task) {
        updateInFlight = undefined;
        updateFound = false;
        updateVersion = undefined;
        updateFoundListeners.clear();
      }
    },
    () => {
      if (updateInFlight === task) {
        updateInFlight = undefined;
        updateFound = false;
        updateVersion = undefined;
        updateFoundListeners.clear();
      }
    },
  );
  return task;
}

export async function promptToRestartForUpdate(
  version?: string,
): Promise<void> {
  const ver =
    version ?? updateReadyVersion ?? useAppStore.getState().updateReady;
  const confirmed = await api.showNativeConfirm(
    "Update Ready",
    `Postal Snap ${ver ? `version ${ver}` : "update"} has been downloaded. Would you like to restart now to complete the update?`,
  );
  if (confirmed) {
    await api.relaunch();
  }
}

export async function checkUpdateInteractive(): Promise<void> {
  const ready = updateReadyVersion ?? useAppStore.getState().updateReady;
  if (ready) {
    await promptToRestartForUpdate(ready);
    return;
  }

  try {
    const result = await runUpdateSingleFlight();
    if (result.available && result.version) {
      await promptToRestartForUpdate(result.version);
    } else {
      await api.showNativeMessage(
        "Postal Snap",
        "You're up to date! Postal Snap is currently running the latest version.",
      );
    }
  } catch {
    await api.showNativeMessage(
      "Check for Updates",
      "Postal Snap could not connect to the update service. Please check your internet connection and try again.",
    );
  }
}
