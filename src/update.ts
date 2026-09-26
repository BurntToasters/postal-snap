import { api } from "./api";
import { strings } from "./i18n";
import { closesToTrayOnClose } from "./settings";
import { useAppStore } from "./store";
import type { AppSettings, UpdateCheckInterval } from "./types";

export interface UpdateCheckResult {
  available: boolean;
  version?: string;
}

export type UpdateFoundListener = (version?: string) => void;

/**
 * restart: reopen the window (Settings or banner).
 * background: reopen in the tray or menu bar with no window.
 * quit: install and stay closed.
 */
export type UpdateApplyMode = "restart" | "background" | "quit";

interface DownloadedUpdate {
  version: string;
  download: () => Promise<void>;
  install: (options?: { restartAfterInstall?: boolean }) => Promise<void>;
}

let updateInFlight: Promise<UpdateCheckResult> | undefined;
let interactiveInFlight: Promise<void> | undefined;
let applyInFlight: Promise<void> | undefined;
const updateFoundListeners = new Set<UpdateFoundListener>();
let updateFound = false;
let updateVersion: string | undefined;
let updateReadyVersion: string | undefined;
let pendingPackage: DownloadedUpdate | undefined;
let backgroundApplyFailed = false;
let quitApplyFailed = false;
let backgroundHolds = 0;
const updateReadyListeners = new Set<() => void>();

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
  backgroundApplyFailed = false;
  quitApplyFailed = false;
  backgroundHolds = 0;
  updateReadyListeners.clear();
  useAppStore.getState().setUpdateReady(null);
}

export function getUpdateReadyVersion(): string | undefined {
  return updateReadyVersion ?? useAppStore.getState().updateReady ?? undefined;
}

function markUpdateReady(update: DownloadedUpdate): void {
  pendingPackage = update;
  updateReadyVersion = update.version;
  useAppStore.getState().setUpdateReady(update.version);
  void api.setUpdateReady(true).catch(() => undefined);
  for (const listener of updateReadyListeners) listener();
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

export async function applyPendingUpdate(
  mode: UpdateApplyMode = "restart",
): Promise<void> {
  if (applyInFlight) return applyInFlight;
  const task = (async (): Promise<void> => {
    const relaunch = mode !== "quit";
    try {
      if (mode === "background") {
        // Without the marker the relaunch would open the window.
        await api.prepareUpdateRelaunch("background");
      } else if (mode === "restart") {
        await api.prepareUpdateRelaunch("window").catch(() => undefined);
      }
      if (pendingPackage) {
        // Windows exits here; its installer reopens the app only on relaunch.
        await pendingPackage.install({ restartAfterInstall: relaunch });
        pendingPackage = undefined;
      }
      if (relaunch) await api.relaunch();
      else await api.quitApp();
    } catch {
      await api.clearUpdateRelaunch().catch(() => undefined);
      if (mode === "background") {
        // Stay quiet in the tray; Settings can still retry.
        backgroundApplyFailed = true;
        return;
      }
      if (mode === "quit") {
        // The next Quit exits instead of retrying the failed install.
        quitApplyFailed = true;
        void api.setUpdateReady(false).catch(() => undefined);
      }
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
    { ok: strings.update.restartNow, cancel: strings.update.later },
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

      await promptToRestartForUpdate(update.version);
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

export function checksUpdatesOnStartup(interval: UpdateCheckInterval): boolean {
  return interval !== "manual";
}

export function periodicUpdateIntervalMs(
  interval: UpdateCheckInterval,
): number | null {
  switch (interval) {
    case "startupAnd6h":
      return 6 * 60 * 60 * 1000;
    case "startupAnd12h":
      return 12 * 60 * 60 * 1000;
    case "startupAnd24h":
      return 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}

export function startPeriodicUpdateCheck(
  interval: UpdateCheckInterval,
): () => void {
  const intervalMs = periodicUpdateIntervalMs(interval);
  if (intervalMs == null) return () => undefined;
  const timer = window.setInterval(() => {
    if (!getUpdateReadyVersion() && !interactiveInFlight && !updateInFlight) {
      void runUpdateSingleFlight().catch(() => undefined);
    }
  }, intervalMs);
  return () => window.clearInterval(timer);
}

export async function windowWouldHideInsteadOfQuit(
  settings: Pick<AppSettings, "closeToTray"> = useAppStore.getState().settings,
  platform = document.documentElement.dataset.platform,
): Promise<boolean> {
  if (!closesToTrayOnClose(settings, platform)) return false;
  if (platform === "macos") return true;
  if (platform !== "windows") return false;
  try {
    return await api.trayIsActive();
  } catch {
    return false;
  }
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
          if (await windowWouldHideInsteadOfQuit()) {
            return;
          }
          try {
            await quitOrApplyPendingUpdate();
          } catch {
            // Leave the window open so drafts and unsent mail are not lost.
          }
        });
      })
      .catch(() => undefined);
  };
  updateReadyListeners.add(attach);
  attach();
  return () => {
    cancelled = true;
    updateReadyListeners.delete(attach);
    unlisten?.();
  };
}

/** Delays background installs while work such as an SMTP send runs. */
export function holdBackgroundUpdate(): () => void {
  backgroundHolds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    backgroundHolds -= 1;
  };
}

function backgroundUpdateBlocked(): boolean {
  return backgroundHolds > 0 || useAppStore.getState().composerOpen;
}

/**
 * Installs a downloaded update while the window is hidden to the tray or
 * menu bar, then restarts there without showing the window.
 */
export function startBackgroundUpdateWhileHidden(): () => void {
  let cancelled = false;
  let unlisten: (() => void) | undefined;
  // Rust times the tray wait; hidden webviews throttle their own timers.
  const attempt = async () => {
    if (
      cancelled ||
      !pendingPackage ||
      backgroundApplyFailed ||
      applyInFlight
    ) {
      return;
    }
    const allowed = await api.backgroundUpdateAllowed().catch(() => false);
    // A reopened window waits for the next close.
    if (!allowed || cancelled) return;
    if (backgroundUpdateBlocked()) {
      void api.scheduleBackgroundUpdate().catch(() => undefined);
      return;
    }
    await applyPendingUpdate("background");
  };
  void api
    .onBackgroundUpdateDue(() => void attempt())
    .then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    })
    .catch(() => undefined);
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

export async function quitOrApplyPendingUpdate(): Promise<void> {
  if (getUpdateReadyVersion() && !quitApplyFailed) {
    await applyPendingUpdate("quit");
    return;
  }
  await api.quitApp();
}
