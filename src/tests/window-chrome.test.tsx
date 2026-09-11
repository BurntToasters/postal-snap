import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({ inTauri: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { inTauri } from "../api";
import { WindowChrome } from "../components/WindowChrome";
import { strings } from "../i18n";
import { useAppStore } from "../store";
import { resetStore } from "./helpers/store";

const mockedInTauri = vi.mocked(inTauri);
const mockedInvoke = vi.mocked(invoke);
const mockedListen = vi.mocked(listen);
const mockedGetCurrentWindow = vi.mocked(getCurrentWindow);

function makeWindow() {
  return {
    isMaximized: vi.fn().mockResolvedValue(false),
    isFullscreen: vi.fn().mockResolvedValue(false),
    minimize: vi.fn().mockResolvedValue(undefined),
    setFullscreen: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    onResized: vi.fn().mockResolvedValue(vi.fn()),
  };
}

describe("custom window chrome", () => {
  beforeEach(() => {
    resetStore();
    mockedInTauri.mockReturnValue(true);
    mockedInvoke.mockReset();
    mockedListen.mockReset();
    delete document.documentElement.dataset.platform;
    delete document.documentElement.dataset.windowFullscreen;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stays hidden in a normal browser", () => {
    mockedInTauri.mockReturnValue(false);
    const { container } = render(<WindowChrome />);
    expect(container).toBeEmptyDOMElement();
    expect(mockedGetCurrentWindow).not.toHaveBeenCalled();
  });

  it("runs caption actions, tracks resize state, and reports failures", async () => {
    document.documentElement.dataset.platform = "linux";
    const appWindow = makeWindow();
    let resized: (() => void) | undefined;
    const stopResize = vi.fn();
    appWindow.onResized.mockImplementation(async (handler) => {
      resized = handler;
      return stopResize;
    });
    mockedGetCurrentWindow.mockReturnValue(appWindow as never);
    const { unmount } = render(<WindowChrome />);

    await waitFor(() => expect(appWindow.isMaximized).toHaveBeenCalled());
    fireEvent.click(
      screen.getByRole("button", { name: strings.window.minimize }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.window.maximize }),
    );
    fireEvent.click(screen.getByRole("button", { name: strings.window.close }));
    await waitFor(() => {
      expect(appWindow.minimize).toHaveBeenCalled();
      expect(appWindow.toggleMaximize).toHaveBeenCalled();
      expect(appWindow.close).toHaveBeenCalled();
    });

    appWindow.isMaximized.mockResolvedValue(true);
    resized?.();
    expect(
      await screen.findByRole("button", { name: strings.window.restore }),
    ).toBeVisible();
    appWindow.isFullscreen.mockResolvedValueOnce(true);
    fireEvent.click(
      screen.getByRole("button", { name: strings.window.restore }),
    );
    await waitFor(() =>
      expect(appWindow.setFullscreen).toHaveBeenCalledWith(false),
    );

    appWindow.minimize.mockRejectedValueOnce(new Error("native failure"));
    fireEvent.click(
      screen.getByRole("button", { name: strings.window.minimize }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toBe(strings.window.actionFailed),
    );
    unmount();
    expect(stopResize).toHaveBeenCalled();
  });

  it("reports Windows snap bounds, hover, and cleanup", async () => {
    document.documentElement.dataset.platform = "windows";
    const appWindow = makeWindow();
    mockedGetCurrentWindow.mockReturnValue(appWindow as never);
    let hover: ((event: { payload: boolean }) => void) | undefined;
    const stopHover = vi.fn();
    mockedListen.mockImplementation(async (_event, handler) => {
      hover = handler as (event: { payload: boolean }) => void;
      return stopHover;
    });
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    mockedInvoke.mockResolvedValue(undefined);

    const { unmount } = render(<WindowChrome />);
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("set_snap_overlay_bounds", {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      }),
    );
    hover?.({ payload: true });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: strings.window.maximize }),
      ).toHaveClass("snap-hover"),
    );

    unmount();
    expect(stopHover).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
    expect(mockedInvoke).toHaveBeenLastCalledWith("set_snap_overlay_bounds", {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });

  it("drops late resize and hover subscriptions after unmount", async () => {
    document.documentElement.dataset.platform = "windows";
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    const appWindow = makeWindow();
    let finishResize: (stop: () => void) => void = () => undefined;
    const stopResize = vi.fn();
    appWindow.onResized.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishResize = resolve;
        }),
    );
    appWindow.isMaximized.mockRejectedValue(new Error("state unavailable"));
    mockedGetCurrentWindow.mockReturnValue(appWindow as never);
    mockedListen.mockRejectedValue(new Error("hover unavailable"));
    mockedInvoke.mockRejectedValue(new Error("overlay unavailable"));
    const { unmount } = render(<WindowChrome />);
    unmount();
    finishResize(stopResize);
    await waitFor(() => expect(stopResize).toHaveBeenCalled());
    expect(useAppStore.getState().error).toBeUndefined();
  });
});
