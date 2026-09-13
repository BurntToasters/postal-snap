import { api } from "./api";
import { strings } from "./i18n";
import { useAppStore } from "./store";

export interface UpdateCheckResult {
  available: boolean;
  version?: string;
}

export type UpdateFoundListener = (version?: string) => void;

interface DownloadedUpdate {
  version: string;
  download: () => Promise<void>;
  install: () => Promise<void>;
}

let updateInFlight: Promise<UpdateCheckResult> | undefined;
let interactiveInFlight: Promise<void> | undefined;
let applyInFlight: Promise<void> | undefined;
const updateFoundListeners = new Set<UpdateFoundListener>();
let updateFound = false;
let updateVersion: string | undefined;
let updateReadyVersion: string | undefined;
let pendingPackage: DownloadedUpdate | undefined;
const quitUpdateListeners = new Set<() => void>();

export function addUpdateFoundListener(listener: UpdateFoundListener): void {
  updateFoundListeners.add(listener);
  if (updateInFlight && updateFound) {
    try {
      listener(updateVersion);
    } catch {
      // A remounted status view must not interrupt the update transaction.
    }
  }
}

export function removeUpdateFoundListener(listener: UpdateFoundListener): void {
  updateFoundListeners.delete(listener);
}

export function resetUpdateStateForTesting(): void {
  updateInFlight = undefined;
  interactiveInFlight = undefined;
  applyInFlight = undefined;
  updateFoundListeners.clear();
  updateFound = false;
  updateVersion = undefined;
  updateReadyVersion = undefined;
  pendingPackage = undefined;
  quitUpdateListeners.clear();
  useAppStore.getState().setUpdateReady(null);
}

export function getUpdateReadyVersion(): string | undefined {
  return updateReadyVersion ?? useAppStore.getState().updateReady ?? undefined;
}

function markUpdateReady(update: DownloadedUpdate): void {
  pendingPackage = update;
  updateReadyVersion = update.version;
  useAppStore.getState().setUpdateReady(update.version);
  for (const listener of quitUpdateListeners) listener();
}

function notifyUpdateFound(version: string): void {
  updateFound = true;
  updateVersion = version;
  for (const listener of updateFoundListeners) {
    try {
      listener(version);
    } catch {
      // A status listener must never interrupt the update transaction.
    }
  }
}

export function runUpdateSingleFlight(
  onUpdateFound?: UpdateFoundListener,
): Promise<UpdateCheckResult> {
  const alreadyReady = getUpdateReadyVersion();
  if (alreadyReady) {
    return Promise.resolve({ available: true, version: alreadyReady });
  }

  if (onUpdateFound) addUpdateFoundListener(onUpdateFound);
  if (updateInFlight) return updateInFlight;
  const task = (async (): Promise<UpdateCheckResult> => {
    if (!(await updatesManagedByPostalSnap())) {
      return { available: false };
    }
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return { available: false };
    notifyUpdateFound(update.version);
    await update.download();
    markUpdateReady(update);
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

export async function applyPendingUpdate(): Promise<void> {
  if (applyInFlight) return applyInFlight;
  const task = (async (): Promise<void> => {
    try {
      if (pendingPackage) {
        await pendingPackage.install();
        pendingPackage = undefined;
      }
      await api.relaunch();
    } catch {
      await api.showNativeMessage(
        strings.update.installErrorTitle,
        strings.update.installErrorMessage,
      );
    }
  })();
  applyInFlight = task;
  try {
    await task;
  } finally {
    if (applyInFlight === task) applyInFlight = undefined;
  }
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
    await applyPendingUpdate();
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
        await api.showNativeMessage(
          strings.update.downloadedQuietlyTitle,
          strings.update.downloadedQuietly(result.version),
        );
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

  // Serialize with the background check: a periodic run starting now joins
  // this interactive run instead of downloading twice.
  if (interactiveInFlight) {
    await interactiveInFlight.catch(() => undefined);
    return checkUpdateInteractive();
  }
  const task = (async (): Promise<void> => {
    try {
      if (!(await updatesManagedByPostalSnap())) {
        return;
      }
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (!update) {
        await api.showNativeMessage(
          strings.update.upToDateTitle,
          strings.update.upToDateMessage,
        );
        return;
      }

      notifyUpdateFound(update.version);
      try {
        await update.download();
        markUpdateReady(update);
      } catch {
        await api.showNativeMessage(
          strings.update.downloadErrorTitle,
          strings.update.downloadErrorMessage,
        );
        return;
      }

      await api.showNativeMessage(
        strings.update.downloadedQuietlyTitle,
        strings.update.downloadedQuietly(update.version),
      );
    } catch {
      await api.showNativeMessage(
        strings.update.checkErrorTitle,
        strings.update.checkErrorMessage,
      );
    }
  })();
  interactiveInFlight = task;
  try {
    await task;
  } finally {
    if (interactiveInFlight === task) interactiveInFlight = undefined;
  }
}

async function updatesManagedByPostalSnap(): Promise<boolean> {
  try {
    const channel = await api.distribution();
    return channel.updatesManagedBy === "postalSnap";
  } catch {
    return false;
  }
}

export function startPeriodicUpdateCheck(
  intervalMs = 4 * 60 * 60 * 1000,
): () => void {
  const timer = window.setInterval(() => {
    if (!getUpdateReadyVersion() && !interactiveInFlight && !updateInFlight) {
      void runUpdateSingleFlight().catch(() => undefined);
    }
  }, intervalMs);
  return () => window.clearInterval(timer);
}

export function startDeferredUpdateOnQuit(): () => void {
  if (document.documentElement.dataset.platform === "macos") {
    return () => undefined;
  }
  let unlisten: (() => void) | undefined;
  let cancelled = false;
  const attach = () => {
    if (cancelled || unlisten || !pendingPackage) return;
    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        if (cancelled || unlisten || !pendingPackage) return;
        // Always preventDefault: Tauri's listener otherwise destroy()s the
        // window, and Postal Snap does not grant allow-destroy.
        unlisten = await getCurrentWindow().onCloseRequested(async (event) => {
          event.preventDefault();
          try {
            await applyPendingUpdate();
          } catch {
            // Leave the window open so drafts and unsent mail are not lost.
          }
        });
      })
      .catch(() => undefined);
  };
  quitUpdateListeners.add(attach);
  attach();
  return () => {
    cancelled = true;
    quitUpdateListeners.delete(attach);
    unlisten?.();
  };
}
