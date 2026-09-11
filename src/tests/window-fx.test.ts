import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { supportsWorkspaceWindowFx, syncWorkspaceWindowFx } from "../window-fx";

const mockedInvoke = vi.mocked(invoke);

describe("native window effects", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    delete document.documentElement.dataset.windowFx;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports native support and safely handles probe failures", async () => {
    mockedInvoke.mockResolvedValueOnce(true);
    await expect(supportsWorkspaceWindowFx()).resolves.toBe(true);
    expect(mockedInvoke).toHaveBeenCalledWith("supports_workspace_window_fx");

    mockedInvoke.mockRejectedValueOnce(new Error("not desktop"));
    await expect(supportsWorkspaceWindowFx()).resolves.toBe(false);
  });

  it("syncs native effects and reacts to accessibility preferences", async () => {
    let reduced = false;
    const listeners = new Map<string, () => void>();
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches:
          query === "(prefers-reduced-transparency: reduce)" ? reduced : false,
        addEventListener: vi.fn((_type: string, listener: () => void) => {
          listeners.set(query, listener);
        }),
      })),
    );
    mockedInvoke.mockImplementation(async (command, args) => {
      if (command === "supports_workspace_window_fx") return true;
      return (args as { enabled: boolean }).enabled;
    });

    await syncWorkspaceWindowFx(true, true);
    expect(document.documentElement.dataset.windowFx).toBe("vibrant");
    expect(mockedInvoke).toHaveBeenCalledWith("set_workspace_window_fx", {
      enabled: true,
      dark: true,
    });

    reduced = true;
    listeners.get("(prefers-reduced-transparency: reduce)")?.();
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenLastCalledWith("set_workspace_window_fx", {
        enabled: false,
        dark: true,
      }),
    );
    expect(document.documentElement.dataset.windowFx).toBe("opaque");
  });

  it("falls back to opaque when applying the native effect fails", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener: vi.fn() })),
    );
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "supports_workspace_window_fx") return true;
      throw new Error("native effect unavailable");
    });

    await syncWorkspaceWindowFx(true, false);
    expect(document.documentElement.dataset.windowFx).toBe("opaque");
  });
});
