import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { SettingsDialog } from "../components/SettingsDialog";
import { defaultSettings, useAppStore } from "../store";
import type { FilterRule } from "../types";

vi.mock("../window-fx", () => ({
  supportsWorkspaceWindowFx: vi.fn().mockResolvedValue(true),
  syncWorkspaceWindowFx: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../api", () => ({
  api: {
    saveSettings: vi.fn(),
    listAccounts: vi.fn(),
    updateAccountPassword: vi.fn(),
    updateAccountSignature: vi.fn(),
    updateAccountAliases: vi.fn(),
    discoverAccountAliases: vi.fn(),
    listFilterRules: vi.fn(),
    createFilterRule: vi.fn(),
    updateFilterRule: vi.fn(),
    deleteFilterRule: vi.fn(),
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
  vi.mocked(api.listFilterRules).mockResolvedValue([]);
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

  it("renders alias header title, help, and detect action together", async () => {
    const onClose = vi.fn();
    const { container } = render(
      <SettingsDialog initialTab="accounts" onClose={onClose} />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("Email Aliases & Custom Domains")).toBeDefined();
    expect(
      screen.getByText(/Send and receive using iCloud aliases/),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Detect from iCloud" }),
    ).toBeDefined();
    const header = container.querySelector(".aliases-header");
    expect(header?.querySelector("strong")).toBeDefined();
    expect(header?.querySelector(".settings-note")).toBeDefined();
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

  it("offers the translucent window toggle when supported", async () => {
    const onClose = vi.fn();
    render(<SettingsDialog initialTab="general" onClose={onClose} />);

    const toggle = await screen.findByRole("checkbox", {
      name: /Translucent window background/,
    });
    expect(toggle).toBeDefined();
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(api.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ windowEffects: true }),
    );
  });

  it("surfaces sign-in errors with a password update form", async () => {
    vi.mocked(api.updateAccountPassword).mockResolvedValue(account);
    useAppStore.setState({
      accounts: [
        {
          ...account,
          error: "Sign-in failed. Update the account password.",
        },
      ],
    });
    const onClose = vi.fn();
    render(<SettingsDialog initialTab="accounts" onClose={onClose} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Sign-in failed");
    const input = screen.getByLabelText("Update password");
    fireEvent.change(input, { target: { value: "new-app-password" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Update password" }));
    });

    expect(api.updateAccountPassword).toHaveBeenCalledWith(
      "account-1",
      "new-app-password",
    );
    expect(await screen.findByText(/Password updated/)).toBeDefined();
  });

  it("saves per-account signatures", async () => {
    vi.mocked(api.updateAccountSignature).mockResolvedValue({
      ...account,
      signature: "Best,\nSam",
    });
    const onClose = vi.fn();
    render(<SettingsDialog initialTab="accounts" onClose={onClose} />);

    await act(async () => {
      await Promise.resolve();
    });

    const input = screen.getByLabelText("Email signature");
    fireEvent.change(input, { target: { value: "Best,\nSam" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(api.updateAccountSignature).toHaveBeenCalledWith(
      "account-1",
      "Best,\nSam",
    );
    expect(await screen.findByText(/Signature saved/)).toBeDefined();
  });

  it("changes the undo send window", async () => {
    const onClose = vi.fn();
    render(<SettingsDialog initialTab="general" onClose={onClose} />);

    const select = await screen.findByLabelText("Undo send window");
    await act(async () => {
      fireEvent.change(select, { target: { value: "30" } });
    });

    expect(api.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ undoSendSeconds: 30 }),
    );
  });

  it("lists, creates, toggles, and deletes filter rules", async () => {
    const existing: FilterRule = {
      id: "rule-1",
      accountId: account.id,
      name: "Bills",
      field: "from",
      contains: "power.example.com",
      action: "move_archive",
      targetMailbox: null,
      enabled: true,
    };
    vi.mocked(api.listFilterRules).mockResolvedValue([existing]);
    vi.mocked(api.createFilterRule).mockResolvedValue({
      ...existing,
      id: "rule-2",
      name: "Picnics",
      field: "subject",
      contains: "picnic",
      action: "mark_read",
    });
    vi.mocked(api.updateFilterRule).mockResolvedValue({
      ...existing,
      enabled: false,
    });
    const onClose = vi.fn();
    render(<SettingsDialog initialTab="accounts" onClose={onClose} />);

    await screen.findByText("Bills");
    const toggle = screen.getByRole("button", { name: /Bills/ });
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(api.updateFilterRule).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rule-1", enabled: false }),
    );

    fireEvent.change(screen.getByLabelText("Rule name"), {
      target: { value: "Picnics" },
    });
    fireEvent.change(screen.getByLabelText("Text to match"), {
      target: { value: "picnic" },
    });
    const field = screen.getByLabelText("Match by");
    fireEvent.change(field, { target: { value: "subject" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    });
    expect(api.createFilterRule).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Picnics",
        field: "subject",
        contains: "picnic",
        action: "mark_read",
      }),
    );
    expect(await screen.findByText(/Rule saved/)).toBeDefined();

    const billsRow = screen.getByText("Bills").closest("li") as HTMLElement;
    await act(async () => {
      fireEvent.click(
        within(billsRow).getByRole("button", { name: /^Remove$/ }),
      );
    });
    expect(api.showNativeConfirm).toHaveBeenCalled();
    expect(api.deleteFilterRule).toHaveBeenCalledWith(account.id, "rule-1");
    expect(await screen.findByText(/Rule removed/)).toBeDefined();
  });
});
