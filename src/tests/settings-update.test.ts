import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("0.4.3"),
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
    prepareUpdateRelaunch: vi.fn().mockResolvedValue(undefined),
    clearUpdateRelaunch: vi.fn().mockResolvedValue(undefined),
    setUpdateReady: vi.fn().mockResolvedValue(undefined),
    backgroundUpdateAllowed: vi.fn().mockResolvedValue(false),
    onBackgroundUpdateDue: vi.fn().mockResolvedValue(() => undefined),
    onUpdateCheckDue: vi.fn().mockResolvedValue(() => undefined),
    markUpdateChecked: vi.fn().mockResolvedValue(undefined),
    scheduleBackgroundUpdate: vi.fn().mockResolvedValue(undefined),
    distribution: vi.fn().mockResolvedValue({ updatesManagedBy: "postalSnap" }),
    getBetaUpdaterTarget: vi.fn().mockResolvedValue("darwin-beta"),
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
  promptToRestartForUpdate,
  removeUpdateFoundListener,
  resetUpdateStateForTesting,
  runUpdateSingleFlight,
  discardPendingUpdate,
  onUpdateChannelChanged,
  setBetaRetryDelayForTesting,
  quitOrApplyPendingUpdate,
  startDeferredUpdateOnQuit,
  startPeriodicUpdateCheck,
  windowWouldHideInsteadOfQuit,
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

describe("update channel", () => {
  beforeEach(() => {
    resetUpdateStateForTesting();
    mockedCheck.mockReset();
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, updateChannel: "auto" },
    });
  });

  it("does not mark an update ready when the channel changes mid-check", async () => {
    let finishDownload: () => void = () => undefined;
    mockedCheck
      .mockResolvedValueOnce(
        fakeUpdate(
          "0.5.0-beta.1",
          () => new Promise<void>((resolve) => (finishDownload = resolve)),
        ) as never,
      )
      .mockResolvedValueOnce(null);
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, updateChannel: "beta" },
    });
    const task = runUpdateSingleFlight();
    await vi.waitFor(() => expect(mockedCheck).toHaveBeenCalledTimes(1));
    expect(mockedCheck).toHaveBeenCalledWith({ target: "darwin-beta" });
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, updateChannel: "stable" },
    });
    finishDownload();
    expect(await task).toEqual({ available: false });
    expect(useAppStore.getState().updateReady).toBeNull();
  });
});

describe("update polish (0.4.3)", () => {
  beforeEach(() => {
    resetUpdateStateForTesting();
    mockedCheck.mockReset();
    mockedMessage.mockReset();
    mockedConfirm.mockReset();
    setBetaRetryDelayForTesting(0);
    vi.mocked(api.distribution).mockResolvedValue({
      updatesManagedBy: "postalSnap",
    } as never);
    setChannel("beta");
  });

  function setChannel(updateChannel: "auto" | "stable" | "beta") {
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, updateChannel },
    });
  }

  it("P1 retries a beta check once after a throw", async () => {
    mockedCheck
      .mockRejectedValueOnce(new Error("404"))
      .mockResolvedValueOnce(fakeUpdate("0.5.0-beta.2") as never);
    expect(await runUpdateSingleFlight()).toEqual({
      available: true,
      version: "0.5.0-beta.2",
    });
    expect(mockedCheck).toHaveBeenCalledTimes(2);
  });

  it("P1 retries a beta check once after an empty answer", async () => {
    mockedCheck
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(fakeUpdate("0.5.0-beta.2") as never);
    expect((await runUpdateSingleFlight()).available).toBe(true);
    expect(mockedCheck).toHaveBeenCalledTimes(2);
  });

  it("P1 gives up after the one retry", async () => {
    mockedCheck.mockRejectedValue(new Error("404"));
    await expect(runUpdateSingleFlight()).rejects.toThrow("404");
    expect(mockedCheck).toHaveBeenCalledTimes(2);
  });

  it("P2 never retries on stable", async () => {
    setChannel("stable");
    mockedCheck.mockResolvedValue(null);
    expect(await runUpdateSingleFlight()).toEqual({ available: false });
    expect(mockedCheck).toHaveBeenCalledTimes(1);
    resetUpdateStateForTesting();
    mockedCheck.mockClear();
    mockedCheck.mockRejectedValue(new Error("offline"));
    await expect(runUpdateSingleFlight()).rejects.toThrow("offline");
    expect(mockedCheck).toHaveBeenCalledTimes(1);
  });

  it("P3 closes a discarded ready update and survives a close error", async () => {
    const update = { ...fakeUpdate("0.5.0-beta.2"), close: vi.fn() };
    update.close.mockRejectedValue(new Error("gone"));
    mockedCheck.mockResolvedValue(update as never);
    await runUpdateSingleFlight();
    expect(useAppStore.getState().updateReady).toBe("0.5.0-beta.2");
    discardPendingUpdate();
    expect(update.close).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().updateReady).toBeNull();
    discardPendingUpdate();
    expect(update.close).toHaveBeenCalledTimes(1);
  });

  it("P3 closes a stale download and re-runs on the new channel", async () => {
    const stale = { ...fakeUpdate("0.5.0-beta.2"), close: vi.fn() };
    stale.download.mockImplementation(async () => setChannel("stable"));
    const fresh = fakeUpdate("0.4.4");
    mockedCheck
      .mockResolvedValueOnce(stale as never)
      .mockResolvedValueOnce(fresh as never);
    const found: Array<string | undefined> = [];
    const result = await runUpdateSingleFlight((v) => found.push(v));
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ available: true, version: "0.4.4" });
    expect(mockedCheck).toHaveBeenNthCalledWith(2);
  });

  it("P4 a stale result is never reported as up to date", async () => {
    const stale = { ...fakeUpdate("0.5.0-beta.2"), close: vi.fn() };
    stale.download.mockImplementation(async () => setChannel("stable"));
    mockedCheck
      .mockResolvedValueOnce(stale as never)
      .mockResolvedValueOnce(fakeUpdate("0.4.4") as never);
    await checkUpdateInteractive();
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(mockedMessage).not.toHaveBeenCalled();
    expect(mockedConfirm).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().updateReady).toBe("0.4.4");
  });

  it("P4 says so when the channel keeps changing", async () => {
    const make = () => {
      const u = { ...fakeUpdate("0.5.0-beta.2"), close: vi.fn() };
      u.download.mockImplementation(async () =>
        setChannel(currentCh() === "stable" ? "beta" : "stable"),
      );
      return u;
    };
    const currentCh = () => useAppStore.getState().settings.updateChannel;
    const first = make();
    mockedCheck
      .mockResolvedValueOnce(first as never)
      .mockResolvedValueOnce(make() as never);
    await checkUpdateInteractive();
    expect(mockedCheck).toHaveBeenCalledTimes(2);
    expect(mockedConfirm).not.toHaveBeenCalled();
    expect(mockedMessage).toHaveBeenCalledWith(
      "Check for Updates",
      "Update channel changed. Check again.",
    );
  });

  it("only announces a version once the channel is confirmed", async () => {
    const stale = { ...fakeUpdate("0.5.0-beta.2"), close: vi.fn() };
    stale.download.mockImplementation(async () => setChannel("stable"));
    mockedCheck
      .mockResolvedValueOnce(stale as never)
      .mockResolvedValueOnce(null);
    const found: Array<string | undefined> = [];
    await runUpdateSingleFlight((v) => found.push(v));
    expect(found).toEqual(["0.5.0-beta.2"]);
    expect(mockedCheck).toHaveBeenCalledTimes(2);
  });

  it("onUpdateChannelChanged discards and checks the new target", async () => {
    mockedCheck.mockResolvedValue(null);
    setChannel("stable");
    onUpdateChannelChanged();
    await vi.waitFor(() => expect(mockedCheck).toHaveBeenCalledTimes(1));
    expect(mockedCheck).toHaveBeenCalledWith();
  });
});

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
    vi.mocked(api.onUpdateCheckDue).mockClear();
    vi.mocked(api.markUpdateChecked).mockClear();
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

  it("offers Restart Now or Later after downloading a found update", async () => {
    const update = fakeUpdate("0.1.4");
    mockedCheck.mockResolvedValue(update as never);
    mockedConfirm.mockResolvedValueOnce(false);

    await checkUpdateInteractive();

    expect(mockedConfirm).toHaveBeenCalledWith(
      "Update Ready",
      expect.stringContaining("0.1.4"),
      { ok: "Restart Now", cancel: "Later" },
    );
    expect(update.download).toHaveBeenCalledTimes(1);
    expect(update.install).not.toHaveBeenCalled();
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(api.relaunch).not.toHaveBeenCalled();
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

  it("runs periodic checks when Rust reports one is due", async () => {
    mockedCheck.mockResolvedValue(null);
    let due: (() => void) | undefined;
    const unlisten = vi.fn();
    vi.mocked(api.onUpdateCheckDue).mockImplementationOnce(async (handler) => {
      due = handler;
      return unlisten;
    });
    const stop = startPeriodicUpdateCheck("startupAnd6h");
    await vi.waitFor(() => expect(due).toBeDefined());
    due!();
    await vi.waitFor(() => expect(mockedCheck).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(api.markUpdateChecked).toHaveBeenCalled());
    stop();
    expect(unlisten).toHaveBeenCalled();
  });

  it("skips periodic and startup checks for manual updates", () => {
    expect(checksUpdatesOnStartup("manual")).toBe(false);
    expect(checksUpdatesOnStartup("startup")).toBe(true);
    // Rust owns the periodic cadence; these never listen for it.
    startPeriodicUpdateCheck("manual")();
    startPeriodicUpdateCheck("startup")();
    expect(api.onUpdateCheckDue).not.toHaveBeenCalled();
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
      { ok: "Restart Now", cancel: "Later" },
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
    // Declined (Later): the joined download is offered but not installed.
    expect(mockedConfirm).toHaveBeenCalledWith(
      "Update Ready",
      expect.stringContaining("0.2.1"),
      { ok: "Restart Now", cancel: "Later" },
    );
    expect(update.install).not.toHaveBeenCalled();

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
    expect(update.install).toHaveBeenCalledWith({ restartAfterInstall: false });
    expect(api.relaunch).not.toHaveBeenCalled();
    expect(api.quitApp).toHaveBeenCalledTimes(1);
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
    expect(update.install).toHaveBeenCalledWith({ restartAfterInstall: false });
    expect(api.relaunch).not.toHaveBeenCalled();
    expect(api.quitApp).toHaveBeenCalledTimes(1);
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
    expect(api.prepareUpdateRelaunch).toHaveBeenCalledWith("window");
    expect(update.install).toHaveBeenCalledWith({ restartAfterInstall: true });
    expect(api.relaunch).toHaveBeenCalledTimes(1);
  });

  it("quits from the tray when no update is ready", async () => {
    await quitOrApplyPendingUpdate();
    expect(api.quitApp).toHaveBeenCalledTimes(1);
    expect(api.relaunch).not.toHaveBeenCalled();
  });

  it("installs a pending update without relaunching when quitting from the tray", async () => {
    const update = fakeUpdate("0.2.6");
    mockedCheck.mockResolvedValue(update as never);
    await runUpdateSingleFlight();
    await quitOrApplyPendingUpdate();
    expect(update.install).toHaveBeenCalledWith({ restartAfterInstall: false });
    expect(api.relaunch).not.toHaveBeenCalled();
    expect(api.quitApp).toHaveBeenCalledTimes(1);
  });

  it("hides to tray only on macOS or an active Windows tray", async () => {
    await expect(
      windowWouldHideInsteadOfQuit({ closeToTray: false }, "windows"),
    ).resolves.toBe(false);
    await expect(
      windowWouldHideInsteadOfQuit({ closeToTray: true }, "linux"),
    ).resolves.toBe(false);
    await expect(
      windowWouldHideInsteadOfQuit({ closeToTray: true }, "macos"),
    ).resolves.toBe(true);
    vi.mocked(api.trayIsActive).mockRejectedValueOnce(new Error("tray down"));
    await expect(
      windowWouldHideInsteadOfQuit({ closeToTray: true }, "windows"),
    ).resolves.toBe(false);
    vi.mocked(api.trayIsActive).mockResolvedValueOnce(true);
    await expect(
      windowWouldHideInsteadOfQuit({ closeToTray: true }, "windows"),
    ).resolves.toBe(true);
  });

  it("skips periodic checks while an update is already ready", async () => {
    useAppStore.getState().setUpdateReady("0.3.0");
    let due: (() => void) | undefined;
    vi.mocked(api.onUpdateCheckDue).mockImplementationOnce(async (handler) => {
      due = handler;
      return () => undefined;
    });
    const stop = startPeriodicUpdateCheck("startupAnd6h");
    await vi.waitFor(() => expect(due).toBeDefined());
    due!();
    await Promise.resolve();
    expect(mockedCheck).not.toHaveBeenCalled();
    stop();
  });
});
