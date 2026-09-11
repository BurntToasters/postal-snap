import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(),
}));

vi.mock("../api", () => ({
  api: {
    showNativeConfirm: vi.fn().mockResolvedValue(true),
    showNativeMessage: vi.fn().mockResolvedValue(undefined),
    relaunch: vi.fn().mockResolvedValue(undefined),
    distribution: vi.fn().mockResolvedValue({ updatesManagedBy: "postalSnap" }),
  },
}));

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { api } from "../api";
import { useAppStore } from "../store";
import {
  addUpdateFoundListener,
  checkUpdateInteractive,
  removeUpdateFoundListener,
  resetUpdateStateForTesting,
  runUpdateSingleFlight,
  startPeriodicUpdateCheck,
} from "../update";

const mockedCheck = vi.mocked(check);
const mockedRelaunch = vi.mocked(relaunch);
const mockedConfirm = vi.mocked(api.showNativeConfirm);
const mockedMessage = vi.mocked(api.showNativeMessage);

describe("update checks", () => {
  beforeEach(() => {
    resetUpdateStateForTesting();
    mockedCheck.mockReset();
    mockedRelaunch.mockReset();
    mockedConfirm.mockReset();
    mockedMessage.mockReset();
    vi.mocked(api.relaunch).mockClear();
    vi.mocked(api.distribution).mockResolvedValue({
      updatesManagedBy: "postalSnap",
    } as never);
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

  it("reports the version and downloads without auto-relaunching", async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    mockedCheck.mockResolvedValue({
      version: "0.1.2",
      downloadAndInstall,
    } as never);
    mockedRelaunch.mockResolvedValue(undefined);
    const onUpdateFound = vi.fn();

    await expect(runUpdateSingleFlight(onUpdateFound)).resolves.toEqual({
      available: true,
      version: "0.1.2",
    });
    expect(onUpdateFound).toHaveBeenCalledWith("0.1.2");
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(mockedRelaunch).not.toHaveBeenCalled();
  });

  it("allows an unmounted settings view to unsubscribe", async () => {
    type FakeUpdate = {
      version: string;
      downloadAndInstall: () => Promise<void>;
    };
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
    resolveCheck({
      version: "0.1.2",
      downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    });
    await task;
    expect(onUpdateFound).not.toHaveBeenCalled();
  });

  it("replays the installing state to a listener added during download", async () => {
    let finishDownload: () => void = () => undefined;
    const download = new Promise<void>((resolve) => {
      finishDownload = resolve;
    });
    mockedCheck.mockResolvedValue({
      version: "0.1.2",
      downloadAndInstall: () => download,
    } as never);
    mockedRelaunch.mockResolvedValue(undefined);
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

  it("prompts to download and then restart when update is found", async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    mockedCheck.mockResolvedValue({
      version: "0.1.4",
      downloadAndInstall,
    } as never);
    mockedConfirm.mockResolvedValue(true);

    await checkUpdateInteractive();

    expect(mockedConfirm).toHaveBeenCalledTimes(2);
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(api.relaunch).toHaveBeenCalledTimes(1);
  });

  it("does not download if user declines the download prompt", async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    mockedCheck.mockResolvedValue({
      version: "0.1.4",
      downloadAndInstall,
    } as never);
    mockedConfirm.mockResolvedValue(false);

    await checkUpdateInteractive();

    expect(mockedConfirm).toHaveBeenCalledTimes(1);
    expect(downloadAndInstall).not.toHaveBeenCalled();
    expect(mockedRelaunch).not.toHaveBeenCalled();
  });

  it("keeps update download alive when a listener throws", async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    mockedCheck.mockResolvedValue({
      version: "0.1.5",
      downloadAndInstall,
    } as never);
    const throwingListener = vi.fn(() => {
      throw new Error("view removed");
    });

    await expect(runUpdateSingleFlight(throwingListener)).resolves.toEqual({
      available: true,
      version: "0.1.5",
    });
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
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
    mockedCheck.mockResolvedValueOnce({
      version: "0.1.6",
      downloadAndInstall: vi.fn().mockRejectedValue(new Error("disk full")),
    } as never);
    mockedConfirm.mockResolvedValueOnce(true);
    await checkUpdateInteractive();
    expect(mockedMessage).toHaveBeenLastCalledWith(
      "Update Failed",
      expect.any(String),
    );
  });

  it("runs and stops periodic background checks", async () => {
    vi.useFakeTimers();
    mockedCheck.mockResolvedValue(null);
    const stop = startPeriodicUpdateCheck(1000);

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockedCheck).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockedCheck).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
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
    mockedCheck.mockResolvedValueOnce({
      version: "0.2.1",
      downloadAndInstall: () =>
        new Promise<void>((resolve) => {
          finishDownload = resolve;
        }),
    } as never);
    const background = runUpdateSingleFlight();
    await vi.waitFor(() => expect(finishDownload).toBeTypeOf("function"));
    const interactive = checkUpdateInteractive();
    finishDownload();
    await background;
    await interactive;
    expect(mockedConfirm).toHaveBeenCalledWith(
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
});
