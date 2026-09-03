import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { supportsWorkspaceWindowFx, syncWorkspaceWindowFx } from "../window-fx";

const mockedInvoke = vi.mocked(invoke);

describe("window-fx", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    delete document.documentElement.dataset.windowFx;
  });

  it("detects support from backend IPC", async () => {
    mockedInvoke.mockResolvedValue(true);
    expect(await supportsWorkspaceWindowFx()).toBe(true);
    expect(mockedInvoke).toHaveBeenCalledWith("supports_workspace_window_fx");
  });

  it("handles IPC failure gracefully for support check", async () => {
    mockedInvoke.mockRejectedValue(new Error("Unsupported platform"));
    expect(await supportsWorkspaceWindowFx()).toBe(false);
  });

  it("enables vibrant window effects and sets data-window-fx attribute", async () => {
    mockedInvoke.mockImplementation(async (cmd) => {
      if (cmd === "supports_workspace_window_fx") return true;
      return undefined;
    });

    await syncWorkspaceWindowFx(true, true);
    expect(document.documentElement.dataset.windowFx).toBe("vibrant");
    expect(mockedInvoke).toHaveBeenCalledWith("set_workspace_window_fx", {
      enabled: true,
      dark: true,
    });
  });

  it("disables vibrancy and marks data-window-fx as opaque", async () => {
    mockedInvoke.mockImplementation(async (cmd) => {
      if (cmd === "supports_workspace_window_fx") return true;
      return undefined;
    });

    await syncWorkspaceWindowFx(false, false);
    expect(document.documentElement.dataset.windowFx).toBe("opaque");
    expect(mockedInvoke).toHaveBeenCalledWith("set_workspace_window_fx", {
      enabled: false,
      dark: false,
    });
  });
});
