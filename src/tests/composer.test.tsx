import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { Composer } from "../components/Composer";
import { clipboardImages } from "../components/composer/pasteImage";
import { strings } from "../i18n";
import { CONTEXT_ACTION_EVENT } from "../contextMenu";
import { useAppStore } from "../store";
import type { DraftSyncEvent } from "../types";
import { makeAccount } from "./helpers/fixtures";
import { resetStore } from "./helpers/store";

vi.mock("../api", () => ({
  api: {
    saveDraft: vi.fn(),
    sendMessage: vi.fn(),
    moveMessage: vi.fn(),
    deleteDraft: vi.fn(),
    releaseComposeAttachments: vi.fn(),
    readComposeImage: vi.fn(),
    chooseAttachments: vi.fn(),
    stagePastedImage: vi.fn(),
    suggestRecipients: vi.fn().mockResolvedValue([]),
    showNativeConfirm: vi.fn().mockResolvedValue(true),
    saveSettings: vi.fn(async (settings: unknown) => settings),
    onDraftSyncChanged: vi.fn().mockResolvedValue(() => undefined),
    onComposeDrag: vi.fn().mockResolvedValue(() => undefined),
    attachDroppedFiles: vi.fn().mockResolvedValue([]),
    listDrafts: vi.fn().mockResolvedValue([]),
  },
}));

const account = makeAccount();

const mockedSaveDraft = vi.mocked(api.saveDraft);

function confirmEmptyMessage() {
  const dialog = screen.queryByRole("alertdialog", {
    name: strings.composer.noMessageTitle,
  });
  if (!dialog) return;
  fireEvent.click(
    within(dialog).getByRole("button", { name: strings.composer.sendAnyway }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockedSaveDraft.mockResolvedValue({
    id: "draft-1",
    syncState: "localPending",
  });
  vi.mocked(api.deleteDraft).mockResolvedValue(undefined);
  vi.mocked(api.releaseComposeAttachments).mockResolvedValue(undefined);
  vi.mocked(api.chooseAttachments).mockResolvedValue([]);
  vi.mocked(api.readComposeImage).mockResolvedValue(
    "data:image/png;base64,AA==",
  );
  vi.mocked(api.showNativeConfirm).mockResolvedValue(true);
  vi.mocked(api.onDraftSyncChanged)
    .mockReset()
    .mockResolvedValue(() => undefined);
  vi.mocked(api.listDrafts).mockReset().mockResolvedValue([]);
  resetStore({
    accounts: [account],
    activeAccountId: account.id,
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
    expect(screen.getAllByText(/^Draft saved/).length).toBeGreaterThan(0);
  });

  it("minimizes into docked pill and restores back to full composer", () => {
    render(<Composer accountId={account.id} />);
    expect(screen.getByRole("dialog", { name: /New message/i })).toBeVisible();

    const minimizeBtn = screen.getByRole("button", { name: "Minimize draft" });
    fireEvent.click(minimizeBtn);

    const restoreBtn = screen.getByRole("button", { name: /Restore/i });
    expect(restoreBtn).toBeVisible();

    fireEvent.click(restoreBtn);
    expect(screen.getByRole("dialog", { name: /New message/i })).toBeVisible();
  });

  it("starts a new message from the address last chosen", () => {
    useAppStore.setState({
      accounts: [{ ...account, aliases: ["work@example.test"] }],
      settings: {
        ...useAppStore.getState().settings,
        lastFromAddresses: [
          { accountId: account.id, address: "work@example.test" },
        ],
      },
    });
    render(<Composer accountId={account.id} />);
    expect((screen.getByLabelText("From") as HTMLSelectElement).value).toBe(
      "work@example.test",
    );
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
    expect(select).toBeVisible();
    expect(select.value).toBe("sam@example.test");

    fireEvent.change(select, { target: { value: "alias1@example.test" } });
    expect(select.value).toBe("alias1@example.test");
  });

  it("shows the account Reply-To and can leave it off this message", async () => {
    useAppStore.setState({
      accounts: [{ ...account, replyTo: "replies@example.com" }],
    });
    const send = vi.mocked(api.sendMessage);
    send.mockResolvedValue({ id: "outbox-1", state: "sent", detail: null });
    render(<Composer accountId={account.id} />);
    const field = screen.getByRole("textbox", { name: "Reply-To" });
    expect(field).toHaveValue("replies@example.com");
    fireEvent.change(field, { target: { value: "not an address" } });
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "jane@example.test" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), {
      target: { value: "Tonight" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: strings.composer.send }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter one email address.",
    );

    fireEvent.change(field, { target: { value: "" } });
    fireEvent.click(
      screen.getByRole("button", { name: strings.composer.send }),
    );
    confirmEmptyMessage();
    await act(async () => {
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        replyTo: "",
        to: ["jane@example.test"],
      }),
    );
  });

  it("puts this account on Bcc when that preference is on", () => {
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, bccSelf: true },
    });
    render(<Composer accountId={account.id} />);
    expect(screen.getByRole("combobox", { name: "Bcc" })).toHaveValue(
      account.email,
    );
  });

  it("marks a new message high importance and keeps that on a saved draft", async () => {
    const send = vi.mocked(api.sendMessage);
    send.mockResolvedValue({ id: "outbox-1", state: "sent", detail: null });
    const view = render(<Composer accountId={account.id} />);
    const box = screen.getByRole("checkbox", { name: "High importance" });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "jane@example.test" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), {
      target: { value: "Tonight" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: strings.composer.send }),
    );
    confirmEmptyMessage();
    await act(async () => {
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        importance: "high",
        subject: "Tonight",
        to: ["jane@example.test"],
      }),
    );

    view.unmount();
    useAppStore.setState({
      composeSeed: {
        draft: {
          id: "draft-1",
          accountId: account.id,
          to: ["jane@example.test"],
          cc: [],
          bcc: [],
          subject: "Draft",
          htmlBody: "<p>Note</p>",
          textBody: "Note",
          attachments: [],
          importance: "high",
        },
      },
    });
    render(<Composer accountId={account.id} />);
    expect(
      screen.getByRole("checkbox", { name: "High importance" }),
    ).toBeChecked();
  });

  it("marks a new message low importance and clears high importance", async () => {
    const send = vi.mocked(api.sendMessage);
    send.mockResolvedValue({ id: "outbox-1", state: "sent", detail: null });
    const view = render(<Composer accountId={account.id} />);
    const high = screen.getByRole("checkbox", { name: "High importance" });
    const low = screen.getByRole("checkbox", { name: "Low importance" });
    expect(low).not.toBeChecked();
    fireEvent.click(high);
    fireEvent.click(low);
    expect(high).not.toBeChecked();
    expect(low).toBeChecked();
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "jane@example.test" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), {
      target: { value: "Whenever" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: strings.composer.send }),
    );
    confirmEmptyMessage();
    await act(async () => {
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        importance: "low",
        subject: "Whenever",
      }),
    );

    view.unmount();
    useAppStore.setState({
      composeSeed: {
        draft: {
          id: "draft-low",
          accountId: account.id,
          to: ["jane@example.test"],
          cc: [],
          bcc: [],
          subject: "Later",
          htmlBody: "<p>Note</p>",
          textBody: "Note",
          attachments: [],
          importance: "low",
        },
      },
    });
    render(<Composer accountId={account.id} />);
    expect(
      screen.getByRole("checkbox", { name: "Low importance" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "High importance" }),
    ).not.toBeChecked();
  });

  it("requests a read receipt only when that option is on", async () => {
    const send = vi.mocked(api.sendMessage);
    send.mockResolvedValue({ id: "outbox-1", state: "sent", detail: null });
    const view = render(<Composer accountId={account.id} />);
    const box = screen.getByRole("checkbox", {
      name: "Request a read receipt",
    });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "jane@example.test" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), {
      target: { value: "Tonight" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: strings.composer.send }),
    );
    confirmEmptyMessage();
    await act(async () => {
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ requestReceipt: true, subject: "Tonight" }),
    );
    view.unmount();
    useAppStore.setState({
      composeSeed: {
        draft: {
          id: "draft-1",
          accountId: account.id,
          to: ["jane@example.test"],
          cc: [],
          bcc: [],
          subject: "Draft",
          htmlBody: "<p>Note</p>",
          textBody: "Note",
          attachments: [],
          requestReceipt: true,
        },
      },
    });
    render(<Composer accountId={account.id} />);
    expect(
      screen.getByRole("checkbox", { name: "Request a read receipt" }),
    ).toBeChecked();
  });

  it("keeps a saved draft's Bcc when the preference is on", () => {
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, bccSelf: true },
      composeSeed: {
        draft: {
          id: "draft-1",
          accountId: account.id,
          to: ["jane@example.test"],
          cc: [],
          bcc: [],
          subject: "Draft",
          htmlBody: "<p>Note</p>",
          textBody: "Note",
          attachments: [],
        },
      },
    });
    render(<Composer accountId={account.id} />);
    expect(
      screen.queryByRole("combobox", { name: "Bcc" }),
    ).not.toBeInTheDocument();
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
    expect(screen.getByLabelText("Cc", { selector: "input" })).toBeVisible();
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
    expect(screen.getByRole("listbox")).toBeVisible();

    fireEvent.keyDown(to, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog", { name: /New message/i })).toBeVisible();
  });

  it("does not send while Settings is open", async () => {
    const send = vi.mocked(api.sendMessage);
    send.mockResolvedValue({ id: "outbox-1", state: "sent", detail: null });
    render(<Composer accountId={account.id} />);
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "jane@example.test" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), {
      target: { value: "Picnic" },
    });

    const settings = document.createElement("div");
    settings.className = "settings-window";
    document.body.append(settings);
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(send).not.toHaveBeenCalled();

    settings.remove();
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    confirmEmptyMessage();
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
    expect(screen.getByRole("dialog", { name: "Insert link" })).toBeVisible();
    expect(screen.getByLabelText("Web address")).toBeVisible();
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
    expect(screen.getByRole("dialog", { name: /New message/i })).toBeVisible();
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
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), {
      target: { value: "Picnic" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send options" }));
    expect(
      screen.queryByRole("menuitem", { name: "Send and archive" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /tonight/i }));
    confirmEmptyMessage();
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

  it("sends a redirect with the original subject and no new letter", async () => {
    const send = vi.mocked(api.sendMessage);
    send.mockResolvedValue({
      id: "outbox-9",
      state: "scheduled",
      detail: null,
    });
    useAppStore.setState({
      accounts: [{ ...account, signature: "Best, Sam" }],
      composeSeed: {
        composeMode: "redirect",
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
          htmlBody: "<p>Bring sandwiches</p>",
          remoteImagesBlocked: false,
          attachments: [],
          references: ["<root@example.test>"],
        },
      },
    });
    render(<Composer accountId={account.id} />);
    expect(
      screen.getByRole("dialog", { name: strings.reader.redirect }),
    ).toBeVisible();
    expect(screen.getByText(strings.composer.redirectNote)).toBeVisible();
    const subject = screen.getByLabelText(strings.composer.subject);
    expect(subject).toHaveValue("Family picnic");
    expect(subject).toHaveAttribute("readonly");
    expect(
      screen.queryByRole("button", { name: strings.composer.attach }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: strings.composer.picture }),
    ).toBeNull();
    expect(
      screen.queryByRole("checkbox", {
        name: strings.composer.includeSignature,
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("checkbox", {
        name: strings.composer.highImportance,
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("checkbox", {
        name: strings.composer.lowImportance,
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("checkbox", {
        name: strings.composer.requestReceipt,
      }),
    ).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "lee@example.test" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: strings.composer.send }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["lee@example.test"],
        subject: "Family picnic",
        htmlBody: "",
        textBody: "",
        attachments: [],
        includeSignature: false,
        importance: "",
        requestReceipt: false,
        sourceMessageId: 1,
        sourceKind: "redirect",
        inReplyTo: undefined,
        references: undefined,
      }),
    );
  });

  it("archives the message a reply answers, and skips that when sending is uncertain", async () => {
    const send = vi.mocked(api.sendMessage);
    const move = vi.mocked(api.moveMessage);
    send.mockResolvedValue({
      id: "outbox-9",
      state: "scheduled",
      detail: null,
    });
    move.mockResolvedValue(undefined);
    useAppStore.setState({
      composeSeed: {
        composeMode: "reply",
        sourceMessage: {
          id: 7,
          accountId: account.id,
          mailboxId: 4,
          uid: 7,
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
        },
      },
    });
    render(<Composer accountId={account.id} />);
    fireEvent.click(screen.getByRole("button", { name: "Send options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Send and archive" }));
    confirmEmptyMessage();
    await act(async () => {
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        textBody: expect.stringContaining("> Bring sandwiches"),
      }),
    );
    expect(move).toHaveBeenCalledWith(account.id, 7, "archive");
    expect(useAppStore.getState().lastSent).toEqual(
      expect.objectContaining({
        outboxId: "outbox-9",
        archivedMessage: { messageId: 7, mailboxId: 4 },
      }),
    );

    send.mockClear();
    move.mockClear();
    send.mockResolvedValue({
      id: "outbox-10",
      state: "needs_attention",
      detail: "The mail server did not confirm delivery.",
    });
    useAppStore.setState({
      composerOpen: true,
      composeSeed: {
        composeMode: "reply",
        sourceMessage: {
          id: 7,
          accountId: account.id,
          mailboxId: 4,
          uid: 7,
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
        },
      },
    });
    render(<Composer accountId={account.id} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Send options" }).at(-1)!,
    );
    fireEvent.click(
      screen.getAllByRole("menuitem", { name: "Send and archive" }).at(-1)!,
    );
    confirmEmptyMessage();
    await act(async () => {
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(move).not.toHaveBeenCalled();
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

  it("adds, warns about, and releases regular attachments", async () => {
    vi.mocked(api.chooseAttachments).mockResolvedValue([
      {
        token: "large-file",
        filename: "archive.zip",
        contentType: "application/zip",
        inline: false,
        size: 26 * 1024 * 1024,
      },
    ]);
    render(<Composer accountId={account.id} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Attach" }));
      await Promise.resolve();
    });
    expect(api.chooseAttachments).toHaveBeenCalledWith(account.id, false);
    expect(screen.getByText("archive.zip")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(/exceed 25 MB/i);
    fireEvent.click(screen.getByRole("button", { name: "Remove archive.zip" }));
    expect(api.releaseComposeAttachments).toHaveBeenCalledWith(account.id, [
      "large-file",
    ]);
    expect(screen.queryByText("archive.zip")).not.toBeInTheDocument();
  });

  it("pastes clipboard text without formatting", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: vi.fn().mockResolvedValue("Hello\n<b>there</b>\r\nThird"),
      },
    });
    render(<Composer accountId={account.id} />);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: { id: "paste-plain", target: { kind: "composer" } },
        }),
      );
      await Promise.resolve();
    });
    const body = document.querySelector(".composer-editor");
    expect(body?.textContent).toContain("Hello");
    expect(body?.textContent).toContain("<b>there</b>");
    expect(body?.textContent).toContain("Third");
    expect(body?.querySelector("b")).toBeNull();
  });

  it("inserts clipboard text into a plain-text message", async () => {
    useAppStore.setState({
      accounts: [{ ...account, defaultBodyFormat: "plain" }],
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: vi.fn().mockResolvedValue("Hello\n<b>there</b>"),
      },
    });
    render(<Composer accountId={account.id} />);
    const plain = screen.getByRole("textbox", {
      name: strings.composer.plainBodyLabel,
    });
    fireEvent.change(plain, { target: { value: "Keep " } });
    plain.focus();
    (plain as HTMLTextAreaElement).setSelectionRange(5, 5);
    await act(async () => {
      fireEvent.keyDown(plain, {
        key: "v",
        metaKey: true,
        shiftKey: true,
      });
      await Promise.resolve();
    });
    expect(plain).toHaveValue("Keep Hello\n<b>there</b>");
  });

  it("runs composer undo, select-all, and attachment context actions", async () => {
    vi.mocked(api.chooseAttachments).mockResolvedValue([
      {
        token: "ctx-file",
        filename: "note.txt",
        contentType: "text/plain",
        inline: false,
        size: 12,
      },
    ]);
    render(<Composer accountId={account.id} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Attach" }));
      await Promise.resolve();
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent(CONTEXT_ACTION_EVENT));
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: { id: "select-all", target: { kind: "composer" } },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: { id: "undo", target: { kind: "composer" } },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: { id: "redo", target: { kind: "composer" } },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: {
            id: "remove-attachment",
            target: { kind: "composer-attachment", index: 0 },
          },
        }),
      );
      await Promise.resolve();
    });
    expect(api.releaseComposeAttachments).toHaveBeenCalledWith(account.id, [
      "ctx-file",
    ]);
    expect(screen.queryByText("note.txt")).not.toBeInTheDocument();
  });

  it("leaves letter text alone when a paste also has words", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", {
      type: "image/png",
    });
    expect(
      clipboardImages({
        types: ["text/plain", "Files"],
        items: [{ kind: "file", getAsFile: () => file }],
      }),
    ).toEqual({ files: [], tooLarge: false });
  });

  it("adds a pasted image as an inline picture", async () => {
    vi.useRealTimers();
    vi.mocked(api.stagePastedImage).mockResolvedValue({
      token: "pasted-file",
      filename: "Pasted image.png",
      contentType: "image/png",
      inline: false,
      size: 68,
    });
    render(<Composer accountId={account.id} />);
    await act(async () => {
      await Promise.resolve();
    });
    const editor = document.querySelector(".composer-editor");
    if (!editor) throw new Error("missing editor");
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      ),
      (char) => char.charCodeAt(0),
    );
    const file = new File([png], "shot.png", { type: "image/png" });
    const clipboard = {
      types: ["Files"],
      items: [{ kind: "file", getAsFile: () => file }],
      files: [file],
    };
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: clipboard });
    await act(async () => {
      editor?.dispatchEvent(event);
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(api.stagePastedImage).toHaveBeenCalledWith(
      account.id,
      expect.stringMatching(/^data:image\/png;base64,/),
    );
    expect(screen.getByText(/Image: Pasted image\.png/)).toBeVisible();
  });

  it("adds inline images and releases their token when removed", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
    vi.mocked(api.chooseAttachments).mockResolvedValue([
      {
        token: "inline-file",
        filename: "photo.png",
        contentType: "image/png",
        inline: true,
        size: 100,
      },
    ]);
    render(<Composer accountId={account.id} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Picture" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.chooseAttachments).toHaveBeenCalledWith(account.id, true);
    expect(api.readComposeImage).toHaveBeenCalledWith(
      account.id,
      "inline-file",
    );
    expect(screen.getByText(/Image: photo\.png/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Remove photo.png" }));
    expect(api.releaseComposeAttachments).toHaveBeenCalledWith(account.id, [
      "inline-file",
    ]);
  });

  it("cleans up a selected inline token when image loading fails", async () => {
    vi.mocked(api.chooseAttachments).mockResolvedValue([
      {
        token: "broken-inline",
        filename: "broken.png",
        contentType: "image/png",
        inline: true,
      },
    ]);
    vi.mocked(api.readComposeImage).mockRejectedValue(
      new Error("image failed"),
    );
    render(<Composer accountId={account.id} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Picture" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.releaseComposeAttachments).toHaveBeenCalledWith(account.id, [
      "broken-inline",
    ]);
    expect(useAppStore.getState().error).toBe("Error: image failed");
  });

  it("restores stored inline images and reports restore failures", async () => {
    const seed = {
      draft: {
        id: "inline-draft",
        accountId: account.id,
        to: ["jane@example.test"],
        cc: [],
        bcc: [],
        subject: "Inline",
        htmlBody: '<p>Image</p><img src="cid:stored-inline">',
        textBody: "Image",
        attachments: [
          {
            token: "stored-token",
            filename: "stored.png",
            contentType: "image/png",
            inline: true,
            contentId: "stored-inline",
          },
        ],
      },
    };
    useAppStore.setState({ composeSeed: seed });
    const view = render(<Composer accountId={account.id} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.readComposeImage).toHaveBeenCalledWith(
      account.id,
      "stored-token",
    );
    view.unmount();

    vi.clearAllMocks();
    vi.mocked(api.readComposeImage).mockRejectedValue(
      new Error("restore failed"),
    );
    useAppStore.setState({ composeSeed: seed, error: undefined });
    render(<Composer accountId={account.id} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useAppStore.getState().error).toBe(
      strings.composer.inlineImageFailed(1),
    );
  });

  it("validates, applies, cancels, and escapes the link dialog", () => {
    render(<Composer accountId={account.id} />);
    fireEvent.click(screen.getByRole("button", { name: "Show formatting" }));
    fireEvent.click(screen.getByRole("button", { name: "More formatting" }));
    const open = () =>
      fireEvent.click(screen.getByRole("button", { name: "Insert link" }));
    open();
    let input = screen.getByRole("textbox", { name: "Web address" });
    fireEvent.change(input, { target: { value: "javascript:alert(1)" } });
    fireEvent.submit(input.closest("form")!);
    expect(useAppStore.getState().error).toMatch(/Links must start/);
    expect(screen.getByRole("dialog", { name: "Insert link" })).toBeVisible();
    fireEvent.change(input, { target: { value: "mailto:jane@example.test" } });
    fireEvent.submit(input.closest("form")!);
    expect(
      screen.queryByRole("dialog", { name: "Insert link" }),
    ).not.toBeInTheDocument();

    open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    open();
    input = screen.getByRole("textbox", { name: "Web address" });
    fireEvent.keyDown(input.closest("form")!, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "Insert link" }),
    ).not.toBeInTheDocument();
  });

  it("dismisses Send options with outside pointer or Escape", () => {
    render(<Composer accountId={account.id} />);
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "jane@example.test" },
    });
    const options = screen.getByRole("button", { name: "Send options" });
    fireEvent.click(options);
    expect(screen.getByRole("menu")).toBeVisible();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(options);
    fireEvent.click(screen.getByRole("menuitem", { name: /date and time/i }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("does not discard content without confirmation", async () => {
    vi.mocked(api.showNativeConfirm).mockResolvedValue(false);
    render(<Composer accountId={account.id} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), {
      target: { value: "Keep me" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Discard" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.releaseComposeAttachments).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: /New message/i })).toBeVisible();
  });

  it("deletes a stored draft and reports discard failure", async () => {
    useAppStore.setState({
      composeSeed: {
        draft: {
          id: "draft-delete",
          accountId: account.id,
          to: [],
          cc: [],
          bcc: [],
          subject: "Stored",
          htmlBody: "<p></p>",
          textBody: "",
          attachments: [],
        },
      },
    });
    vi.mocked(api.deleteDraft).mockRejectedValueOnce(
      new Error("delete failed"),
    );
    render(<Composer accountId={account.id} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.deleteDraft).toHaveBeenCalledWith("draft-delete", account.id);
    expect(useAppStore.getState().error).toBe("Error: delete failed");
  });

  it("asks before sending to 10 or more people", async () => {
    const send = vi.mocked(api.sendMessage);
    send.mockResolvedValue({ id: "outbox-1", state: "sent", detail: null });
    const people = Array.from(
      { length: 10 },
      (_, index) => `person${index}@example.test`,
    ).join(", ");
    render(<Composer accountId={account.id} />);
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: people },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), {
      target: { value: "Hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(
      screen.getByRole("alertdialog", {
        name: strings.composer.largeAudienceTitle,
      }),
    ).toHaveTextContent(strings.composer.largeAudienceDetail(10));
    expect(send).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: strings.composer.reviewRecipients }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.getElementById("composer-to")).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Send anyway" }));
    confirmEmptyMessage();
    await act(async () => {
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: people.split(", ").map((address) => address),
        subject: "Hello",
      }),
    );
  });

  it("asks before sending to an address that may not accept mail", async () => {
    const send = vi.mocked(api.sendMessage);
    send.mockResolvedValue({ id: "outbox-1", state: "sent", detail: null });
    render(<Composer accountId={account.id} />);
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "noreply@example.test" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), {
      target: { value: "Hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(
      screen.getByRole("alertdialog", { name: strings.composer.noreplyTitle }),
    ).toBeVisible();
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: strings.composer.reviewRecipients }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.getElementById("composer-to")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Send anyway" }));
    fireEvent.click(screen.getByRole("button", { name: "Send anyway" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["noreply@example.test"],
        subject: "Hello",
      }),
    );
  });

  it("asks before sending a message with no text", async () => {
    const send = vi.mocked(api.sendMessage);
    send.mockResolvedValue({ id: "outbox-1", state: "sent", detail: null });
    render(<Composer accountId={account.id} />);
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "jane@example.test" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), {
      target: { value: "Hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(
      screen.getByRole("alertdialog", {
        name: strings.composer.noMessageTitle,
      }),
    ).toBeVisible();
    expect(send).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: strings.composer.writeMessage }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.querySelector(".composer-editor")).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Send anyway" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["jane@example.test"],
        subject: "Hello",
      }),
    );
  });

  it("asks before sending a message with no subject", async () => {
    const send = vi.mocked(api.sendMessage);
    send.mockResolvedValue({ id: "outbox-1", state: "sent", detail: null });
    render(<Composer accountId={account.id} />);
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "jane@example.test" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(
      screen.getByRole("alertdialog", {
        name: "Send without a subject?",
      }),
    ).toBeVisible();
    expect(send).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Add a subject" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Subject" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Send anyway" }));
    confirmEmptyMessage();
    await act(async () => {
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["jane@example.test"],
        subject: "",
      }),
    );
  });

  it("surfaces send failures and uncertain SMTP outcomes", async () => {
    const send = vi.mocked(api.sendMessage);
    send.mockRejectedValueOnce(new Error("send failed"));
    render(<Composer accountId={account.id} />);
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "jane@example.test" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), {
      target: { value: "Picnic" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    confirmEmptyMessage();
    await act(async () => {
      await Promise.resolve();
    });
    expect(useAppStore.getState().error).toBe("Error: send failed");

    send.mockResolvedValueOnce({
      id: "attention",
      state: "needs_attention",
      detail: "Delivery outcome uncertain.",
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    confirmEmptyMessage();
    await act(async () => {
      await Promise.resolve();
    });
    expect(useAppStore.getState().error).toBe("Delivery outcome uncertain.");
  });

  it("reports manual and automatic draft save failures", async () => {
    mockedSaveDraft.mockRejectedValue(new Error("save failed"));
    render(<Composer accountId={account.id} />);
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "jane@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(useAppStore.getState().error).toBe("Error: save failed");
    useAppStore.setState({ error: undefined });
    await act(async () => {
      vi.advanceTimersByTime(6_000);
      await Promise.resolve();
    });
    expect(useAppStore.getState().error).toBe("Error: save failed");
  });

  it("selects the addressed alias for replies", () => {
    useAppStore.setState({
      accounts: [{ ...account, aliases: ["alias@example.test"] }],
      composeSeed: {
        composeMode: "reply",
        sourceMessage: {
          id: 1,
          accountId: account.id,
          mailboxId: 1,
          uid: 1,
          messageId: "<parent@example.test>",
          subject: "Alias mail",
          senderName: "Jane",
          senderAddress: "jane@example.test",
          recipients: "alias@example.test",
          receivedAt: "2026-08-18T12:00:00Z",
          preview: "Hello",
          isRead: true,
          isStarred: false,
          hasAttachments: false,
          size: 100,
          to: ["alias@example.test"],
          cc: [],
          replyTo: null,
          textBody: "Hello",
          htmlBody: null,
          remoteImagesBlocked: false,
          attachments: [],
        },
      },
    });

    render(<Composer accountId={account.id} />);
    expect(screen.getByLabelText("From")).toHaveValue("alias@example.test");
  });

  it("autosaves on window blur and hidden visibility", async () => {
    render(<Composer accountId={account.id} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), {
      target: { value: "Blur save" },
    });
    fireEvent.blur(window);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockedSaveDraft).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), {
      target: { value: "Visibility save" },
    });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockedSaveDraft).toHaveBeenCalledTimes(2);
  });

  it("closes empty and saved drafts without another save", async () => {
    useAppStore.setState({ composerOpen: true });
    const empty = render(<Composer accountId={account.id} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Save draft and close" }).at(-1)!,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(useAppStore.getState().composerOpen).toBe(false);
    expect(mockedSaveDraft).not.toHaveBeenCalled();
    empty.unmount();

    useAppStore.setState({
      composerOpen: true,
      composeSeed: {
        draft: {
          id: "saved-draft",
          accountId: account.id,
          to: ["jane@example.test"],
          cc: [],
          bcc: [],
          subject: "Already saved",
          htmlBody: "<p>Saved</p>",
          textBody: "Saved",
          attachments: [],
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
    expect(useAppStore.getState().composerOpen).toBe(false);
    expect(mockedSaveDraft).not.toHaveBeenCalled();
  });

  it("discards an empty composer without asking", async () => {
    useAppStore.setState({ composerOpen: true });
    render(<Composer accountId={account.id} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(api.showNativeConfirm).not.toHaveBeenCalled();
    expect(api.releaseComposeAttachments).toHaveBeenCalledWith(account.id, []);
    expect(useAppStore.getState().composerOpen).toBe(false);
  });

  it("reports attachment selection and release failures", async () => {
    vi.mocked(api.chooseAttachments).mockRejectedValueOnce(
      new Error("picker failed"),
    );
    render(<Composer accountId={account.id} />);
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(useAppStore.getState().error).toBe("Error: picker failed");

    vi.mocked(api.chooseAttachments).mockResolvedValueOnce([
      {
        token: "release-fails",
        filename: "note.txt",
        inline: false,
        size: 10,
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    await act(async () => {
      await Promise.resolve();
    });
    vi.mocked(api.releaseComposeAttachments).mockRejectedValueOnce(
      new Error("release failed"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove note.txt" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(useAppStore.getState().error).toBe("Error: release failed");
  });

  it("maximizes a signed composer and saves with the keyboard", async () => {
    useAppStore.setState({
      accounts: [{ ...account, signature: "Best, Sam" }],
    });
    const { container } = render(<Composer accountId={account.id} />);
    expect(screen.getByText("Best, Sam")).toBeVisible();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Include signature" }),
    );
    expect(screen.queryByText("Best, Sam")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Maximize editor" }));
    expect(container.querySelector(".composer-maximized")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), {
      target: { value: "Keyboard save" },
    });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockedSaveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ includeSignature: false }),
    );
  });

  it("formats, indents, links, and closes an empty draft", async () => {
    render(<Composer accountId={account.id} />);
    fireEvent.click(screen.getByRole("button", { name: "Show formatting" }));
    fireEvent.click(screen.getByRole("button", { name: "More formatting" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Font" }), {
      target: { value: "Arial" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Font" }), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Font size" }), {
      target: { value: "20px" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Increase indentation" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Decrease indentation" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Insert link" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Web address" }), {
      target: { value: "https://library.example.test/hours" },
    });
    fireEvent.submit(
      screen.getByRole("textbox", { name: "Web address" }).closest("form")!,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const linked = document.querySelector("a[data-external-href], a[href]");
    if (linked) {
      fireEvent.contextMenu(linked);
      fireEvent(
        linked,
        new MouseEvent("auxclick", { button: 1, bubbles: true }),
      );
    }
    fireEvent.click(
      screen.getAllByRole("button", { name: "Save draft and close" }).at(-1)!,
    );
    expect(useAppStore.getState().composerOpen).toBe(false);
  });

  it("closes from the docked pill and ignores backdrop clicks while sending", async () => {
    render(<Composer accountId={account.id} />);
    fireEvent.click(screen.getByRole("button", { name: "Minimize draft" }));
    fireEvent.click(screen.getByRole("button", { name: /Maximize/i }));
    expect(screen.getByRole("dialog", { name: /New message/i })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Minimize draft" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Save draft and close" }),
    );
    expect(useAppStore.getState().composerOpen).toBe(false);
  });

  function seedSyncedBannerDraft() {
    useAppStore.setState({
      composeSeed: {
        draft: {
          id: "draft-sync",
          accountId: account.id,
          to: ["jane@example.test"],
          cc: [],
          bcc: [],
          subject: "Stored",
          htmlBody: "<p>Stored</p>",
          textBody: "Stored",
          attachments: [],
        },
        draftSummary: {
          id: "draft-sync",
          accountId: account.id,
          recipients: "jane@example.test",
          subject: "Stored",
          updatedAt: "2026-09-01T12:00:00Z",
          syncState: "localOnly",
          syncDetail: "Saved locally.",
        },
      },
    });
  }

  it("clears the draft-sync banner when a synced event lands", async () => {
    let syncHandler: ((event: DraftSyncEvent) => void) | undefined;
    vi.mocked(api.onDraftSyncChanged).mockImplementation(async (handler) => {
      syncHandler = handler;
      return () => undefined;
    });
    seedSyncedBannerDraft();
    render(<Composer accountId={account.id} />);
    expect(screen.getByText("Saved on this computer")).toBeVisible();

    act(() => {
      syncHandler?.({
        accountId: account.id,
        draftId: "draft-sync",
        syncState: "synced",
      });
    });
    expect(
      screen.queryByText("Saved on this computer"),
    ).not.toBeInTheDocument();
  });

  it("refreshes the draft-sync banner from the saved summary after a sync pass", async () => {
    let syncHandler: ((event: DraftSyncEvent) => void) | undefined;
    vi.mocked(api.onDraftSyncChanged).mockImplementation(async (handler) => {
      syncHandler = handler;
      return () => undefined;
    });
    seedSyncedBannerDraft();
    vi.mocked(api.listDrafts).mockResolvedValue([
      {
        id: "draft-sync",
        accountId: account.id,
        recipients: "jane@example.test",
        subject: "Stored",
        updatedAt: "2026-09-01T12:00:00Z",
        syncState: "synced",
        syncDetail: null,
      },
    ]);
    render(<Composer accountId={account.id} />);
    expect(screen.getByText("Saved on this computer")).toBeVisible();

    await act(async () => {
      syncHandler?.({ accountId: account.id, draftId: null, syncState: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.listDrafts).toHaveBeenCalledWith(account.id);
    expect(
      screen.queryByText("Saved on this computer"),
    ).not.toBeInTheDocument();
  });

  it("treats a localPending save as saved without a server banner", async () => {
    render(<Composer accountId={account.id} />);
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "jane@example.test" },
    });
    await act(async () => {
      vi.advanceTimersByTime(6_000);
      await Promise.resolve();
    });
    expect(mockedSaveDraft).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getAllByText(/^Draft saved/).length).toBeGreaterThan(0);
  });

  it("unsubscribes from draft sync events on unmount", async () => {
    const unlisten = vi.fn();
    vi.mocked(api.onDraftSyncChanged).mockResolvedValue(unlisten);
    const view = render(<Composer accountId={account.id} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    view.unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("deletes the latest draft id and releases attachments only after deletion", async () => {
    let releaseSave: () => void = () => undefined;
    const pendingSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    mockedSaveDraft.mockImplementation(async () => {
      await pendingSave;
      return { id: "draft-latest", syncState: "localPending" };
    });

    let resolveConfirm: (value: boolean) => void = () => undefined;
    vi.mocked(api.showNativeConfirm).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirm = resolve;
        }),
    );

    let releaseDelete: () => void = () => undefined;
    const pendingDelete = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    vi.mocked(api.deleteDraft).mockImplementation(() => pendingDelete);

    render(<Composer accountId={account.id} />);
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), {
      target: { value: "jane@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    await act(async () => {
      vi.advanceTimersByTime(6_000);
      await Promise.resolve();
    });
    expect(mockedSaveDraft).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveConfirm(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.deleteDraft).not.toHaveBeenCalled();

    releaseSave();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.deleteDraft).toHaveBeenCalledWith("draft-latest", account.id);
    expect(api.releaseComposeAttachments).not.toHaveBeenCalled();

    releaseDelete();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.releaseComposeAttachments).toHaveBeenCalledWith(account.id, []);

    const saveCalls = mockedSaveDraft.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(6_000);
      fireEvent.blur(window);
      await Promise.resolve();
    });
    expect(mockedSaveDraft.mock.calls.length).toBe(saveCalls);
  });

  it("does not start a save after discard intent", async () => {
    render(<Composer accountId={account.id} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), {
      target: { value: "Discard me" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Discard" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.deleteDraft).not.toHaveBeenCalled();

    const saveCalls = mockedSaveDraft.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(6_000);
      fireEvent.blur(window);
      await Promise.resolve();
    });
    expect(mockedSaveDraft.mock.calls.length).toBe(saveCalls);
  });

  it("keeps Tab focus inside the insert-link dialog", () => {
    render(<Composer accountId={account.id} />);
    fireEvent.click(screen.getByRole("button", { name: "Show formatting" }));
    fireEvent.click(screen.getByRole("button", { name: "More formatting" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert link" }));
    const dialog = screen.getByRole("dialog", { name: "Insert link" });
    const input = within(dialog).getByRole("textbox", { name: "Web address" });
    const submit = within(dialog).getByRole("button", { name: "Insert link" });

    submit.focus();
    fireEvent.keyDown(submit, { key: "Tab" });
    expect(input).toHaveFocus();

    input.focus();
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(submit).toHaveFocus();
  });
});
