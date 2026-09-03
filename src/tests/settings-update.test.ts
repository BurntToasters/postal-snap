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
  },
}));

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { api } from "../api";
import {
  checkUpdateInteractive,
  removeUpdateFoundListener,
  resetUpdateStateForTesting,
  runUpdateSingleFlight,
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
    expect(runUpdateSingleFlight(lateListener)).toBe(task);
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
});
