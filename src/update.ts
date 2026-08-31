export interface UpdateCheckResult {
  available: boolean;
  version?: string;
}

export type UpdateFoundListener = (version?: string) => void;

let updateInFlight: Promise<UpdateCheckResult> | undefined;
const updateFoundListeners = new Set<UpdateFoundListener>();
let updateFound = false;
let updateVersion: string | undefined;

export function removeUpdateFoundListener(listener: UpdateFoundListener): void {
  updateFoundListeners.delete(listener);
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
    const [{ check }, { relaunch }] = await Promise.all([
      import("@tauri-apps/plugin-updater"),
      import("@tauri-apps/plugin-process"),
    ]);
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
    await relaunch();
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
