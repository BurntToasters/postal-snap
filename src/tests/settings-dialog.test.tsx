import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { SettingsDialog } from "../components/SettingsDialog";
import { defaultSettings, useAppStore } from "../store";

vi.mock("../api", () => ({
  api: {
    saveSettings: vi.fn(),
    listAccounts: vi.fn(),
    updateAccountAliases: vi.fn(),
    discoverAccountAliases: vi.fn(),
    syncAccount: vi.fn(),
    removeAccount: vi.fn(),
    relaunch: vi.fn(),
    exportSettings: vi.fn(),
    importSettings: vi.fn(),
    resetSettings: vi.fn(),
    cacheUsage: vi.fn().mockResolvedValue({
      totalBytes: 1024,
      databaseBytes: 512,
      bodyBytes: 256,
      attachmentBytes: 256,
      cachedMessages: 5,
    }),
    distribution: vi.fn().mockResolvedValue({
      kind: "direct-macos",
      channel: "stable",
      platform: "macos",
      arch: "universal",
      updatesManagedBy: "app",
    }),
    showNativeConfirm: vi.fn().mockResolvedValue(true),
    showNativeMessage: vi.fn().mockResolvedValue(undefined),
  },
}));

const account = {
  id: "account-1",
  provider: "icloud" as const,
  email: "senior@icloud.com",
  displayName: "Senior Citizen",
  syncState: "idle" as const,
  aliases: ["alias@icloud.com"],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.saveSettings).mockImplementation(async (s) => s);
  vi.mocked(api.listAccounts).mockResolvedValue([account]);
  vi.mocked(api.updateAccountAliases).mockResolvedValue(account);
  vi.mocked(api.discoverAccountAliases).mockResolvedValue({
    ...account,
    aliases: ["alias@icloud.com", "custom@mydomain.com"],
  });
  useAppStore.setState({
    accounts: [account],
    activeAccountId: account.id,
    settings: defaultSettings,
    error: undefined,
  });
});

describe("SettingsDialog component", () => {
  it("renders accounts tab with existing aliases and allows adding new alias", async () => {
    const onClose = vi.fn();
    render(<SettingsDialog initialTab="accounts" onClose={onClose} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("alias@icloud.com")).toBeDefined();

    const input = screen.getByPlaceholderText("alias@yourdomain.com");
    fireEvent.change(input, { target: { value: "family@icloud.com" } });

    const addBtn = screen.getByRole("button", { name: "Add alias" });
    await act(async () => {
      fireEvent.click(addBtn);
    });

    expect(api.updateAccountAliases).toHaveBeenCalledWith("account-1", [
      "alias@icloud.com",
      "family@icloud.com",
    ]);
  });

  it("detects iCloud aliases via CalDAV", async () => {
    const onClose = vi.fn();
    render(<SettingsDialog initialTab="accounts" onClose={onClose} />);

    await act(async () => {
      await Promise.resolve();
    });

    const detectBtn = screen.getByRole("button", {
      name: "Detect from iCloud",
    });
    await act(async () => {
      fireEvent.click(detectBtn);
    });

    expect(api.discoverAccountAliases).toHaveBeenCalledWith("account-1");
  });

  it("updates cache policy to unlimited when Download all is selected", async () => {
    const onClose = vi.fn();
    render(<SettingsDialog initialTab="storage" onClose={onClose} />);

    await act(async () => {
      await Promise.resolve();
    });

    const select = screen.getByLabelText("Mail to keep");
    await act(async () => {
      fireEvent.change(select, { target: { value: "full" } });
    });

    expect(api.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        cachePolicy: {
          mode: "full",
          days: 0,
          maxBytes: 0,
        },
      }),
    );
  });
});
