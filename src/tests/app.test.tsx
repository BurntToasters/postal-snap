import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: vi.fn(),
  onOpenUrl: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
}));
vi.mock("../api", () => ({
  inTauri: vi.fn(),
  api: {
    listAccounts: vi.fn(),
    getSettings: vi.fn(),
    getStartupNotice: vi.fn(),
    getStartupError: vi.fn(),
    onSyncState: vi.fn(),
    onAppWarning: vi.fn(),
    onMenuAction: vi.fn(),
    setMailShortcutGuard: vi.fn(),
  },
}));
vi.mock("../settings", () => ({ applySettings: vi.fn() }));
vi.mock("../update", () => ({
  checkUpdateInteractive: vi.fn(),
  runUpdateSingleFlight: vi.fn(),
  startPeriodicUpdateCheck: vi.fn(),
}));
vi.mock("../components/WindowChrome", () => ({
  WindowChrome: () => <div data-testid="window-chrome" />,
}));
vi.mock("../components/MailShell", () => ({
  MailShell: ({ onOpenSettings }: { onOpenSettings: () => void }) => (
    <main>
      Mail shell
      <button onClick={onOpenSettings}>Open mocked settings</button>
    </main>
  ),
}));
vi.mock("../components/SetupFlow", () => ({
  SetupFlow: ({
    onComplete,
    onOpenSettings,
  }: {
    onComplete: () => Promise<void>;
    onOpenSettings: () => void;
  }) => (
    <main>
      Setup flow
      <button onClick={() => void onComplete()}>Complete flow</button>
      <button onClick={onOpenSettings}>Flow settings</button>
    </main>
  ),
}));
vi.mock("../components/SetupWizard", () => ({
  SetupWizard: ({
    onComplete,
    onOpenSettings,
  }: {
    onComplete: () => Promise<void>;
    onOpenSettings?: () => void;
  }) => (
    <main>
      Setup wizard
      <button onClick={() => void onComplete()}>Complete wizard</button>
      <button onClick={onOpenSettings}>Wizard settings</button>
    </main>
  ),
}));
vi.mock("../components/SettingsDialog", () => ({
  SettingsDialog: ({
    initialTab,
    onClose,
  }: {
    initialTab: string;
    onClose: () => void;
  }) => (
    <section className="settings-window">
      Settings {initialTab}
      <button onClick={onClose}>Close mocked settings</button>
    </section>
  ),
}));
vi.mock("../components/Composer", () => ({
  Composer: ({ accountId }: { accountId: string }) => (
    <div>Composer {accountId}</div>
  ),
}));

import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { api, inTauri } from "../api";
import App from "../App";
import { applySettings } from "../settings";
import { defaultSettings, useAppStore } from "../store";
import type { SyncState } from "../types";
import {
  checkUpdateInteractive,
  runUpdateSingleFlight,
  startPeriodicUpdateCheck,
} from "../update";
import { makeAccount } from "./helpers/fixtures";
import { resetStore } from "./helpers/store";

const account = makeAccount();
const cancelPeriodic = vi.fn();
const unlistenSync = vi.fn();
const unlistenWarning = vi.fn();
const unlistenMenu = vi.fn();
const unlistenUrls = vi.fn();
let syncHandler: ((payload: SyncState) => void) | undefined;
let warningHandler: ((payload: string) => void) | undefined;
let menuHandler: ((payload: string) => void) | undefined;
let urlHandler: ((urls: string[]) => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  vi.mocked(inTauri).mockReturnValue(true);
  vi.mocked(api.listAccounts).mockResolvedValue([account]);
  vi.mocked(api.getSettings).mockResolvedValue({
    ...defaultSettings,
    setupCompleted: true,
  });
  vi.mocked(api.getStartupNotice).mockResolvedValue(null);
  vi.mocked(api.getStartupError).mockResolvedValue(null);
  vi.mocked(api.onSyncState).mockImplementation(async (handler) => {
    syncHandler = handler;
    return unlistenSync;
  });
  vi.mocked(api.onAppWarning).mockImplementation(async (handler) => {
    warningHandler = handler;
    return unlistenWarning;
  });
  vi.mocked(api.onMenuAction).mockImplementation(async (handler) => {
    menuHandler = handler;
    return unlistenMenu;
  });
  vi.mocked(api.setMailShortcutGuard).mockResolvedValue(undefined);
  vi.mocked(getCurrent).mockResolvedValue(null);
  vi.mocked(onOpenUrl).mockImplementation(async (handler) => {
    urlHandler = handler;
    return unlistenUrls;
  });
  vi.mocked(isPermissionGranted).mockResolvedValue(false);
  vi.mocked(requestPermission).mockResolvedValue("granted");
  vi.mocked(runUpdateSingleFlight).mockResolvedValue({ available: false });
  vi.mocked(checkUpdateInteractive).mockResolvedValue(undefined);
  vi.mocked(startPeriodicUpdateCheck).mockReturnValue(cancelPeriodic);
});

describe("App lifecycle", () => {
  it("shows browser preview without native startup", () => {
    vi.mocked(inTauri).mockReturnValue(false);
    render(<App />);
    expect(screen.getByRole("heading", { name: "Postal Snap" })).toBeVisible();
    expect(screen.getByText(/connect native mail services/i)).toBeVisible();
    expect(api.listAccounts).not.toHaveBeenCalled();
  });

  it("loads native state, bridges events, shortcuts, deep links, and cleanup", async () => {
    vi.mocked(getCurrent).mockResolvedValue([
      "https://ignored.example/",
      "mailto:first@example.test?subject=Hello",
    ]);
    const dispatched: string[] = [];
    const capture = (event: Event) =>
      dispatched.push((event as CustomEvent<string>).detail ?? event.type);
    window.addEventListener("postal:menu-action", capture);
    window.addEventListener("postal:print-message", capture);

    const view = render(<App />);
    expect(screen.getByRole("status")).toHaveTextContent(/Opening Postal Snap/);
    expect(await screen.findByText("Mail shell")).toBeVisible();
    expect(applySettings).toHaveBeenCalled();
    expect(requestPermission).toHaveBeenCalled();
    expect(runUpdateSingleFlight).toHaveBeenCalled();
    expect(useAppStore.getState().composerOpen).toBe(true);
    expect(useAppStore.getState().composeSeed?.prefill?.to).toEqual([
      "first@example.test",
    ]);

    act(() => {
      syncHandler?.({ accountId: account.id, phase: "syncing" });
      warningHandler?.("Native warning");
      menuHandler?.("compose");
      menuHandler?.("check-for-updates");
      urlHandler?.(["mailto:second@example.test", "invalid:value"]);
    });
    expect(useAppStore.getState().sync[account.id]?.phase).toBe("syncing");
    expect(useAppStore.getState().error).toBe("Native warning");
    expect(checkUpdateInteractive).toHaveBeenCalled();
    expect(dispatched).toContain("compose");
    expect(useAppStore.getState().composeSeed?.prefill?.to).toEqual([
      "second@example.test",
    ]);

    fireEvent.keyDown(window, { key: "=", ctrlKey: true });
    fireEvent.keyDown(window, { key: "-", metaKey: true });
    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    expect(dispatched).toEqual(
      expect.arrayContaining([
        "text-larger",
        "text-smaller",
        "postal:print-message",
      ]),
    );
    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    expect(screen.getByText("Settings general")).toBeVisible();
    expect(document.querySelector(".app-viewport")).toHaveAttribute("inert");
    fireEvent.click(
      screen.getByRole("button", { name: "Close mocked settings" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open mocked settings" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Close mocked settings" }),
    );

    fireEvent.click(screen.getByRole("button", { name: /Dismiss error/i }));
    expect(screen.queryByText("Native warning")).not.toBeInTheDocument();
    fireEvent.focusIn(document.body);
    fireEvent.focusOut(document.body);
    expect(api.setMailShortcutGuard).toHaveBeenCalled();

    view.unmount();
    expect(cancelPeriodic).toHaveBeenCalled();
    expect(unlistenSync).toHaveBeenCalled();
    expect(unlistenWarning).toHaveBeenCalled();
    expect(unlistenMenu).toHaveBeenCalled();
    expect(unlistenUrls).toHaveBeenCalled();
    expect(api.setMailShortcutGuard).toHaveBeenLastCalledWith(false);
    window.removeEventListener("postal:menu-action", capture);
    window.removeEventListener("postal:print-message", capture);
  });

  it("opens a cold-start mailto once accounts finish loading", async () => {
    resetStore({
      accounts: [],
      activeAccountId: undefined,
      mailboxes: [],
      activeMailboxId: undefined,
    });
    let resolveAccounts: (value: (typeof account)[]) => void = () => undefined;
    vi.mocked(api.listAccounts).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAccounts = resolve;
        }),
    );
    vi.mocked(getCurrent).mockResolvedValue(["mailto:late@example.test"]);

    render(<App />);
    await waitFor(() =>
      expect(useAppStore.getState().pendingComposeSeed?.prefill?.to).toEqual([
        "late@example.test",
      ]),
    );
    expect(useAppStore.getState().composerOpen).toBe(false);

    await act(async () => {
      resolveAccounts([account]);
    });
    await waitFor(() => expect(useAppStore.getState().composerOpen).toBe(true));
    expect(useAppStore.getState().composeSeed?.prefill?.to).toEqual([
      "late@example.test",
    ]);
    expect(useAppStore.getState().pendingComposeSeed).toBeUndefined();
  });

  it("routes native menu settings and suppresses printing behind overlays", async () => {
    const print = vi.fn();
    window.addEventListener("postal:print-message", print);
    render(<App />);
    await screen.findByText("Mail shell");
    act(() => menuHandler?.("settings"));
    expect(screen.getByText("Settings general")).toBeVisible();
    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    expect(print).not.toHaveBeenCalled();
    window.removeEventListener("postal:print-message", print);
  });

  it("shows native startup recovery errors and opens Settings", async () => {
    vi.mocked(api.getStartupError).mockResolvedValue("Database could not open");
    render(<App />);
    expect(
      await screen.findByRole("heading", {
        name: /could not open your mail data/i,
      }),
    ).toBeVisible();
    expect(screen.getByText("Database could not open")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("Settings general")).toBeVisible();
  });

  it("falls back to recovery help when startup IPC rejects", async () => {
    vi.mocked(api.listAccounts).mockRejectedValue(new Error("native failed"));
    render(<App />);
    expect(
      await screen.findByRole("heading", {
        name: /could not open your mail data/i,
      }),
    ).toBeVisible();
  });

  it("routes incomplete setup and accountless setup independently", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({
      ...defaultSettings,
      setupCompleted: false,
    });
    const flow = render(<App />);
    expect(await screen.findByText("Setup flow")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Flow settings" }));
    expect(screen.getByText("Settings general")).toBeVisible();
    flow.unmount();

    vi.mocked(api.getSettings).mockResolvedValue({
      ...defaultSettings,
      setupCompleted: true,
    });
    vi.mocked(api.listAccounts).mockResolvedValue([]);
    render(<App />);
    expect(await screen.findByText("Setup wizard")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Wizard settings" }));
    expect(screen.getByText("Settings general")).toBeVisible();
  });

  it("surfaces startup notices and skips granted notification permission", async () => {
    vi.mocked(api.getStartupNotice).mockResolvedValue("Recovered preferences");
    vi.mocked(isPermissionGranted).mockResolvedValue(true);
    render(<App />);
    expect(await screen.findByText("Recovered preferences")).toBeVisible();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("swallows notification permission failures and dropped native listeners", async () => {
    vi.mocked(isPermissionGranted).mockRejectedValue(new Error("denied"));
    vi.mocked(getCurrent).mockRejectedValue(new Error("no urls"));
    let resolveSync: (value: () => void) => void = () => undefined;
    vi.mocked(api.onSyncState).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSync = resolve;
        }),
    );
    vi.mocked(api.onAppWarning).mockImplementation(
      () =>
        new Promise(() => {
          // Unmount before this listener arrives.
        }),
    );
    const { unmount } = render(<App />);
    expect(await screen.findByText("Mail shell")).toBeVisible();
    unmount();
    resolveSync(unlistenSync);
    await act(async () => {
      await Promise.resolve();
    });
    expect(unlistenSync).toHaveBeenCalled();
  });
});
