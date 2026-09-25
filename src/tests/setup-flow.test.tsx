import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SetupFlow } from "../components/SetupFlow";
import { defaultSettings, useAppStore } from "../store";
import { mockSaveSettingsPassthrough } from "./helpers/api-mocks";
import { resetStore } from "./helpers/store";

vi.mock("../api", () => ({
  api: {
    addAccount: vi.fn(),
    getSettings: vi.fn(),
    saveSettings: vi.fn((settings: unknown) => Promise.resolve(settings)),
    openHelpUrl: vi.fn(),
  },
}));

vi.mock("../components/SetupWizard", () => ({
  SetupWizard: ({ onComplete }: { onComplete: () => Promise<void> }) => (
    <button type="button" onClick={() => void onComplete()}>
      Mock connect account
    </button>
  ),
}));

import { api } from "../api";

const saveSettings = vi.mocked(api.saveSettings);

function resetSetupStore() {
  resetStore({
    accounts: [],
    activeAccountId: undefined,
    mailboxes: [],
    activeMailboxId: undefined,
    settings: { ...defaultSettings, setupCompleted: false, setupStep: null },
  });
}

describe("first-run setup flow", () => {
  beforeEach(() => {
    resetSetupStore();
    saveSettings.mockClear();
    mockSaveSettingsPassthrough();
  });

  it("walks Welcome -> Appearance -> Comfort -> Account in order", async () => {
    render(<SetupFlow onComplete={vi.fn()} startupNotice={null} />);
    expect(screen.getByText(/Welcome to Postal Snap/i)).toBeVisible();
    expect(document.querySelector(".setup-brand svg")).toBeNull();
    expect(document.querySelector(".setup-brand img.app-mark")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    expect(screen.getByText(/Choose how mail looks/i)).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    expect(screen.getByText(/Make it comfortable/i)).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    expect(screen.getByText(/Add your email/i)).toHaveFocus();
  });

  it("persists appearance choices live and keeps compact hit areas", async () => {
    render(<SetupFlow onComplete={vi.fn()} startupNotice={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    const spacing = screen.getByLabelText(/Interface spacing/i);
    fireEvent.change(spacing, { target: { value: "compact" } });
    await waitFor(() =>
      expect(useAppStore.getState().settings.density).toBe("compact"),
    );
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(saveSettings).toHaveBeenCalled();
  });

  it("defaults theme to Auto and live-updates preview on every choice", async () => {
    render(<SetupFlow onComplete={vi.fn()} startupNotice={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    const theme = screen.getByRole("combobox", {
      name: /Appearance/i,
    }) as HTMLSelectElement;
    expect(theme.value).toBe("system");
    expect(
      screen.getByRole("option", { name: /Auto \(System default\)/i }),
    ).toBeDefined();

    fireEvent.change(theme, { target: { value: "dark" } });
    await waitFor(() =>
      expect(useAppStore.getState().settings.theme).toBe("dark"),
    );
    expect(document.documentElement.dataset.theme).toBe("dark");

    const pane = screen.getByRole("combobox", { name: /Reading pane/i });
    fireEvent.change(pane, { target: { value: "bottom" } });
    await waitFor(() =>
      expect(useAppStore.getState().settings.readingPane).toBe("bottom"),
    );
    expect(screen.getByLabelText(/Inbox preview/i)).toHaveAttribute(
      "data-reading-pane",
      "bottom",
    );
    expect(screen.getByText(/Live preview/i)).toBeVisible();
  });

  it("never exposes reported-threat toggle in first-run comfort step", () => {
    render(<SetupFlow onComplete={vi.fn()} startupNotice={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    expect(screen.queryByText(/reported dangerous/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Block advertising and tracking images/i),
    ).toBeVisible();
  });

  it("marks setup complete on account connect", async () => {
    const onComplete = vi.fn(async () => undefined);
    render(<SetupFlow onComplete={onComplete} startupNotice={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /Mock connect account/i }),
    );
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ setupCompleted: true, setupStep: null }),
    );
  });

  it("shows restored-settings notice inside setup", () => {
    render(
      <SetupFlow
        onComplete={vi.fn()}
        startupNotice="Postal Snap found damaged settings and restored safe defaults."
      />,
    );
    expect(screen.getByText(/Damaged settings were restored/i)).toBeVisible();
  });

  it("persists every comfort toggle and supports back navigation", async () => {
    render(<SetupFlow onComplete={vi.fn()} startupNotice={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));

    fireEvent.change(screen.getByLabelText(/Interface spacing/i), {
      target: { value: "compact" },
    });
    fireEvent.change(screen.getByLabelText(/Text size/i), {
      target: { value: "1.5" },
    });
    expect(await screen.findByRole("status")).toHaveTextContent(/large text/i);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText(/Welcome to Postal Snap/i)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    const toggles = screen.getAllByRole("checkbox");
    for (const toggle of toggles) fireEvent.click(toggle);
    await waitFor(() => {
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ notifyNewMail: false }),
      );
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ privateNotifications: true }),
      );
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ groupThreads: false }),
      );
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ windowEffects: true }),
      );
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ blockAdvertisingAndTracking: false }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText(/Choose how mail looks/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    fireEvent.click(screen.getByRole("button", { name: /Back to setup/i }));
    expect(screen.getByText(/Make it comfortable/i)).toBeVisible();
  });

  it("lets Windows first-run setup keep the tray option on by default", async () => {
    document.documentElement.dataset.platform = "windows";
    render(<SetupFlow onComplete={vi.fn()} startupNotice={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    const tray = screen.getByRole("checkbox", {
      name: /Keep running in the notification area/,
    });
    expect(tray).toBeChecked();
    fireEvent.click(tray);
    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ closeToTray: false }),
      ),
    );
    delete document.documentElement.dataset.platform;
  });

  it("lets macOS first-run setup keep the menu bar option on by default", async () => {
    document.documentElement.dataset.platform = "macos";
    render(<SetupFlow onComplete={vi.fn()} startupNotice={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    const tray = screen.getByRole("checkbox", {
      name: /Keep running in the menu bar/,
    });
    expect(tray).toBeChecked();
    fireEvent.click(tray);
    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ closeToTray: false }),
      ),
    );
    delete document.documentElement.dataset.platform;
  });

  it("does not offer close-to-tray during Linux setup", () => {
    document.documentElement.dataset.platform = "linux";
    render(<SetupFlow onComplete={vi.fn()} startupNotice={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    expect(
      screen.queryByRole("checkbox", {
        name: /Keep running in the notification area/,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: /Keep running in the menu bar/ }),
    ).not.toBeInTheDocument();
    delete document.documentElement.dataset.platform;
  });

  it("keeps setup usable when a live preference save fails", async () => {
    saveSettings.mockImplementation(async (next) => {
      if (next.theme === "dark") throw new Error("offline");
      return next;
    });
    render(<SetupFlow onComplete={vi.fn()} startupNotice={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    fireEvent.change(screen.getByRole("combobox", { name: /Appearance/i }), {
      target: { value: "dark" },
    });
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not save that change",
      ),
    );
  });
});
