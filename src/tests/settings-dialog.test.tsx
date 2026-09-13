import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { SettingsDialog } from "../components/SettingsDialog";
import { defaultSettings, useAppStore } from "../store";
import type { AccountSummary, FilterRule } from "../types";
import { mockSaveSettingsPassthrough } from "./helpers/api-mocks";
import { makeAccount } from "./helpers/fixtures";
import { resetStore } from "./helpers/store";

vi.mock("../window-fx", () => ({
  supportsWorkspaceWindowFx: vi.fn().mockResolvedValue(true),
  syncWorkspaceWindowFx: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn().mockResolvedValue(null),
}));

vi.mock("../api", () => ({
  api: {
    saveSettings: vi.fn(),
    listAccounts: vi.fn(),
    testAccount: vi.fn(),
    testSavedAccount: vi.fn(),
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
    eraseAllData: vi.fn(),
    relaunch: vi.fn(),
    exportSettings: vi.fn(),
    importSettings: vi.fn(),
    clearCache: vi.fn(),
    openExternalUrl: vi.fn(),
    cacheUsage: vi.fn().mockResolvedValue({
      bytes: 1024,
      maxBytes: 1_073_741_824,
      messageCount: 5,
    }),
    distribution: vi.fn().mockResolvedValue({
      kind: "direct",
      updatesManagedBy: "postalSnap",
    }),
    getLicenseCredits: vi.fn().mockResolvedValue({
      notices: [],
      packages: [],
    }),
    showNativeConfirm: vi.fn().mockResolvedValue(true),
    showNativeMessage: vi.fn().mockResolvedValue(undefined),
  },
}));

const account = makeAccount("account-1", "icloud", {
  email: "user@icloud.com",
  displayName: "Test User",
  aliases: ["alias@icloud.com"],
});

beforeEach(() => {
  vi.clearAllMocks();
  mockSaveSettingsPassthrough();
  vi.mocked(api.listAccounts).mockResolvedValue([account]);
  vi.mocked(api.listFilterRules).mockResolvedValue([]);
  vi.mocked(api.updateAccountAliases).mockResolvedValue(account);
  vi.mocked(api.discoverAccountAliases).mockResolvedValue({
    ...account,
    aliases: ["alias@icloud.com", "custom@mydomain.com"],
  });
  resetStore({
    accounts: [account],
    activeAccountId: account.id,
    settings: { ...defaultSettings, windowEffects: false },
  });
});

describe("SettingsDialog component", () => {
  it("renders accounts tab with existing aliases and allows adding new alias", async () => {
    const onClose = vi.fn();
    render(<SettingsDialog initialTab="accounts" onClose={onClose} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("alias@icloud.com")).toBeVisible();

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

  it("resets everything and restarts after confirm", async () => {
    const onClose = vi.fn();
    vi.mocked(api.eraseAllData).mockResolvedValue(1);
    render(<SettingsDialog initialTab="accounts" onClose={onClose} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("Reset everything")).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reset & Restart" }));
      await Promise.resolve();
    });

    expect(api.showNativeConfirm).toHaveBeenCalledWith(
      "Reset everything",
      expect.stringMatching(/everything stored locally is removed/i),
    );
    expect(api.eraseAllData).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api.relaunch).toHaveBeenCalledTimes(1));
  });

  it("does nothing when the reset confirm is dismissed", async () => {
    const onClose = vi.fn();
    vi.mocked(api.showNativeConfirm).mockResolvedValue(false);
    render(<SettingsDialog initialTab="accounts" onClose={onClose} />);

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reset & Restart" }));
      await Promise.resolve();
    });

    expect(api.eraseAllData).not.toHaveBeenCalled();
    expect(api.relaunch).not.toHaveBeenCalled();
    vi.mocked(api.showNativeConfirm).mockResolvedValue(true);
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

    expect(screen.getByText("Email Aliases & Custom Domains")).toBeVisible();
    expect(
      screen.getByText(/Send and receive using iCloud aliases/),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Detect from iCloud" }),
    ).toBeVisible();
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
    expect(toggle).toBeVisible();
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(api.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ windowEffects: true }),
    );
  });

  it("keeps overlapping preference saves instead of dropping the second", async () => {
    let releaseFirst: () => void = () => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    vi.mocked(api.saveSettings).mockImplementation(async (next) => {
      calls += 1;
      if (calls === 1) await firstBlocked;
      return next;
    });
    const onClose = vi.fn();
    render(<SettingsDialog initialTab="general" onClose={onClose} />);
    const windowFx = await screen.findByRole("checkbox", {
      name: /Translucent window background/,
    });
    await act(async () => {
      fireEvent.click(windowFx);
    });
    const density = screen.getByLabelText("Interface spacing");
    await act(async () => {
      fireEvent.change(density, { target: { value: "compact" } });
    });
    await act(async () => {
      releaseFirst();
    });
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(2));
    expect(api.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        windowEffects: true,
        density: "compact",
      }),
    );
  });

  it("keeps both cache days and limit when those saves overlap", async () => {
    let releaseFirst: () => void = () => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    vi.mocked(api.saveSettings).mockImplementation(async (next) => {
      calls += 1;
      if (calls === 1) await firstBlocked;
      return next;
    });
    render(<SettingsDialog initialTab="storage" onClose={vi.fn()} />);
    const days = await screen.findByLabelText("Keep mail for");
    await act(async () => {
      fireEvent.change(days, { target: { value: "30" } });
    });
    const limit = screen.getByLabelText("Maximum cache size");
    await act(async () => {
      fireEvent.change(limit, { target: { value: "524288000" } });
    });
    await act(async () => {
      releaseFirst();
    });
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledTimes(2));
    expect(api.saveSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cachePolicy: {
          mode: "recent",
          days: 30,
          maxBytes: 524_288_000,
        },
      }),
    );
  });

  it("still sends CONFIRM when a threat-off save overlaps another preference", async () => {
    let releaseFirst: () => void = () => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    vi.mocked(api.saveSettings).mockImplementation(async (next) => {
      calls += 1;
      if (calls === 1) await firstBlocked;
      return next;
    });
    render(<SettingsDialog initialTab="advanced" onClose={vi.fn()} />);
    const adblock = await screen.findByRole("checkbox", {
      name: /Block advertising and tracking images/,
    });
    await act(async () => {
      fireEvent.click(adblock);
    });
    const threats = screen.getByRole("checkbox", {
      name: /Warn about reported dangerous addresses/,
    });
    await act(async () => {
      fireEvent.click(threats);
    });
    fireEvent.change(screen.getByLabelText("Type CONFIRM"), {
      target: { value: "CONFIRM" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    });
    await act(async () => {
      releaseFirst();
    });
    await waitFor(() =>
      expect(api.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ blockReportedThreats: false }),
        "CONFIRM",
      ),
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
    expect(await screen.findByText(/Password updated/)).toBeVisible();
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
    expect(await screen.findByText(/Signature saved/)).toBeVisible();
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
    expect(await screen.findByText(/Rule saved/)).toBeVisible();

    const billsRow = screen.getByText("Bills").closest("li") as HTMLElement;
    await act(async () => {
      fireEvent.click(
        within(billsRow).getByRole("button", { name: /^Remove$/ }),
      );
    });
    expect(api.showNativeConfirm).toHaveBeenCalled();
    expect(api.deleteFilterRule).toHaveBeenCalledWith(account.id, "rule-1");
    expect(await screen.findByText(/Rule removed/)).toBeVisible();
  });

  it("describes filter rules with localized actions and folder names", async () => {
    const rules: FilterRule[] = [
      {
        id: "rule-read",
        accountId: account.id,
        name: "Read note",
        field: "from",
        contains: "a",
        action: "mark_read",
        targetMailbox: null,
        enabled: true,
      },
      {
        id: "rule-folder",
        accountId: account.id,
        name: "Folder note",
        field: "subject",
        contains: "b",
        action: "move_mailbox",
        targetMailbox: "1",
        enabled: true,
      },
    ];
    vi.mocked(api.listFilterRules).mockResolvedValue(rules);
    render(<SettingsDialog initialTab="accounts" onClose={vi.fn()} />);

    await screen.findByText("Read note");
    expect(screen.getByText(/Mark as read\./)).toBeVisible();
    expect(screen.getByText(/Move to \u201CInbox\u201D\./)).toBeVisible();
    expect(screen.queryByText(/mark_read/)).toBeNull();
    expect(screen.queryByText(/move_mailbox/)).toBeNull();
  });

  it("keeps concurrent account changes when a signature save resolves", async () => {
    const second = makeAccount("account-2");
    let releaseSignature: (value: AccountSummary) => void = () => undefined;
    vi.mocked(api.updateAccountSignature).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSignature = resolve;
        }),
    );
    render(<SettingsDialog initialTab="accounts" onClose={vi.fn()} />);
    await screen.findByLabelText("Email signature");

    fireEvent.change(screen.getByLabelText("Email signature"), {
      target: { value: "Regards" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    act(() => {
      useAppStore.setState({ accounts: [account, second] });
    });
    await act(async () => {
      releaseSignature({ ...account, signature: "Regards" });
      await Promise.resolve();
    });

    expect(useAppStore.getState().accounts.map((item) => item.id)).toEqual([
      account.id,
      second.id,
    ]);
    expect(useAppStore.getState().accounts[0]?.signature).toBe("Regards");
  });

  it("removes an alias using the latest account state", async () => {
    let resolveConfirm: (value: boolean) => void = () => undefined;
    vi.mocked(api.showNativeConfirm).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConfirm = resolve;
        }),
    );
    render(<SettingsDialog initialTab="accounts" onClose={vi.fn()} />);
    await screen.findByText("alias@icloud.com");

    fireEvent.click(
      screen.getByRole("button", { name: "Remove alias@icloud.com" }),
    );
    act(() => {
      useAppStore.setState({
        accounts: [
          {
            ...account,
            aliases: ["alias@icloud.com", "newer@icloud.com"],
          },
        ],
      });
    });
    await act(async () => {
      resolveConfirm(true);
      await Promise.resolve();
    });

    expect(api.updateAccountAliases).toHaveBeenCalledWith("account-1", [
      "newer@icloud.com",
    ]);
  });

  it("opens Advanced from the General protection card", async () => {
    render(<SettingsDialog initialTab="general" onClose={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Appearance" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Sending" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Privacy" })).toBeVisible();
    expect(screen.getByText("Mail protection is on")).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Review Advanced" }));
    });

    expect(screen.getByRole("tab", { name: "Advanced" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("checkbox", {
        name: /Block advertising and tracking images/,
      }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", {
        name: /Warn about reported dangerous addresses/,
      }),
    ).toBeChecked();
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
    expect(screen.getByRole("tab", { name: "Advanced" })).toHaveFocus();
  });

  it("asks before turning off advertising and tracking image checks", async () => {
    vi.mocked(api.showNativeConfirm).mockResolvedValueOnce(false);
    render(<SettingsDialog initialTab="advanced" onClose={vi.fn()} />);

    const toggle = screen.getByRole("checkbox", {
      name: /Block advertising and tracking images/,
    });
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(api.showNativeConfirm).toHaveBeenCalledWith(
      "Allow advertising and tracking images?",
      expect.stringMatching(/advertising and tracking/),
    );
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(toggle).toBeChecked();

    vi.mocked(api.showNativeConfirm).mockResolvedValueOnce(true);
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(api.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ blockAdvertisingAndTracking: false }),
    );
  });

  it("requires typing CONFIRM before turning off reported-address warnings", async () => {
    const onClose = vi.fn();
    render(<SettingsDialog initialTab="advanced" onClose={onClose} />);

    const toggle = screen.getByRole("checkbox", {
      name: /Warn about reported dangerous addresses/,
    });
    await act(async () => {
      fireEvent.click(toggle);
    });

    const dialog = screen.getByRole("alertdialog", {
      name: "Turn off reported-address warnings?",
    });
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Disable" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Type CONFIRM"), {
      target: { value: "confirm" },
    });
    expect(screen.getByRole("button", { name: "Disable" })).toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    });
    expect(api.saveSettings).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Type CONFIRM"), {
      target: { value: "CONFIRM" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    });

    expect(api.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ blockReportedThreats: false }),
      "CONFIRM",
    );
    expect(dialog).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes the threat-off confirm with Escape without closing Settings", async () => {
    const onClose = vi.fn();
    render(<SettingsDialog initialTab="advanced" onClose={onClose} />);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("checkbox", {
          name: /Warn about reported dangerous addresses/,
        }),
      );
    });
    expect(screen.getByRole("alertdialog")).toBeVisible();

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it("turns reported-address warnings back on without a confirm dialog", async () => {
    useAppStore.setState({
      settings: { ...defaultSettings, blockReportedThreats: false },
    });
    render(<SettingsDialog initialTab="advanced" onClose={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      /Reported-address warnings are off/,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("checkbox", {
          name: /Warn about reported dangerous addresses/,
        }),
      );
    });

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ blockReportedThreats: true }),
    );
  });

  it("exports and imports preference files without a second reset action", async () => {
    vi.mocked(api.exportSettings).mockResolvedValue(true);
    vi.mocked(api.importSettings).mockResolvedValue({
      ...defaultSettings,
      theme: "dark",
    });
    render(<SettingsDialog initialTab="general" onClose={vi.fn()} />);

    expect(
      screen.queryByRole("button", { name: "Reset settings" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      await screen.findByRole("button", { name: "Export settings" }),
    );
    expect(await screen.findByText("Settings exported.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Import settings" }));
    await waitFor(() => expect(api.importSettings).toHaveBeenCalled());
    expect(useAppStore.getState().settings.theme).toBe("dark");
    expect(await screen.findByText(/Settings imported/)).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Accounts" }));
    expect(
      screen.getAllByRole("button", { name: "Reset & Restart" }),
    ).toHaveLength(1);
  });

  it("clears downloaded mail and refreshes usage", async () => {
    vi.mocked(api.clearCache).mockResolvedValue(undefined);
    vi.mocked(api.cacheUsage)
      .mockResolvedValueOnce({
        bytes: 1024,
        maxBytes: 1_073_741_824,
        messageCount: 5,
      })
      .mockResolvedValueOnce({
        bytes: 0,
        maxBytes: 1_073_741_824,
        messageCount: 0,
      });
    render(<SettingsDialog initialTab="storage" onClose={vi.fn()} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Clear downloaded mail" }),
    );
    await waitFor(() => expect(api.clearCache).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/0 B used/)).toBeVisible();
  });

  it("tests an account and removes the final account", async () => {
    const onClose = vi.fn();
    vi.mocked(api.testSavedAccount).mockResolvedValue(undefined);
    vi.mocked(api.removeAccount).mockResolvedValue({ cleanupPending: false });
    vi.mocked(api.listAccounts).mockResolvedValueOnce([]);
    render(<SettingsDialog initialTab="accounts" onClose={onClose} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Test connection" }),
    );
    expect(await screen.findByText(/Connected and in sync/)).toBeVisible();
    expect(api.testSavedAccount).toHaveBeenCalledWith("account-1");

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(api.removeAccount).toHaveBeenCalledWith("account-1"),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().accounts).toEqual([]);
  });

  it("validates aliases and removes one only after confirmation", async () => {
    render(<SettingsDialog initialTab="accounts" onClose={vi.fn()} />);
    const input = await screen.findByLabelText("alias@yourdomain.com");

    fireEvent.change(input, { target: { value: "not-an-address" } });
    fireEvent.click(screen.getByRole("button", { name: "Add alias" }));
    expect(useAppStore.getState().error).toMatch(/valid email address/i);

    fireEvent.change(input, { target: { value: "ALIAS@ICLOUD.COM" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(api.updateAccountAliases).not.toHaveBeenCalled();
    expect(input).toHaveValue("");

    vi.mocked(api.showNativeConfirm).mockResolvedValueOnce(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove alias@icloud.com" }),
    );
    await waitFor(() => expect(api.showNativeConfirm).toHaveBeenCalled());
    expect(api.updateAccountAliases).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove alias@icloud.com" }),
    );
    await waitFor(() =>
      expect(api.updateAccountAliases).toHaveBeenCalledWith("account-1", []),
    );
  });

  it("validates required rule name and match text", async () => {
    render(<SettingsDialog initialTab="accounts" onClose={vi.fn()} />);
    await screen.findByRole("button", { name: "Add rule" });

    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(useAppStore.getState().error).toMatch(/name/i);
    fireEvent.change(screen.getByLabelText("Rule name"), {
      target: { value: "Named rule" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(useAppStore.getState().error).toMatch(/text to match/i);
    expect(api.createFilterRule).not.toHaveBeenCalled();
  });

  it("supports keyboard tab navigation and normal close actions", async () => {
    const onClose = vi.fn();
    render(<SettingsDialog initialTab="general" onClose={onClose} />);
    const general = screen.getByRole("tab", { name: "General" });

    fireEvent.keyDown(general, { key: "ArrowDown" });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Reading" })).toHaveFocus(),
    );
    expect(screen.getByRole("tab", { name: "Reading" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: "Reading" }), {
      key: "End",
    });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "About" })).toHaveFocus(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns each settings tab to the top", async () => {
    const { container } = render(
      <SettingsDialog initialTab="general" onClose={vi.fn()} />,
    );
    const content = container.querySelector<HTMLElement>(".settings-content")!;
    content.scrollTop = 180;

    fireEvent.click(screen.getByRole("tab", { name: "Accounts" }));

    await waitFor(() => expect(content.scrollTop).toBe(0));
  });

  it("reports preference-file and cache maintenance failures", async () => {
    vi.mocked(api.exportSettings).mockRejectedValueOnce(
      new Error("export failed"),
    );
    vi.mocked(api.importSettings).mockRejectedValueOnce(
      new Error("import failed"),
    );
    vi.mocked(api.clearCache).mockRejectedValueOnce(new Error("clear failed"));
    render(<SettingsDialog initialTab="general" onClose={vi.fn()} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Export settings" }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/export failed/i),
    );
    fireEvent.click(screen.getByRole("button", { name: "Import settings" }));
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/import failed/i),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Storage" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Clear downloaded mail" }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/clear failed/i),
    );
  });

  it("reports failures from every account-maintenance action", async () => {
    const rule: FilterRule = {
      id: "rule-failing",
      accountId: account.id,
      name: "Bills",
      field: "from",
      contains: "billing.example",
      action: "mark_read",
      targetMailbox: null,
      enabled: true,
    };
    vi.mocked(api.listFilterRules).mockResolvedValue([rule]);
    vi.mocked(api.testSavedAccount).mockRejectedValueOnce(
      new Error("test failed"),
    );
    vi.mocked(api.discoverAccountAliases).mockRejectedValueOnce(
      new Error("detect failed"),
    );
    vi.mocked(api.updateAccountPassword).mockRejectedValueOnce(
      new Error("password failed"),
    );
    vi.mocked(api.updateAccountSignature).mockRejectedValueOnce(
      new Error("signature failed"),
    );
    vi.mocked(api.updateAccountAliases)
      .mockRejectedValueOnce(new Error("alias add failed"))
      .mockRejectedValueOnce(new Error("alias remove failed"));
    vi.mocked(api.createFilterRule).mockRejectedValueOnce(
      new Error("rule create failed"),
    );
    vi.mocked(api.updateFilterRule).mockRejectedValueOnce(
      new Error("rule toggle failed"),
    );
    vi.mocked(api.deleteFilterRule).mockRejectedValueOnce(
      new Error("rule delete failed"),
    );
    vi.mocked(api.removeAccount).mockRejectedValueOnce(
      new Error("remove failed"),
    );
    vi.mocked(api.eraseAllData).mockRejectedValueOnce(
      new Error("erase failed"),
    );
    render(<SettingsDialog initialTab="accounts" onClose={vi.fn()} />);
    await screen.findByText("Bills");

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/test failed/i),
    );
    fireEvent.click(screen.getByRole("button", { name: "Detect from iCloud" }));
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/detect failed/i),
    );

    fireEvent.change(screen.getByLabelText("Update password"), {
      target: { value: "new-app-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/password failed/i),
    );
    fireEvent.change(screen.getByLabelText("Email signature"), {
      target: { value: "Regards" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/signature failed/i),
    );

    const aliasInput = screen.getByPlaceholderText("alias@yourdomain.com");
    fireEvent.change(aliasInput, { target: { value: "new@icloud.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add alias" }));
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/alias add failed/i),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove alias@icloud.com" }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/alias remove failed/i),
    );

    fireEvent.change(screen.getByLabelText("Rule name"), {
      target: { value: "New rule" },
    });
    fireEvent.change(screen.getByLabelText("Text to match"), {
      target: { value: "needle" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/rule create failed/i),
    );
    fireEvent.click(screen.getByRole("button", { name: /Bills: On/ }));
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/rule toggle failed/i),
    );
    fireEvent.click(
      within(screen.getByText("Bills").closest("li")!).getByRole("button", {
        name: "Remove",
      }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/rule delete failed/i),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/remove failed/i),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset & Restart" }));
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/erase failed/i),
    );
    expect(screen.getByText(/Reset did not finish/)).toBeVisible();
  });

  it("checks for updates, rolls appearance saves back, and closes the threat overlay", async () => {
    vi.mocked(api.saveSettings).mockRejectedValueOnce(
      new Error("theme save failed"),
    );
    render(<SettingsDialog initialTab="general" onClose={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText("Appearance"), {
      target: { value: "dark" },
    });
    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/theme save failed/i),
    );
    expect(useAppStore.getState().settings.theme).toBe("system");

    fireEvent.change(screen.getByLabelText("Interface spacing"), {
      target: { value: "compact" },
    });
    const sidebar = screen
      .getAllByRole("checkbox")
      .find((input) =>
        input.closest(".switch-row")?.textContent?.includes("Mailbox"),
      );
    if (sidebar) fireEvent.click(sidebar);

    fireEvent.click(screen.getByRole("tab", { name: "Updates" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Check for updates/i }),
    );
    await waitFor(() => expect(api.showNativeMessage).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("tab", { name: "Storage" }));
    fireEvent.change(await screen.findByLabelText("Mail to keep"), {
      target: { value: "recent" },
    });

    fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /reported/i }));
    fireEvent.click(
      document.querySelector(".settings-confirm-overlay") as HTMLElement,
    );
    expect(
      screen.queryByRole("alertdialog", {
        name: /Turn off reported-address warnings/i,
      }),
    ).not.toBeInTheDocument();
  });
});
