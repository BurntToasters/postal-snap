import { api } from "./api";
import { strings } from "./i18n";
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

export function resetUpdateStateForTesting(): void {
  updateInFlight = undefined;
  updateFoundListeners.clear();
  updateFound = false;
  updateVersion = undefined;
  updateReadyVersion = undefined;
  useAppStore.getState().setUpdateReady(null);
}

export function getUpdateReadyVersion(): string | undefined {
  return updateReadyVersion ?? useAppStore.getState().updateReady ?? undefined;
}

export function runUpdateSingleFlight(
  onUpdateFound?: UpdateFoundListener,
): Promise<UpdateCheckResult> {
  const alreadyReady = getUpdateReadyVersion();
  if (alreadyReady) {
    return Promise.resolve({ available: true, version: alreadyReady });
  }

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
  const cleanup = () => {
    if (updateInFlight === task) {
      updateInFlight = undefined;
      updateFound = false;
      updateVersion = undefined;
      updateFoundListeners.clear();
    }
  };
  void task.then(cleanup, cleanup);
  return task;
}

export async function promptToRestartForUpdate(
  version?: string,
): Promise<void> {
  const ver = version ?? getUpdateReadyVersion();
  const confirmed = await api.showNativeConfirm(
    strings.update.readyTitle,
    strings.update.readyPrompt(ver ?? ""),
  );
  if (confirmed) {
    await api.relaunch();
  }
}

export async function checkUpdateInteractive(): Promise<void> {
  const ready = getUpdateReadyVersion();
  if (ready) {
    await promptToRestartForUpdate(ready);
    return;
  }

  if (updateInFlight) {
    try {
      const result = await updateInFlight;
      if (result.available && result.version) {
        await promptToRestartForUpdate(result.version);
      } else {
        await api.showNativeMessage(
          strings.update.upToDateTitle,
          strings.update.upToDateMessage,
        );
      }
    } catch {
      await api.showNativeMessage(
        strings.update.checkErrorTitle,
        strings.update.checkErrorMessage,
      );
    }
    return;
  }

  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      await api.showNativeMessage(
        strings.update.upToDateTitle,
        strings.update.upToDateMessage,
      );
      return;
    }

    const shouldDownload = await api.showNativeConfirm(
      strings.update.availableTitle,
      strings.update.availablePrompt(update.version),
    );
    if (!shouldDownload) return;

    try {
      await update.downloadAndInstall();
      updateReadyVersion = update.version;
      useAppStore.getState().setUpdateReady(update.version);
    } catch {
      await api.showNativeMessage(
        strings.update.downloadErrorTitle,
        strings.update.downloadErrorMessage,
      );
      return;
    }

    await promptToRestartForUpdate(update.version);
  } catch {
    await api.showNativeMessage(
      strings.update.checkErrorTitle,
      strings.update.checkErrorMessage,
    );
  }
}

export function startPeriodicUpdateCheck(
  intervalMs = 4 * 60 * 60 * 1000,
): () => void {
  const timer = window.setInterval(() => {
    if (!getUpdateReadyVersion()) {
      void runUpdateSingleFlight().catch(() => undefined);
    }
  }, intervalMs);
  return () => window.clearInterval(timer);
}
