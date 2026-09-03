import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { Composer } from "../components/Composer";
import { defaultSettings, useAppStore } from "../store";

vi.mock("../api", () => ({
  api: {
    saveDraft: vi.fn(),
    deleteDraft: vi.fn(),
    releaseComposeAttachments: vi.fn(),
    readComposeImage: vi.fn(),
    showNativeConfirm: vi.fn().mockResolvedValue(true),
  },
}));

const account = {
  id: "account-1",
  provider: "manual" as const,
  email: "sam@example.test",
  displayName: "Sam",
  syncState: "idle" as const,
};

const mockedSaveDraft = vi.mocked(api.saveDraft);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockedSaveDraft.mockResolvedValue({
    id: "draft-1",
    syncState: "localPending",
  });
  vi.mocked(api.deleteDraft).mockResolvedValue(undefined);
  vi.mocked(api.releaseComposeAttachments).mockResolvedValue(undefined);
  useAppStore.setState({
    accounts: [account],
    activeAccountId: account.id,
    settings: defaultSettings,
    error: undefined,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("composer draft persistence", () => {
  it("does not start a second save while autosave is pending", async () => {
    let releaseSave: () => void = () => undefined;
    const pendingSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    mockedSaveDraft.mockImplementation(async () => {
      await pendingSave;
      return { id: "draft-1", syncState: "localPending" };
    });

    render(<Composer accountId={account.id} />);
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "jane@example.test" },
    });

    await act(async () => {
      vi.advanceTimersByTime(6_000);
      await Promise.resolve();
    });
    expect(mockedSaveDraft).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getAllByRole("button", { name: "Save draft and close" }).at(-1)!,
    );
    expect(mockedSaveDraft).toHaveBeenCalledTimes(1);

    releaseSave();
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("keeps draft unsaved when edits happen during a save", async () => {
    let releaseSave: () => void = () => undefined;
    const pendingSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    mockedSaveDraft.mockImplementation(async () => {
      await pendingSave;
      return { id: "draft-1", syncState: "localPending" };
    });

    render(<Composer accountId={account.id} />);
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "jane@example.test" },
    });
    await act(async () => {
      vi.advanceTimersByTime(6_000);
      await Promise.resolve();
    });
    expect(mockedSaveDraft).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), {
      target: { value: "Updated after autosave started" },
    });
    releaseSave();
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText("Draft saved")).toBeNull();
  });

  it("minimizes into docked pill and restores back to full composer", () => {
    render(<Composer accountId={account.id} />);
    expect(screen.getByRole("dialog", { name: /New message/i })).toBeDefined();

    const minimizeBtn = screen.getByRole("button", { name: "Minimize draft" });
    fireEvent.click(minimizeBtn);

    const restoreBtn = screen.getByRole("button", { name: /Restore/i });
    expect(restoreBtn).toBeDefined();

    fireEvent.click(restoreBtn);
    expect(screen.getByRole("dialog", { name: /New message/i })).toBeDefined();
  });

  it("renders from alias selector when account has aliases", () => {
    useAppStore.setState({
      accounts: [
        {
          ...account,
          aliases: ["alias1@example.test", "alias2@example.test"],
        },
      ],
    });

    render(<Composer accountId={account.id} />);
    const select = screen.getByLabelText("From") as HTMLSelectElement;
    expect(select).toBeDefined();
    expect(select.value).toBe("sam@example.test");

    fireEvent.change(select, { target: { value: "alias1@example.test" } });
    expect(select.value).toBe("alias1@example.test");
  });

  it("exposes Cc/Bcc toggle state for assistive tech", () => {
    render(<Composer accountId={account.id} />);
    const toggle = screen.getByRole("button", { name: "Cc/Bcc" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});
