import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { Composer } from "../components/Composer";
import { defaultSettings, useAppStore } from "../store";

vi.mock("../api", () => ({
  api: {
    saveDraft: vi.fn(),
    sendMessage: vi.fn(),
    deleteDraft: vi.fn(),
    releaseComposeAttachments: vi.fn(),
    readComposeImage: vi.fn(),
    suggestRecipients: vi.fn().mockResolvedValue([]),
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
    composeSeed: undefined,
    composerOpen: false,
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

  it("promptly saves edits made during a save", async () => {
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

    expect(mockedSaveDraft).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("Draft saved").length).toBeGreaterThan(0);
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

  it("exposes Cc and Bcc toggles separately for assistive tech", () => {
    render(<Composer accountId={account.id} />);
    const ccToggle = screen.getByRole("button", { name: "Cc" });
    const bccToggle = screen.getByRole("button", { name: "Bcc" });
    expect(ccToggle.getAttribute("aria-expanded")).toBe("false");
    expect(bccToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(ccToggle);
    expect(ccToggle.getAttribute("aria-expanded")).toBe("true");
    expect(bccToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByLabelText("Cc", { selector: "input" })).toBeDefined();
  });

  it("suggests previous recipients and completes on Enter", async () => {
    vi.mocked(api.suggestRecipients).mockResolvedValue([
      { address: "jane@example.test", name: "Jane", useCount: 3 },
    ]);
    render(<Composer accountId={account.id} />);
    const to = screen.getByPlaceholderText("name@example.com");
    fireEvent.change(to, { target: { value: "jan" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    const option = screen.getByRole("option", {
      name: /jane@example.test/i,
    });
    fireEvent.keyDown(to, { key: "ArrowDown" });
    fireEvent.keyDown(to, { key: "Enter" });
    expect((to as HTMLInputElement).value).toContain("jane@example.test");
    expect(option).toBeDefined();
  });

  it("keeps later recipients when completing a middle address", async () => {
    vi.mocked(api.suggestRecipients).mockResolvedValue([
      { address: "jane@example.test", name: "Jane", useCount: 3 },
    ]);
    render(<Composer accountId={account.id} />);
    const to = screen.getByPlaceholderText(
      "name@example.com",
    ) as HTMLInputElement;
    fireEvent.change(to, {
      target: { value: "jan, bob@example.test" },
    });
    to.setSelectionRange(3, 3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    fireEvent.keyDown(to, { key: "ArrowDown" });
    fireEvent.keyDown(to, { key: "Enter" });
    expect(to.value).toContain("jane@example.test");
    expect(to.value).toContain("bob@example.test");
  });

  it("exposes pressed state for active formatting controls", () => {
    render(<Composer accountId={account.id} />);
    fireEvent.click(screen.getByRole("button", { name: "Show formatting" }));
    const bold = screen.getByRole("button", { name: "Bold" });
    expect(bold).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(bold);
    expect(bold).toHaveAttribute("aria-pressed");
  });

  it("closes recipient suggestions on Escape without closing the composer", async () => {
    vi.mocked(api.suggestRecipients).mockResolvedValue([
      { address: "jane@example.test", name: "Jane", useCount: 3 },
    ]);
    render(<Composer accountId={account.id} />);
    const to = screen.getByPlaceholderText("name@example.com");
    fireEvent.change(to, { target: { value: "jan" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.getByRole("listbox")).toBeDefined();

    fireEvent.keyDown(to, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog", { name: /New message/i })).toBeDefined();
  });

  it("does not send while Settings is open", async () => {
    const send = vi.mocked(api.sendMessage);
    send.mockResolvedValue({ id: "outbox-1", state: "sent", detail: null });
    render(<Composer accountId={account.id} />);
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "jane@example.test" },
    });

    const settings = document.createElement("div");
    settings.className = "settings-window";
    document.body.append(settings);
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(send).not.toHaveBeenCalled();

    settings.remove();
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("asks for a link in an in-app dialog", () => {
    const prompt = vi.spyOn(window, "prompt");
    render(<Composer accountId={account.id} />);
    fireEvent.click(screen.getByRole("button", { name: "Show formatting" }));
    fireEvent.click(screen.getByRole("button", { name: "More formatting" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert link" }));
    expect(prompt).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Insert link" })).toBeDefined();
    expect(screen.getByLabelText("Web address")).toBeDefined();
    prompt.mockRestore();
  });

  it("sanitizes stored draft HTML before Tiptap", () => {
    useAppStore.setState({
      composeSeed: {
        draft: {
          id: "draft-1",
          accountId: account.id,
          to: ["jane@example.test"],
          cc: [],
          bcc: [],
          subject: "Draft",
          htmlBody:
            '<p>Family note</p><img src=x onerror="steal()"><script>alert(1)</script>',
          textBody: "Family note",
          attachments: [],
        },
      },
    });
    render(<Composer accountId={account.id} />);
    expect(document.body.innerHTML).toContain("Family note");
    expect(document.body.innerHTML).not.toMatch(/onerror|steal\(|<script/i);
  });

  it("does not close an inert composer on Escape", () => {
    render(
      <div inert>
        <Composer accountId={account.id} />
      </div>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: /New message/i })).toBeDefined();
  });

  it("keeps the original message readable for reply and forward", () => {
    useAppStore.setState({
      composeSeed: {
        composeMode: "reply",
        sourceMessage: {
          id: 1,
          accountId: account.id,
          mailboxId: 1,
          uid: 1,
          messageId: "<parent@example.test>",
          subject: "Family picnic",
          senderName: "Jane",
          senderAddress: "jane@example.test",
          recipients: account.email,
          receivedAt: "2026-08-18T12:00:00Z",
          preview: "Bring sandwiches",
          isRead: true,
          isStarred: false,
          hasAttachments: false,
          size: 100,
          to: [account.email],
          cc: [],
          replyTo: null,
          textBody: "Bring sandwiches",
          htmlBody: null,
          remoteImagesBlocked: false,
          attachments: [],
          references: ["<root@example.test>"],
        },
      },
    });
    const { container } = render(<Composer accountId={account.id} />);
    const dialog = screen.getByRole("dialog", { name: /Reply/i });
    expect(dialog.getAttribute("aria-modal")).toBe("false");
    expect(container.firstElementChild?.className).toContain(
      "composer-layer-followup",
    );
  });

  it("appends the parent Message-ID onto existing References", async () => {
    useAppStore.setState({
      composeSeed: {
        composeMode: "reply",
        sourceMessage: {
          id: 1,
          accountId: account.id,
          mailboxId: 1,
          uid: 1,
          messageId: "<parent@example.test>",
          subject: "Family picnic",
          senderName: "Jane",
          senderAddress: "jane@example.test",
          recipients: account.email,
          receivedAt: "2026-08-18T12:00:00Z",
          preview: "Bring sandwiches",
          isRead: true,
          isStarred: false,
          hasAttachments: false,
          size: 100,
          to: [account.email],
          cc: [],
          replyTo: null,
          textBody: "Bring sandwiches",
          htmlBody: null,
          remoteImagesBlocked: false,
          attachments: [],
          references: ["<root@example.test>"],
        },
      },
    });
    render(<Composer accountId={account.id} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Save draft and close" }).at(-1)!,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockedSaveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        inReplyTo: "<parent@example.test>",
        references: ["<root@example.test>", "<parent@example.test>"],
      }),
    );
  });

  it("schedules sends through the Send options menu", async () => {
    const send = vi.mocked(api.sendMessage);
    send.mockResolvedValue({
      id: "outbox-9",
      state: "scheduled",
      detail: null,
    });
    render(<Composer accountId={account.id} />);
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "jane@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /tonight/i }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual(
      expect.objectContaining({ sendAt: expect.stringMatching(/T/) }),
    );
    expect(useAppStore.getState().lastSent).toEqual(
      expect.objectContaining({ outboxId: "outbox-9", scheduled: true }),
    );
  });

  it("rejects a past scheduled time without calling send", async () => {
    const send = vi.mocked(api.sendMessage);
    render(<Composer accountId={account.id} />);
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "jane@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /date and time/i }));
    const input = screen.getByLabelText("Date and time") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2000-01-01T00:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(send).not.toHaveBeenCalled();
    expect(useAppStore.getState().error).toMatch(/future date and time/i);
  });

  it("saves on demand from the footer Save button", async () => {
    render(<Composer accountId={account.id} />);
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "jane@example.test" },
    });
    const calls = mockedSaveDraft.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockedSaveDraft.mock.calls.length).toBeGreaterThan(calls);
  });
});
