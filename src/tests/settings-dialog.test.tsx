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
import type { FilterRule } from "../types";
import { mockSaveSettingsPassthrough } from "./helpers/api-mocks";
import { makeAccount } from "./helpers/fixtures";
import { resetStore } from "./helpers/store";

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
    eraseAllData: vi.fn(),
    relaunch: vi.fn(),
    exportSettings: vi.fn(),
    importSettings: vi.fn(),
    resetSettings: vi.fn(),
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

  it("resets everything and restarts after confirm", async () => {
    const onClose = vi.fn();
    vi.mocked(api.eraseAllData).mockResolvedValue(1);
    render(<SettingsDialog initialTab="accounts" onClose={onClose} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("Reset everything")).toBeDefined();
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

  it("opens Advanced from the General protection card", async () => {
    render(<SettingsDialog initialTab="general" onClose={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Appearance" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Sending" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Privacy" })).toBeDefined();
    expect(screen.getByText("Mail protection is on")).toBeDefined();
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
    expect(screen.getByRole("alertdialog")).toBeDefined();

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
});
