import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../window-fx", () => ({
  syncWorkspaceWindowFx: vi.fn(),
}));

import { applySettings } from "../settings";
import { defaultSettings } from "../store";
import { syncWorkspaceWindowFx } from "../window-fx";

const mockedSyncWorkspaceWindowFx = vi.mocked(syncWorkspaceWindowFx);

describe("settings appearance", () => {
  beforeEach(() => {
    mockedSyncWorkspaceWindowFx.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps native window effects in sync with system appearance changes", () => {
    let dark = false;
    let themeListener: (() => void) | undefined;
    const removeEventListener = vi.fn();
    const media = {
      get matches() {
        return dark;
      },
      media: "(prefers-color-scheme: dark)",
      onchange: null,
      addEventListener: vi.fn((_type: string, listener: () => void) => {
        themeListener = listener;
      }),
      removeEventListener,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    } as unknown as MediaQueryList;
    vi.stubGlobal("matchMedia", vi.fn(() => media));

    applySettings({
      ...defaultSettings,
      theme: "system",
      windowEffects: true,
    });
    expect(mockedSyncWorkspaceWindowFx).toHaveBeenLastCalledWith(true, false);

    dark = true;
    themeListener?.();
    expect(mockedSyncWorkspaceWindowFx).toHaveBeenLastCalledWith(true, true);

    applySettings({ ...defaultSettings, theme: "light", windowEffects: true });
    expect(removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
    expect(mockedSyncWorkspaceWindowFx).toHaveBeenLastCalledWith(true, false);
  });
});
