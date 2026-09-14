import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(),
}));

const onCloseRequested = vi.fn();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested,
  }),
}));

vi.mock("../api", () => ({
  api: {
    showNativeConfirm: vi.fn().mockResolvedValue(true),
    showNativeMessage: vi.fn().mockResolvedValue(undefined),
    relaunch: vi.fn().mockResolvedValue(undefined),
    quitApp: vi.fn().mockResolvedValue(undefined),
    trayIsActive: vi.fn().mockResolvedValue(true),
    distribution: vi.fn().mockResolvedValue({ updatesManagedBy: "postalSnap" }),
  },
}));

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { api } from "../api";
import { useAppStore } from "../store";
import {
  addUpdateFoundListener,
  applyPendingUpdate,
  checkUpdateInteractive,
  checksUpdatesOnStartup,
  periodicUpdateIntervalMs,
  promptToRestartForUpdate,
  removeUpdateFoundListener,
  resetUpdateStateForTesting,
  runUpdateSingleFlight,
  quitOrApplyPendingUpdate,
  startDeferredUpdateOnQuit,
  startPeriodicUpdateCheck,
} from "../update";

const mockedCheck = vi.mocked(check);
const mockedRelaunch = vi.mocked(relaunch);
const mockedConfirm = vi.mocked(api.showNativeConfirm);
const mockedMessage = vi.mocked(api.showNativeMessage);

function fakeUpdate(
  version: string,
  download: () => Promise<void> = () => Promise.resolve(),
  install: () => Promise<void> = () => Promise.resolve(),
) {
  return {
    version,
    download: vi.fn(download),
    install: vi.fn(install),
    downloadAndInstall: vi.fn(),
  };
}

describe("update checks", () => {
  beforeEach(() => {
    resetUpdateStateForTesting();
    mockedCheck.mockReset();
    mockedRelaunch.mockReset();
    mockedConfirm.mockReset();
    mockedMessage.mockReset();
    onCloseRequested.mockReset();
    onCloseRequested.mockResolvedValue(vi.fn());
    vi.mocked(api.relaunch).mockClear();
    vi.mocked(api.quitApp).mockClear();
    vi.mocked(api.trayIsActive).mockReset();
    vi.mocked(api.trayIsActive).mockResolvedValue(true);
    vi.mocked(api.distribution).mockResolvedValue({
      updatesManagedBy: "postalSnap",
    } as never);
    delete document.documentElement.dataset.platform;
  });

  afterEach(() => {
    delete document.documentElement.dataset.platform;
  });

  it("shares one in-flight check across Settings dialog instances", async () => {
    let resolveCheck: (value: null) => void = () => undefined;
    mockedCheck.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );

    const first = runUpdateSingleFlight();
    const second = runUpdateSingleFlight();

    expect(second).toBe(first);
    await vi.waitFor(() => expect(mockedCheck).toHaveBeenCalledTimes(1));
    resolveCheck(null);
    await expect(first).resolves.toEqual({ available: false });
  });

  it("does not load the updater plugin for store-managed builds", async () => {
    vi.mocked(api.distribution).mockResolvedValue({
      updatesManagedBy: "store",
    } as never);
    await expect(runUpdateSingleFlight()).resolves.toEqual({
      available: false,
    });
    await checkUpdateInteractive();
    expect(mockedCheck).not.toHaveBeenCalled();
  });

  it("reports the version and downloads without installing or relaunching", async () => {
    const update = fakeUpdate("0.1.2");
    mockedCheck.mockResolvedValue(update as never);
    const onUpdateFound = vi.fn();

    await expect(runUpdateSingleFlight(onUpdateFound)).resolves.toEqual({
      available: true,
      version: "0.1.2",
    });
    expect(onUpdateFound).toHaveBeenCalledWith("0.1.2");
    expect(update.download).toHaveBeenCalledTimes(1);
    expect(update.install).not.toHaveBeenCalled();
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(mockedRelaunch).not.toHaveBeenCalled();
    expect(api.relaunch).not.toHaveBeenCalled();
  });

  it("allows an unmounted settings view to unsubscribe", async () => {
    type FakeUpdate = ReturnType<typeof fakeUpdate>;
    let resolveCheck: (value: FakeUpdate) => void = () => undefined;
    mockedCheck.mockImplementation(
      () =>
        new Promise<FakeUpdate>((resolve) => {
          resolveCheck = resolve;
        }) as never,
    );
    const onUpdateFound = vi.fn();
    const task = runUpdateSingleFlight(onUpdateFound);
    await vi.waitFor(() => expect(mockedCheck).toHaveBeenCalledTimes(1));
    removeUpdateFoundListener(onUpdateFound);
    resolveCheck(fakeUpdate("0.1.2"));
    await task;
    expect(onUpdateFound).not.toHaveBeenCalled();
  });

  it("replays the downloading state to a listener added during download", async () => {
    let finishDownload: () => void = () => undefined;
    const download = new Promise<void>((resolve) => {
      finishDownload = resolve;
    });
    mockedCheck.mockResolvedValue(fakeUpdate("0.1.2", () => download) as never);
    const firstListener = vi.fn();
    const lateListener = vi.fn();

    const task = runUpdateSingleFlight(firstListener);
    await vi.waitFor(() => expect(firstListener).toHaveBeenCalledWith("0.1.2"));
    addUpdateFoundListener(lateListener);
    expect(lateListener).toHaveBeenCalledWith("0.1.2");

    finishDownload();
    await task;
  });

  it("shows up-to-date message when no update is available", async () => {
    mockedCheck.mockResolvedValue(null);
    await checkUpdateInteractive();
    expect(mockedMessage).toHaveBeenCalledWith(
      "Postal Snap",
      "You're up to date! Postal Snap is currently running the latest version.",
    );
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

  it("downloads a found update without restarting", async () => {
    const update = fakeUpdate("0.1.4");
    mockedCheck.mockResolvedValue(update as never);

    await checkUpdateInteractive();

    expect(mockedConfirm).not.toHaveBeenCalled();
    expect(update.download).toHaveBeenCalledTimes(1);
    expect(update.install).not.toHaveBeenCalled();
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(api.relaunch).not.toHaveBeenCalled();
    expect(mockedMessage).toHaveBeenCalledWith(
      "Update Ready",
      expect.stringContaining("0.1.4"),
    );
  });

  it("installs a downloaded update only after an explicit restart", async () => {
    const update = fakeUpdate("0.1.4");
    mockedCheck.mockResolvedValue(update as never);
    await runUpdateSingleFlight();
    mockedConfirm.mockResolvedValue(true);

    await promptToRestartForUpdate("0.1.4");

    expect(update.install).toHaveBeenCalledTimes(1);
    expect(api.relaunch).toHaveBeenCalledTimes(1);
  });

  it("keeps update download alive when a listener throws", async () => {
    const update = fakeUpdate("0.1.5");
    mockedCheck.mockResolvedValue(update as never);
    const throwingListener = vi.fn(() => {
      throw new Error("view removed");
    });

    await expect(runUpdateSingleFlight(throwingListener)).resolves.toEqual({
      available: true,
      version: "0.1.5",
    });
    expect(update.download).toHaveBeenCalledTimes(1);
    expect(update.install).not.toHaveBeenCalled();
  });

  it("treats distribution lookup failure as externally managed", async () => {
    vi.mocked(api.distribution).mockRejectedValueOnce(new Error("unavailable"));
    await expect(runUpdateSingleFlight()).resolves.toEqual({
      available: false,
    });
    expect(mockedCheck).not.toHaveBeenCalled();
  });

  it("reports update check and download failures", async () => {
    mockedCheck.mockRejectedValueOnce(new Error("network down"));
    await checkUpdateInteractive();
    expect(mockedMessage).toHaveBeenLastCalledWith(
      "Check for Updates",
      expect.any(String),
    );

    resetUpdateStateForTesting();
    mockedCheck.mockResolvedValueOnce(
      fakeUpdate("0.1.6", () =>
        Promise.reject(new Error("disk full")),
      ) as never,
    );
    await checkUpdateInteractive();
    expect(mockedMessage).toHaveBeenLastCalledWith(
      "Update Failed",
      expect.any(String),
    );
  });

  it("runs and stops periodic background checks", async () => {
    vi.useFakeTimers();
    mockedCheck.mockResolvedValue(null);
    const stop = startPeriodicUpdateCheck("startupAnd6h");

    await vi.advanceTimersByTimeAsync(
      periodicUpdateIntervalMs("startupAnd6h")!,
    );
    expect(mockedCheck).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(
      periodicUpdateIntervalMs("startupAnd6h")!,
    );
    expect(mockedCheck).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("skips periodic and startup checks for manual updates", () => {
    expect(checksUpdatesOnStartup("manual")).toBe(false);
    expect(periodicUpdateIntervalMs("manual")).toBeNull();
    expect(periodicUpdateIntervalMs("startup")).toBeNull();
    expect(checksUpdatesOnStartup("startup")).toBe(true);
    expect(periodicUpdateIntervalMs("startupAnd12h")).toBe(12 * 60 * 60 * 1000);
    expect(periodicUpdateIntervalMs("startupAnd24h")).toBe(24 * 60 * 60 * 1000);
    const stop = startPeriodicUpdateCheck("manual");
    stop();
  });

  it("short-circuits checks when an update is already downloaded", async () => {
    useAppStore.getState().setUpdateReady("0.2.0");
    mockedConfirm.mockResolvedValueOnce(true);
    await expect(runUpdateSingleFlight()).resolves.toEqual({
      available: true,
      version: "0.2.0",
    });
    await checkUpdateInteractive();
    expect(mockedCheck).not.toHaveBeenCalled();
    expect(mockedConfirm).toHaveBeenCalledWith(
      "Update Ready",
      expect.stringContaining("0.2.0"),
    );
    expect(api.relaunch).toHaveBeenCalledTimes(1);
  });

  it("joins a background check that finds no update", async () => {
    let finishCheck!: (value: null) => void;
    mockedCheck.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCheck = resolve;
        }),
    );
    const background = runUpdateSingleFlight();
    await vi.waitFor(() => expect(mockedCheck).toHaveBeenCalledTimes(1));
    const interactive = checkUpdateInteractive();
    finishCheck(null);
    await expect(background).resolves.toEqual({ available: false });
    await interactive;
    expect(mockedMessage).toHaveBeenCalledWith(
      "Postal Snap",
      expect.stringContaining("latest version"),
    );
  });

  it("joins successful and failed background update downloads", async () => {
    let finishDownload!: () => void;
    const update = fakeUpdate(
      "0.2.1",
      () =>
        new Promise<void>((resolve) => {
          finishDownload = resolve;
        }),
    );
    mockedCheck.mockResolvedValueOnce(update as never);
    const background = runUpdateSingleFlight();
    await vi.waitFor(() => expect(finishDownload).toBeTypeOf("function"));
    const interactive = checkUpdateInteractive();
    finishDownload();
    await background;
    await interactive;
    expect(mockedConfirm).not.toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();
    expect(mockedMessage).toHaveBeenCalledWith(
      "Update Ready",
      expect.stringContaining("0.2.1"),
    );

    resetUpdateStateForTesting();
    let failCheck!: (cause: Error) => void;
    mockedCheck.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failCheck = reject;
        }),
    );
    const failingBackground = runUpdateSingleFlight();
    await vi.waitFor(() => expect(failCheck).toBeTypeOf("function"));
    const failingInteractive = checkUpdateInteractive();
    failCheck(new Error("background failed"));
    await expect(failingBackground).rejects.toThrow("background failed");
    await failingInteractive;
    expect(mockedMessage).toHaveBeenLastCalledWith(
      "Check for Updates",
      expect.any(String),
    );
  });

  it("serializes overlapping interactive checks", async () => {
    let finishCheck!: (value: null) => void;
    mockedCheck.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCheck = resolve;
        }),
    );
    const first = checkUpdateInteractive();
    await vi.waitFor(() => expect(mockedCheck).toHaveBeenCalledTimes(1));
    const second = checkUpdateInteractive();
    finishCheck(null);
    await Promise.all([first, second]);
    expect(mockedCheck).toHaveBeenCalledTimes(2);
    expect(mockedMessage).toHaveBeenCalledTimes(2);
  });

  it("does not intercept window close until an update is ready", async () => {
    document.documentElement.dataset.platform = "windows";
    const stop = startDeferredUpdateOnQuit();
    await Promise.resolve();
    expect(onCloseRequested).not.toHaveBeenCalled();
    stop();
  });

  it("attaches a close interceptor after a quiet download", async () => {
    document.documentElement.dataset.platform = "linux";
    const stop = startDeferredUpdateOnQuit();
    await Promise.resolve();
    expect(onCloseRequested).not.toHaveBeenCalled();

    const update = fakeUpdate("0.2.1");
    mockedCheck.mockResolvedValue(update as never);
    await runUpdateSingleFlight();
    await vi.waitFor(() => expect(onCloseRequested).toHaveBeenCalled());
    stop();
  });

  it("installs on Windows close after a quiet download", async () => {
    document.documentElement.dataset.platform = "windows";
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings,
        closeToTray: false,
      },
    });
    const update = fakeUpdate("0.2.2");
    mockedCheck.mockResolvedValue(update as never);
    await runUpdateSingleFlight();

    let closeHandler:
      ((event: { preventDefault: () => void }) => Promise<void>) | undefined;
    onCloseRequested.mockImplementation(async (handler) => {
      closeHandler = handler;
      return vi.fn();
    });
    const stop = startDeferredUpdateOnQuit();
    await vi.waitFor(() => expect(onCloseRequested).toHaveBeenCalled());
    const preventDefault = vi.fn();
    await closeHandler?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(update.install).toHaveBeenCalledTimes(1);
    expect(api.relaunch).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not install a quiet update when Windows close hides to the tray", async () => {
    document.documentElement.dataset.platform = "windows";
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings,
        closeToTray: true,
      },
    });
    const update = fakeUpdate("0.2.5");
    mockedCheck.mockResolvedValue(update as never);
    await runUpdateSingleFlight();

    let closeHandler:
      ((event: { preventDefault: () => void }) => Promise<void>) | undefined;
    onCloseRequested.mockImplementation(async (handler) => {
      closeHandler = handler;
      return vi.fn();
    });
    const stop = startDeferredUpdateOnQuit();
    await vi.waitFor(() => expect(onCloseRequested).toHaveBeenCalled());
    const preventDefault = vi.fn();
    await closeHandler?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(update.install).not.toHaveBeenCalled();
    expect(api.relaunch).not.toHaveBeenCalled();
    stop();
  });

  it("installs a quiet update when Windows close-to-tray is on but the tray icon is missing", async () => {
    document.documentElement.dataset.platform = "windows";
    vi.mocked(api.trayIsActive).mockResolvedValue(false);
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings,
        closeToTray: true,
      },
    });
    const update = fakeUpdate("0.2.7");
    mockedCheck.mockResolvedValue(update as never);
    await runUpdateSingleFlight();

    let closeHandler:
      ((event: { preventDefault: () => void }) => Promise<void>) | undefined;
    onCloseRequested.mockImplementation(async (handler) => {
      closeHandler = handler;
      return vi.fn();
    });
    const stop = startDeferredUpdateOnQuit();
    await vi.waitFor(() => expect(onCloseRequested).toHaveBeenCalled());
    const preventDefault = vi.fn();
    await closeHandler?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(update.install).toHaveBeenCalledTimes(1);
    expect(api.relaunch).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not intercept macOS window close", async () => {
    document.documentElement.dataset.platform = "macos";
    const stop = startDeferredUpdateOnQuit();
    await Promise.resolve();
    expect(onCloseRequested).not.toHaveBeenCalled();
    stop();
  });

  it("keeps the window open when a quiet install fails", async () => {
    document.documentElement.dataset.platform = "linux";
    const update = fakeUpdate("0.2.3", undefined, () =>
      Promise.reject(new Error("installer busy")),
    );
    mockedCheck.mockResolvedValue(update as never);
    await runUpdateSingleFlight();

    let closeHandler:
      ((event: { preventDefault: () => void }) => Promise<void>) | undefined;
    onCloseRequested.mockImplementation(async (handler) => {
      closeHandler = handler;
      return vi.fn();
    });
    const stop = startDeferredUpdateOnQuit();
    await vi.waitFor(() => expect(onCloseRequested).toHaveBeenCalled());
    const preventDefault = vi.fn();
    await closeHandler?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(api.relaunch).not.toHaveBeenCalled();
    expect(mockedMessage).toHaveBeenCalledWith(
      "Update Failed",
      expect.any(String),
    );
    stop();
  });

  it("applies a pending package from Settings restart", async () => {
    const update = fakeUpdate("0.2.4");
    mockedCheck.mockResolvedValue(update as never);
    await runUpdateSingleFlight();
    await applyPendingUpdate();
    expect(update.install).toHaveBeenCalledTimes(1);
    expect(api.relaunch).toHaveBeenCalledTimes(1);
  });

  it("quits from the tray when no update is ready", async () => {
    await quitOrApplyPendingUpdate();
    expect(api.quitApp).toHaveBeenCalledTimes(1);
    expect(api.relaunch).not.toHaveBeenCalled();
  });

  it("applies a pending update instead of quitting from the tray", async () => {
    const update = fakeUpdate("0.2.6");
    mockedCheck.mockResolvedValue(update as never);
    await runUpdateSingleFlight();
    await quitOrApplyPendingUpdate();
    expect(update.install).toHaveBeenCalledTimes(1);
    expect(api.relaunch).toHaveBeenCalledTimes(1);
    expect(api.quitApp).not.toHaveBeenCalled();
  });
});
