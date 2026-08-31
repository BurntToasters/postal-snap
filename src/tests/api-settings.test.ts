import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { api } from "../api";
import type { AppSettings } from "../types";

const mockedInvoke = vi.mocked(invoke);

const settings = (theme: AppSettings["theme"]): AppSettings => ({
  schemaVersion: 2,
  readingPane: "right",
  textScale: 1,
  privateNotifications: false,
  theme,
  density: "comfortable",
  cachePolicy: { mode: "recent", days: 90, maxBytes: 1_073_741_824 },
  lastAccountId: null,
  lastMailboxId: null,
  folderPaneWidth: 248,
  messagePaneWidth: 390,
  readerPaneHeight: 360,
});

describe("settings IPC serialization", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  it("runs settings mutations in invocation order", async () => {
    const calls: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mockedInvoke.mockImplementation(async (command) => {
      calls.push(String(command));
      if (command === "save_settings" && calls.length === 1) await firstBlocked;
      return command === "save_settings" ? settings("dark") : undefined;
    });

    const first = api.saveSettings(settings("dark"));
    const second = api.saveSettings(settings("light"));
    await vi.waitFor(() => expect(calls).toEqual(["save_settings"]));
    releaseFirst();
    await Promise.all([first, second]);

    expect(calls).toEqual(["save_settings", "save_settings"]);
  });

  it("does not let a save queued behind import overwrite imported preferences", async () => {
    const calls: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const imported = settings("light");
    mockedInvoke.mockImplementation(async (command) => {
      calls.push(String(command));
      if (command === "save_settings" && calls.length === 1) await firstBlocked;
      if (command === "import_settings") return imported;
      if (command === "get_settings") return imported;
      return settings("dark");
    });

    const firstSave = api.saveSettings(settings("dark"));
    await vi.waitFor(() => expect(calls).toEqual(["save_settings"]));
    const importPromise = api.importSettings();
    const saveAfterImportRequest = api.saveSettings(settings("dark"));
    releaseFirst();
    await Promise.all([firstSave, importPromise, saveAfterImportRequest]);

    expect(calls).toEqual(["save_settings", "import_settings", "get_settings"]);
  });

  it("keeps a pending save when the import dialog is canceled", async () => {
    const calls: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mockedInvoke.mockImplementation(async (command) => {
      calls.push(String(command));
      if (command === "save_settings" && calls.length === 1) await firstBlocked;
      if (command === "import_settings") return null;
      return settings("dark");
    });

    const firstSave = api.saveSettings(settings("dark"));
    await vi.waitFor(() => expect(calls).toEqual(["save_settings"]));
    const importPromise = api.importSettings();
    const pendingSave = api.saveSettings(settings("light"));
    releaseFirst();
    await Promise.all([firstSave, importPromise, pendingSave]);

    expect(calls).toEqual([
      "save_settings",
      "import_settings",
      "save_settings",
    ]);
  });
});
