import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { AboutTab } from "../components/settings/aboutTab";
import { AdvancedTab } from "../components/settings/advancedTab";
import { NotificationsTab } from "../components/settings/notificationsTab";
import { editionName, formatBytes } from "../components/settings/primitives";
import { ReadingTab } from "../components/settings/readingTab";
import { ShortcutsTab } from "../components/settings/shortcutsTab";
import { UpdatesTab } from "../components/settings/updatesTab";
import { strings } from "../i18n";
import { defaultSettings, useAppStore } from "../store";
import { resetStore } from "./helpers/store";

beforeEach(() => {
  resetStore({ updateReady: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete document.documentElement.dataset.platform;
});

describe("small settings tabs", () => {
  it("opens project and license pages from About", () => {
    const inspectExternalUrl = vi
      .spyOn(api, "inspectExternalUrl")
      .mockImplementation(async (url) => ({
        url,
        hostname: new URL(url).hostname,
        reportedThreat: false,
      }));
    const openExternalUrl = vi
      .spyOn(api, "openExternalUrl")
      .mockResolvedValue(undefined);
    vi.spyOn(api, "showNativeConfirm").mockResolvedValue(true);
    render(<AboutTab />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.settings.aboutSource }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.settings.aboutLicense }),
    );
    return waitFor(() => {
      expect(inspectExternalUrl.mock.calls).toEqual([
        ["https://github.com/BurntToasters/postal-snap"],
        ["https://www.mozilla.org/MPL/2.0/"],
      ]);
      expect(openExternalUrl.mock.calls).toEqual([
        ["https://github.com/BurntToasters/postal-snap", false],
        ["https://www.mozilla.org/MPL/2.0/", false],
      ]);
    });
  });

  it("does not open an About link when confirmation is canceled", async () => {
    vi.spyOn(api, "inspectExternalUrl").mockResolvedValue({
      url: "https://github.com/BurntToasters/postal-snap",
      hostname: "github.com",
      reportedThreat: false,
    });
    const openExternalUrl = vi
      .spyOn(api, "openExternalUrl")
      .mockResolvedValue(undefined);
    vi.spyOn(api, "showNativeConfirm").mockResolvedValue(false);
    render(<AboutTab />);

    fireEvent.click(
      screen.getByRole("button", { name: strings.settings.aboutSource }),
    );

    await waitFor(() => expect(openExternalUrl).not.toHaveBeenCalled());
  });

  it("requires both confirmations before opening a reported About link", async () => {
    vi.spyOn(api, "inspectExternalUrl").mockResolvedValue({
      url: "https://github.com/BurntToasters/postal-snap",
      hostname: "github.com",
      reportedThreat: true,
    });
    const showNativeConfirm = vi
      .spyOn(api, "showNativeConfirm")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const openExternalUrl = vi
      .spyOn(api, "openExternalUrl")
      .mockResolvedValue(undefined);
    render(<AboutTab />);

    fireEvent.click(
      screen.getByRole("button", { name: strings.settings.aboutSource }),
    );

    await waitFor(() => {
      expect(showNativeConfirm).toHaveBeenCalledTimes(2);
      expect(openExternalUrl).toHaveBeenCalledWith(
        "https://github.com/BurntToasters/postal-snap",
        true,
      );
    });
  });

  it("does not surface or open links when inspection is rejected", async () => {
    vi.spyOn(api, "inspectExternalUrl").mockRejectedValue(
      new Error("inspection failed"),
    );
    const showNativeConfirm = vi.spyOn(api, "showNativeConfirm");
    const openExternalUrl = vi
      .spyOn(api, "openExternalUrl")
      .mockResolvedValue(undefined);
    render(<AboutTab />);

    fireEvent.click(
      screen.getByRole("button", { name: strings.settings.aboutSource }),
    );

    await waitFor(() => expect(openExternalUrl).not.toHaveBeenCalled());
    expect(showNativeConfirm).not.toHaveBeenCalled();
  });

  it("updates both notification preferences", () => {
    const update = vi.fn().mockResolvedValue(defaultSettings);
    render(<NotificationsTab update={update} />);
    const toggles = screen.getAllByRole("checkbox");
    fireEvent.click(toggles[0]);
    fireEvent.click(toggles[1]);
    expect(update.mock.calls).toEqual([
      [{ notifyNewMail: false }],
      [{ privateNotifications: true }],
    ]);
  });

  it("updates reading pane, text size, and thread grouping", () => {
    const update = vi.fn().mockResolvedValue(defaultSettings);
    render(<ReadingTab update={update} />);
    fireEvent.change(
      screen.getByRole("combobox", { name: strings.settings.readingPane }),
      { target: { value: "bottom" } },
    );
    fireEvent.change(
      screen.getByRole("combobox", { name: strings.settings.textSize }),
      { target: { value: "1.5" } },
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(update.mock.calls).toEqual([
      [{ readingPane: "bottom" }],
      [{ textScale: 1.5 }],
      [{ groupThreads: false }],
    ]);
  });

  it("renders platform-aware shortcut reference", () => {
    document.documentElement.dataset.platform = "macos";
    const { container } = render(<ShortcutsTab />);
    expect(container.querySelectorAll("kbd")).toHaveLength(13);
    expect(container).toHaveTextContent("⌘ N");
    expect(container).toHaveTextContent("⌥⌘ F");
  });

  it("toggles both advanced protection preferences and warning", () => {
    const setAdvertisingBlocking = vi.fn().mockResolvedValue(undefined);
    const setThreatBlocking = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <AdvancedTab
        setAdvertisingBlocking={setAdvertisingBlocking}
        setThreatBlocking={setThreatBlocking}
      />,
    );
    const toggles = screen.getAllByRole("checkbox");
    fireEvent.click(toggles[0]);
    fireEvent.click(toggles[1]);
    expect(setAdvertisingBlocking).toHaveBeenCalledWith(false);
    expect(setThreatBlocking).toHaveBeenCalledWith(false);

    useAppStore.setState({
      settings: { ...defaultSettings, blockReportedThreats: false },
    });
    rerender(
      <AdvancedTab
        setAdvertisingBlocking={setAdvertisingBlocking}
        setThreatBlocking={setThreatBlocking}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      strings.settings.threatOffWarning,
    );
  });
});

describe("updates tab", () => {
  it("restarts a downloaded update and checks direct releases", () => {
    useAppStore.setState({ updateReady: "0.2.0" });
    const relaunch = vi.spyOn(api, "relaunch").mockResolvedValue(undefined);
    const checkForUpdates = vi.fn().mockResolvedValue(undefined);
    render(
      <UpdatesTab
        distribution={{ kind: "direct", updatesManagedBy: "postalSnap" }}
        updateStatus="Check now"
        checkingUpdate={false}
        checkForUpdates={checkForUpdates}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.settings.restartNow }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(relaunch).toHaveBeenCalled();
    expect(checkForUpdates).toHaveBeenCalled();
    expect(screen.getByText(strings.settings.directEdition)).toBeVisible();
  });

  it("shows store-managed and unknown editions without update controls", () => {
    const { rerender } = render(
      <UpdatesTab
        distribution={{ kind: "flatpak", updatesManagedBy: "store" }}
        updateStatus="Check now"
        checkingUpdate
        checkForUpdates={vi.fn()}
      />,
    );
    expect(screen.getByText(strings.settings.storeUpdateTitle)).toBeVisible();
    expect(screen.getByText(strings.settings.flatpakEdition)).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    rerender(
      <UpdatesTab
        distribution={undefined}
        updateStatus="Check now"
        checkingUpdate={false}
        checkForUpdates={vi.fn()}
      />,
    );
    expect(screen.getByText(strings.settings.checkingEdition)).toBeVisible();
  });
});

describe("settings display helpers", () => {
  it("names every distribution and formats byte units", () => {
    expect(editionName("direct")).toBe(strings.settings.directEdition);
    expect(editionName("macAppStore")).toBe(strings.settings.macStoreEdition);
    expect(editionName("microsoftStore")).toBe(
      strings.settings.microsoftStoreEdition,
    );
    expect(editionName("flatpak")).toBe(strings.settings.flatpakEdition);
    expect(formatBytes(100)).toBe("100 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 ** 2)).toBe("2.0 MB");
    expect(formatBytes(2 * 1024 ** 3)).toBe("2.0 GB");
  });
});
