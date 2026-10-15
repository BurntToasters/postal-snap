import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { clearBlockedSenders } from "../blockedSenders";
import { MessageReader } from "../components/MessageReader";
import { markHtmlText } from "../searchHighlight";
import { CONTEXT_ACTION_EVENT } from "../contextMenu";
import { strings } from "../i18n";
import { defaultSettings, useAppStore } from "../store";
import type { MessageDetail } from "../types";
import { makeMailbox, makeMessage, messageDetail } from "./helpers/fixtures";
import { resetStore } from "./helpers/store";

const inbox = makeMailbox({ unreadCount: 2, totalCount: 2 });
const archive = makeMailbox({
  id: 2,
  name: "Archive",
  displayName: "Archive",
  role: "archive",
  unreadCount: 0,
  totalCount: 0,
});
const trash = makeMailbox({
  id: 3,
  name: "Trash",
  displayName: "Trash",
  role: "trash",
  unreadCount: 0,
  totalCount: 0,
});
const junk = makeMailbox({
  id: 4,
  name: "Junk",
  displayName: "Junk",
  role: "junk",
  unreadCount: 0,
  totalCount: 0,
});
const custom = makeMailbox({
  id: 5,
  name: "Receipts",
  displayName: "Receipts",
  role: "other",
  unreadCount: 0,
  totalCount: 0,
});

function readerMessage(overrides: Partial<MessageDetail> = {}) {
  return messageDetail(
    makeMessage({
      preview: "Visit https://example.test or mail jane@example.test",
    }),
    {
      textBody: "Visit https://example.test or mail jane@example.test",
      attachments: [
        {
          id: "photo",
          filename: "photo.png",
          contentType: "image/png",
          size: 1024,
          inline: false,
        },
      ],
      ...overrides,
    },
  );
}

function setReaderState(message = readerMessage()) {
  resetStore({
    mailboxes: [inbox, archive, trash, junk, custom],
    activeMailboxId: message.mailboxId,
    messages: [message],
    selectedMessage: message,
    settings: { ...defaultSettings, readingPane: "right" },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  document
    .querySelectorAll('iframe[aria-hidden="true"]')
    .forEach((frame) => frame.remove());
  document.querySelector(".print-host")?.remove();
  setReaderState();
  clearBlockedSenders();
  vi.spyOn(api, "setMessageFlags").mockResolvedValue(undefined);
  vi.spyOn(api, "listFilterRules").mockResolvedValue([]);
  vi.spyOn(api, "deleteFilterRule").mockResolvedValue(undefined);
  vi.spyOn(api, "moveMessage").mockResolvedValue(undefined);
  vi.spyOn(api, "moveMessageToMailbox").mockResolvedValue(undefined);
  vi.spyOn(api, "prepareForwardAttachments").mockResolvedValue([]);
  vi.spyOn(api, "prepareReplyAttachments").mockResolvedValue([]);
  vi.spyOn(api, "previewAttachment").mockResolvedValue({
    filename: "photo.png",
    contentType: "image/png",
    size: 1024,
    imageDataUrl: "data:image/png;base64,AA==",
  });
  vi.spyOn(api, "saveAttachment").mockResolvedValue(undefined);
  vi.spyOn(api, "snoozeMessage").mockResolvedValue(undefined);
  vi.spyOn(api, "snoozeMessages").mockResolvedValue(undefined);
  vi.spyOn(api, "inspectExternalUrl").mockResolvedValue({
    url: "https://example.test/",
    hostname: "example.test",
    reportedThreat: false,
  });
  vi.spyOn(api, "showNativeConfirm").mockResolvedValue(true);
  vi.spyOn(api, "openExternalUrl").mockResolvedValue(undefined);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollBy", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("MessageReader", () => {
  it("renders empty and hidden-pane states", () => {
    useAppStore.setState({ selectedMessage: undefined });
    const { rerender } = render(<MessageReader />);
    expect(screen.getByText(strings.mail.noMessage)).toBeVisible();
    // Quiet text only, like Mail: no app mark or icon.
    expect(document.querySelector(".empty-reader img")).toBeNull();
    expect(document.querySelector(".empty-reader svg")).toBeNull();
    useAppStore.setState({
      settings: { ...defaultSettings, readingPane: "hidden" },
    });
    rerender(<MessageReader />);
    expect(document.getElementById("reader-pane")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("opens the next message when the reader is already at the end", () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    setReaderState(
      readerMessage({ htmlBody: "<p>Short note</p>", textBody: "" }),
    );
    render(<MessageReader onNext={onNext} onPrevious={onPrevious} />);
    const iframe = screen.getByTitle(
      strings.reader.messageContent,
    ) as HTMLIFrameElement;
    const frameWindow = iframe.contentWindow!;
    const scrolling = frameWindow.document.documentElement;
    Object.defineProperty(scrolling, "scrollHeight", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(frameWindow, "innerHeight", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(frameWindow, "scrollY", {
      configurable: true,
      value: 0,
    });
    const scrollBy = vi
      .spyOn(frameWindow, "scrollBy")
      .mockImplementation(() => undefined);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("postal:scroll-reader", { detail: 1 }),
      );
    });
    expect(onNext).toHaveBeenCalledOnce();
    expect(scrollBy).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(
        new CustomEvent("postal:scroll-reader", { detail: -1 }),
      );
    });
    expect(onPrevious).toHaveBeenCalledOnce();

    Object.defineProperty(scrolling, "scrollHeight", {
      configurable: true,
      value: 2000,
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent("postal:scroll-reader", { detail: 1 }),
      );
    });
    expect(scrollBy).toHaveBeenCalledWith(0, expect.any(Number));
    expect(onNext).toHaveBeenCalledOnce();
  });

  it("says how many times a word appears in the open message", () => {
    setReaderState(
      readerMessage({
        htmlBody: "<p>See Saturday morning.</p>",
        textBody: "See Saturday morning.",
      }),
    );
    render(<MessageReader />);
    act(() => {
      window.dispatchEvent(new Event("postal:find-in-message"));
    });
    const input = screen.getByRole("textbox", {
      name: strings.reader.findInMessage,
    });
    fireEvent.change(input, { target: { value: "missing" } });
    fireEvent.submit(input.closest("form")!);
    expect(screen.getByRole("status")).toHaveTextContent(
      strings.reader.findNoMatches,
    );
    fireEvent.change(input, { target: { value: "Saturday" } });
    fireEvent.submit(input.closest("form")!);
    expect(screen.getByRole("status")).toHaveTextContent(
      strings.reader.findMatchCount(1, 1),
    );
  });

  it("marks a mailbox search in the open message", () => {
    expect(
      markHtmlText("<p>See Saturday morning.</p>", ["Saturday"]),
    ).toContain("<mark>Saturday</mark>");
    expect(
      markHtmlText("<p>See Saturday morning.</p>", [
        "<img src=x onerror=alert(1)>",
      ]),
    ).not.toContain("onerror");
    setReaderState(
      readerMessage({
        subject: "Current mailbox",
        senderName: "Jane",
        htmlBody: "<p>See Saturday morning.</p>",
        textBody: "See Saturday morning.",
      }),
    );
    render(<MessageReader searchQuery="Saturday" />);
    expect(
      screen
        .getByRole("heading", { name: "Current mailbox" })
        .querySelector("mark"),
    ).toBeNull();
    const iframe = screen.getByTitle(
      strings.reader.messageContent,
    ) as HTMLIFrameElement;
    expect(iframe.srcdoc).toContain("<mark>Saturday</mark>");
    expect(iframe.srcdoc).not.toContain("onerror");
  });

  it("asks before sending a read receipt and can decline", async () => {
    const decline = vi
      .spyOn(api, "declineReadReceipt")
      .mockResolvedValue("declined");
    setReaderState(
      readerMessage({
        dispositionTo: "jane@example.com",
        senderName: "Jane",
        senderAddress: "jane@example.com",
      }),
    );
    render(<MessageReader />);
    expect(
      screen.getByText(/A receipt would go to jane@example.com/),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Don't send" }));
    await waitFor(() => expect(decline).toHaveBeenCalledWith("account-1", 1));
    expect(
      screen.queryByText(/A receipt would go to jane@example.com/),
    ).not.toBeInTheDocument();
  });

  it("shows high importance on the open message", () => {
    setReaderState(readerMessage({ importance: "high" }));
    render(<MessageReader />);
    expect(screen.getByText("High importance")).toBeVisible();
  });

  it("handles reader and attachment context actions", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<MessageReader />);
    act(() => {
      window.dispatchEvent(new CustomEvent(CONTEXT_ACTION_EVENT));
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: { id: "find-in-message", target: { kind: "reader" } },
        }),
      );
    });
    expect(
      screen.getByRole("textbox", { name: strings.reader.findInMessage }),
    ).toBeVisible();

    act(() => {
      window.getSelection()?.removeAllRanges();
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: { id: "copy", target: { kind: "reader" } },
        }),
      );
    });
    expect(writeText).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: {
            id: "preview",
            target: {
              kind: "attachment",
              attachmentId: "photo",
              previewable: true,
              filename: "photo.png",
            },
          },
        }),
      );
    });
    expect(
      await screen.findByRole("dialog", {
        name: strings.reader.previewTitle("photo.png"),
      }),
    ).toBeVisible();
    fireEvent.click(screen.getByTitle(strings.common.close));

    act(() => {
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: {
            id: "download",
            target: {
              kind: "attachment",
              attachmentId: "photo",
              previewable: true,
              filename: "photo.png",
            },
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: { id: "print", target: { kind: "reader" } },
        }),
      );
    });
    await waitFor(() =>
      expect(api.saveAttachment).toHaveBeenCalledWith(
        "account-1",
        1,
        "photo",
        "photo.png",
      ),
    );
  });

  it("copies the subject and can open the message folder", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const onShowInFolder = vi.fn();
    render(<MessageReader onShowInFolder={onShowInFolder} />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.showDetails }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.copySubject }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("First message"),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: strings.reader.showInFolder("Inbox"),
      }),
    );
    expect(onShowInFolder).toHaveBeenCalledOnce();
  });

  it("starts a subject rule from the open message", () => {
    const seen: Array<{ field?: string; contains?: string }> = [];
    const onRule = (event: Event) => {
      seen.push(
        (event as CustomEvent<{ field?: string; contains?: string }>).detail,
      );
    };
    window.addEventListener("postal:create-rule", onRule);
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.createRuleFromSubject,
      }),
    );
    window.removeEventListener("postal:create-rule", onRule);
    expect(seen).toEqual([
      {
        accountId: "account-1",
        contains: "First message",
        field: "subject",
      },
    ]);
  });

  it("hides a subject rule when the message has no subject", () => {
    setReaderState(readerMessage({ subject: "  " }));
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    expect(
      screen.queryByRole("menuitem", {
        name: strings.reader.createRuleFromSubject,
      }),
    ).not.toBeInTheDocument();
  });

  it("copies the readable message text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    expect(
      screen.queryByRole("menuitem", {
        name: strings.reader.copyConversationText,
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.copyMessageText }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "Visit https://example.test or mail jane@example.test",
      ),
    );

    writeText.mockClear();
    setReaderState(
      readerMessage({
        textBody: "  ",
        htmlBody: "<p>Hello <b>there</b></p><script>alert(1)</script>",
      }),
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: { id: "copy-message-text", target: { kind: "reader" } },
        }),
      );
    });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Hello there"));

    writeText.mockClear();
    setReaderState(readerMessage({ textBody: "   ", htmlBody: null }));
    act(() => {
      window.dispatchEvent(
        new CustomEvent(CONTEXT_ACTION_EVENT, {
          detail: { id: "copy-message-text", target: { kind: "reader" } },
        }),
      );
    });
    await Promise.resolve();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("opens another message from the conversation list", () => {
    const current = readerMessage({
      id: 2,
      threadRoot: "<root@example.test>",
      subject: "Weekend plans",
      receivedAt: "2026-08-18T12:00:00Z",
    });
    const older = makeMessage({
      id: 1,
      threadRoot: "<root@example.test>",
      subject: "Older family note",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    resetStore({
      mailboxes: [inbox],
      activeMailboxId: 1,
      messages: [current, older],
      selectedMessage: current,
      settings: defaultSettings,
    });
    const open = vi.fn();
    render(<MessageReader onOpenInConversation={open} />);
    const list = screen.getByRole("navigation", {
      name: strings.reader.conversationMessages,
    });
    expect(
      screen.getByRole("button", { name: /Weekend plans from Jane/ }),
    ).toHaveAttribute("aria-current", "true");
    fireEvent.click(
      screen.getByRole("button", { name: /Older family note from Jane/ }),
    );
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    expect(list).toBeVisible();
  });

  it("starts a reply from the note under the message", () => {
    render(<MessageReader />);
    const box = screen.getByRole("textbox", {
      name: strings.reader.quickReply,
    });
    fireEvent.change(box, { target: { value: "See you then" } });
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.startReply }),
    );
    expect(useAppStore.getState().composeSeed).toMatchObject({
      composeMode: "reply",
      replyNote: "See you then",
    });
    expect(box).toHaveValue("");
    expect(
      screen.queryByRole("button", { name: strings.reader.startReplyAll }),
    ).toBeNull();
  });

  it("replies to everyone from the Reply button when that is the preference", () => {
    resetStore({
      settings: { ...defaultSettings, replyToAll: true },
      selectedMessage: readerMessage({
        to: ["sam@example.test", "lee@example.test"],
        cc: ["pat@example.test"],
      }),
    });
    render(<MessageReader />);
    fireEvent.click(screen.getByRole("button", { name: strings.reader.reply }));
    expect(useAppStore.getState().composeSeed?.composeMode).toBe("replyAll");
    useAppStore.setState({ composeSeed: undefined, composerOpen: false });
    window.dispatchEvent(
      new CustomEvent("postal:menu-action", { detail: "reply" }),
    );
    expect(useAppStore.getState().composeSeed?.composeMode).toBe("reply");
  });

  it("starts a reply to everyone when the note would leave people out", () => {
    setReaderState(
      readerMessage({
        to: ["sam@example.test", "lee@example.test"],
        cc: ["pat@example.test"],
      }),
    );
    render(<MessageReader />);
    const box = screen.getByRole("textbox", {
      name: strings.reader.quickReply,
    });
    const replyAll = screen.getByRole("button", {
      name: strings.reader.startReplyAll,
    });
    expect(replyAll).toBeDisabled();
    fireEvent.change(box, { target: { value: "See you then" } });
    fireEvent.click(replyAll);
    expect(useAppStore.getState().composeSeed).toMatchObject({
      composeMode: "replyAll",
      replyNote: "See you then",
    });
    expect(box).toHaveValue("");
  });

  it("handles replies, flags, find, links, printing, and attachments", async () => {
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.showDetails }),
    );
    expect(
      screen.getByRole("region", { name: strings.reader.showDetails }),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: strings.reader.reply }));
    expect(useAppStore.getState().composeSeed?.composeMode).toBe("reply");
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.replyAll }),
    );
    expect(useAppStore.getState().composeSeed?.composeMode).toBe("replyAll");
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.replyWithoutQuoting,
      }),
    );
    expect(useAppStore.getState().composeSeed).toMatchObject({
      composeMode: "reply",
      omitQuote: true,
    });
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.replyAllWithoutQuoting,
      }),
    );
    expect(useAppStore.getState().composeSeed).toMatchObject({
      composeMode: "replyAll",
      omitQuote: true,
    });
    const saveEml = vi
      .spyOn(api, "saveMessageEml")
      .mockResolvedValue(undefined);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.saveEml }),
    );
    expect(saveEml).toHaveBeenCalledWith("account-1", 1);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.forward }),
    );
    await waitFor(() =>
      expect(api.prepareForwardAttachments).toHaveBeenCalledWith(
        "account-1",
        1,
      ),
    );
    expect(useAppStore.getState().composeSeed?.composeMode).toBe("forward");

    const webLink = screen.getByRole("link", { name: "https://example.test" });
    fireEvent.click(webLink);
    await waitFor(() =>
      expect(api.openExternalUrl).toHaveBeenCalledWith(
        "https://example.test/",
        false,
      ),
    );
    fireEvent.click(screen.getByRole("link", { name: "jane@example.test" }));
    expect(useAppStore.getState().composeSeed?.prefill?.to).toEqual([
      "jane@example.test",
    ]);

    const more = () =>
      screen.getByRole("button", { name: strings.reader.moreActions });
    fireEvent.click(more());
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.markRead }),
    );
    await waitFor(() =>
      expect(api.setMessageFlags).toHaveBeenCalledWith(
        "account-1",
        1,
        true,
        undefined,
      ),
    );
    expect(useAppStore.getState().selectedMessage?.isRead).toBe(true);
    expect(useAppStore.getState().mailboxes[0].unreadCount).toBe(1);

    fireEvent.click(more());
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.addStar }),
    );
    await waitFor(() =>
      expect(api.setMessageFlags).toHaveBeenLastCalledWith(
        "account-1",
        1,
        undefined,
        true,
      ),
    );
    expect(useAppStore.getState().selectedMessage?.isStarred).toBe(true);

    act(() => {
      window.dispatchEvent(new Event("postal:find-in-message"));
    });
    const find = screen.getByRole("textbox", {
      name: strings.reader.findInMessage,
    });
    fireEvent.change(find, { target: { value: "visit" } });
    fireEvent.submit(find.closest("form")!);
    fireEvent.click(screen.getByRole("button", { name: strings.common.close }));

    act(() => {
      window.dispatchEvent(
        new CustomEvent("postal:scroll-reader", { detail: 1 }),
      );
      window.dispatchEvent(new Event("postal:print-message"));
    });
    const printFrame = document.querySelector<HTMLIFrameElement>(
      'iframe[aria-hidden="true"]',
    );
    expect(printFrame?.srcdoc).toContain("First message");
    const focusPrintFrame = vi
      .spyOn(printFrame!.contentWindow!, "focus")
      .mockImplementation(() => undefined);
    const printDocument = vi
      .spyOn(printFrame!.contentWindow!, "print")
      .mockImplementation(() => undefined);
    fireEvent.load(printFrame!);
    expect(focusPrintFrame).toHaveBeenCalled();
    expect(printDocument).toHaveBeenCalled();
    printFrame?.remove();

    fireEvent.click(
      screen.getByRole("button", {
        name: `${strings.reader.preview}: photo.png`,
      }),
    );
    expect(
      await screen.findByRole("dialog", {
        name: strings.reader.previewTitle("photo.png"),
      }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.downloadFile }),
    );
    await waitFor(() =>
      expect(api.saveAttachment).toHaveBeenCalledWith(
        "account-1",
        1,
        "photo",
        "photo.png",
      ),
    );
  });

  it("moves to role folders, custom folders, and Inbox from Junk", async () => {
    const runAction = async (
      action: () => void,
      expected: [string, number, string | number],
    ) => {
      setReaderState();
      const view = render(<MessageReader />);
      action();
      if (typeof expected[2] === "number") {
        await waitFor(() =>
          expect(api.moveMessageToMailbox).toHaveBeenLastCalledWith(
            ...expected,
          ),
        );
      } else {
        await waitFor(() =>
          expect(api.moveMessage).toHaveBeenLastCalledWith(...expected),
        );
      }
      expect(useAppStore.getState().selectedMessage).toBeUndefined();
      view.unmount();
    };

    await runAction(
      () =>
        fireEvent.click(
          screen.getByRole("button", { name: strings.reader.archive }),
        ),
      ["account-1", 1, "archive"],
    );
    await runAction(
      () =>
        fireEvent.click(
          screen.getByRole("button", { name: strings.reader.trash }),
        ),
      ["account-1", 1, "trash"],
    );
    await runAction(() => {
      fireEvent.click(
        screen.getByRole("button", { name: strings.reader.moreActions }),
      );
      fireEvent.click(
        screen.getByRole("menuitem", { name: strings.reader.junk }),
      );
    }, ["account-1", 1, "junk"]);
    await runAction(() => {
      fireEvent.click(
        screen.getByRole("button", { name: strings.reader.moreActions }),
      );
      fireEvent.click(
        screen.getByRole("menuitem", {
          name: strings.contextMenu.moveToFolder("Receipts"),
        }),
      );
    }, ["account-1", 1, 5]);

    const junkMessage = readerMessage({ mailboxId: junk.id });
    setReaderState(junkMessage);
    const view = render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.notJunk }),
    );
    await waitFor(() =>
      expect(api.moveMessageToMailbox).toHaveBeenLastCalledWith(
        "account-1",
        1,
        inbox.id,
      ),
    );
    view.unmount();
  });

  it("moves an archived message back to Inbox", async () => {
    const archived = readerMessage({ mailboxId: archive.id });
    setReaderState(archived);
    render(<MessageReader />);

    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moveToInbox }),
    );

    await waitFor(() =>
      expect(api.moveMessageToMailbox).toHaveBeenCalledWith(
        "account-1",
        archived.id,
        inbox.id,
      ),
    );
    expect(useAppStore.getState().selectedMessage).toBeUndefined();
  });

  it("permanently deletes an open message that is already in Trash", async () => {
    const trashed = readerMessage({ mailboxId: trash.id });
    const following = makeMessage({
      id: 8,
      mailboxId: trash.id,
      subject: "Later message",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    setReaderState(trashed);
    useAppStore.setState({
      messages: [trashed, following],
      activeMailboxId: trash.id,
    });
    const deleteTrash = vi
      .spyOn(api, "deleteTrashMessages")
      .mockResolvedValue(undefined);
    vi.spyOn(api, "getMessage").mockResolvedValue(
      messageDetail(following, { textBody: "Later" }),
    );
    render(<MessageReader />);

    fireEvent.click(
      screen.getByRole("button", { name: strings.mail.deleteForever }),
    );

    await waitFor(() =>
      expect(deleteTrash).toHaveBeenCalledWith("account-1", [trashed.id]),
    );
    expect(api.showNativeConfirm).toHaveBeenCalledWith(
      strings.mail.deleteForever,
      strings.mail.deleteForeverQuestion(1),
    );
    await waitFor(() =>
      expect(useAppStore.getState().selectedMessage?.id).toBe(following.id),
    );
    expect(
      useAppStore.getState().messages.some((item) => item.id === trashed.id),
    ).toBe(false);
  });

  it("leaves a Trash message in place when deletion is cancelled", async () => {
    const trashed = readerMessage({ mailboxId: trash.id });
    setReaderState(trashed);
    const deleteTrash = vi
      .spyOn(api, "deleteTrashMessages")
      .mockResolvedValue(undefined);
    vi.mocked(api.showNativeConfirm).mockResolvedValueOnce(false);
    render(<MessageReader />);

    fireEvent.click(
      screen.getByRole("button", { name: strings.mail.deleteForever }),
    );

    await waitFor(() => expect(api.showNativeConfirm).toHaveBeenCalled());
    expect(deleteTrash).not.toHaveBeenCalled();
    expect(useAppStore.getState().selectedMessage?.id).toBe(trashed.id);
  });

  it("deletes every loaded message in a Trash conversation", async () => {
    const newer = readerMessage({
      mailboxId: trash.id,
      threadRoot: "<trash@example.test>",
      subject: "Old receipt",
    });
    const older = makeMessage({
      id: 2,
      mailboxId: trash.id,
      threadRoot: "<trash@example.test>",
      subject: "Older receipt",
      isRead: true,
      receivedAt: "2026-08-17T12:00:00Z",
    });
    const keep = makeMessage({
      id: 3,
      mailboxId: trash.id,
      subject: "Keep this",
      isRead: true,
      receivedAt: "2026-08-16T12:00:00Z",
    });
    setReaderState(newer);
    useAppStore.setState({
      messages: [newer, older, keep],
      activeMailboxId: trash.id,
      mailboxes: [
        inbox,
        archive,
        { ...trash, totalCount: 3, unreadCount: 1 },
        junk,
        custom,
      ],
    });
    const deleteTrash = vi
      .spyOn(api, "deleteTrashMessages")
      .mockResolvedValue(undefined);
    vi.spyOn(api, "getMessage").mockImplementation(async (_accountId, id) =>
      messageDetail(id === keep.id ? keep : newer, {
        textBody: id === keep.id ? "Kept" : "Receipt",
      }),
    );
    render(<MessageReader />);

    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.deleteConversation,
      }),
    );

    await waitFor(() =>
      expect(deleteTrash).toHaveBeenCalledWith("account-1", [
        newer.id,
        older.id,
      ]),
    );
    expect(api.showNativeConfirm).toHaveBeenCalledWith(
      strings.reader.deleteConversation,
      strings.mail.deleteForeverQuestion(2),
    );
    await waitFor(() =>
      expect(useAppStore.getState().selectedMessage?.id).toBe(keep.id),
    );
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual([
      keep.id,
    ]);
    const updated = useAppStore
      .getState()
      .mailboxes.find((item) => item.id === trash.id);
    expect(updated?.totalCount).toBe(1);
    expect(updated?.unreadCount).toBe(0);
  });

  it("leaves a Trash conversation in place when deletion is cancelled", async () => {
    const newer = readerMessage({
      mailboxId: trash.id,
      threadRoot: "<trash@example.test>",
      subject: "Old receipt",
    });
    const older = makeMessage({
      id: 2,
      mailboxId: trash.id,
      threadRoot: "<trash@example.test>",
      subject: "Older receipt",
    });
    setReaderState(newer);
    useAppStore.setState({
      messages: [newer, older],
      activeMailboxId: trash.id,
    });
    const deleteTrash = vi
      .spyOn(api, "deleteTrashMessages")
      .mockResolvedValue(undefined);
    vi.mocked(api.showNativeConfirm).mockResolvedValueOnce(false);
    render(<MessageReader />);

    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.deleteConversation,
      }),
    );

    await waitFor(() => expect(api.showNativeConfirm).toHaveBeenCalled());
    expect(deleteTrash).not.toHaveBeenCalled();
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual([
      newer.id,
      older.id,
    ]);
  });

  it("keeps a Trash conversation when deletion fails", async () => {
    const newer = readerMessage({
      mailboxId: trash.id,
      threadRoot: "<trash@example.test>",
      subject: "Old receipt",
    });
    const older = makeMessage({
      id: 2,
      mailboxId: trash.id,
      threadRoot: "<trash@example.test>",
      subject: "Older receipt",
    });
    setReaderState(newer);
    useAppStore.setState({
      messages: [newer, older],
      activeMailboxId: trash.id,
    });
    vi.spyOn(api, "deleteTrashMessages").mockRejectedValue(
      new Error("disk full"),
    );
    render(<MessageReader />);

    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.deleteConversation,
      }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("Error: disk full"),
    );
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual([
      newer.id,
      older.id,
    ]);
    expect(useAppStore.getState().selectedMessage?.id).toBe(newer.id);
  });

  it("does not delete a Trash conversation of more than 200 messages", async () => {
    const members = Array.from({ length: 201 }, (_, index) =>
      makeMessage({
        id: index + 1,
        mailboxId: trash.id,
        threadRoot: "<trash@example.test>",
        subject: `Receipt ${index + 1}`,
      }),
    );
    const open = messageDetail(members[0]);
    setReaderState(open);
    useAppStore.setState({
      messages: members,
      activeMailboxId: trash.id,
    });
    const deleteTrash = vi
      .spyOn(api, "deleteTrashMessages")
      .mockResolvedValue(undefined);
    render(<MessageReader />);

    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.deleteConversation,
      }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().error).toBe(strings.mail.bulkTooMany),
    );
    expect(deleteTrash).not.toHaveBeenCalled();
    expect(api.showNativeConfirm).not.toHaveBeenCalled();
    expect(useAppStore.getState().messages).toHaveLength(201);
  });

  it("hides delete conversation outside Trash", () => {
    const newer = readerMessage({
      threadRoot: "<thread@example.test>",
      subject: "Weekend plans",
    });
    const older = makeMessage({
      id: 2,
      threadRoot: "<thread@example.test>",
      subject: "Older plans",
    });
    setReaderState(newer);
    useAppStore.setState({ messages: [newer, older] });
    render(<MessageReader />);

    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    expect(
      screen.queryByRole("menuitem", {
        name: strings.reader.deleteConversation,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: strings.reader.trashConversation }),
    ).toBeVisible();
  });

  it("unblocks a Junk sender and moves the open message to Inbox", async () => {
    const junked = readerMessage({
      mailboxId: junk.id,
      senderAddress: "Jane@Example.test",
    });
    const following = makeMessage({
      id: 8,
      mailboxId: junk.id,
      subject: "Later message",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    setReaderState(junked);
    useAppStore.setState({
      messages: [junked, following],
      activeMailboxId: junk.id,
    });
    vi.mocked(api.listFilterRules).mockResolvedValue([
      {
        id: "rule-1",
        accountId: "account-1",
        name: "Block sender",
        field: "from",
        contains: "jane@example.test",
        action: "move_junk",
        enabled: true,
      },
    ]);
    vi.spyOn(api, "getMessage").mockResolvedValue(
      messageDetail(following, { textBody: "Later" }),
    );
    render(<MessageReader />);

    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: strings.reader.unblockSender,
      }),
    );

    await waitFor(() =>
      expect(api.deleteFilterRule).toHaveBeenCalledWith("account-1", "rule-1"),
    );
    expect(api.showNativeConfirm).toHaveBeenCalledWith(
      strings.reader.unblockSender,
      strings.reader.unblockSenderFromJunk,
    );
    await waitFor(() =>
      expect(api.moveMessageToMailbox).toHaveBeenCalledWith(
        "account-1",
        junked.id,
        inbox.id,
      ),
    );
  });

  it("leaves a blocked sender in place when unblocking is cancelled", async () => {
    vi.mocked(api.listFilterRules).mockResolvedValue([
      {
        id: "rule-1",
        accountId: "account-1",
        name: "Block sender",
        field: "from",
        contains: "jane@example.test",
        action: "move_junk",
        enabled: true,
      },
    ]);
    vi.mocked(api.showNativeConfirm).mockResolvedValueOnce(false);
    render(<MessageReader />);

    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: strings.reader.unblockSender,
      }),
    );

    await waitFor(() => expect(api.showNativeConfirm).toHaveBeenCalled());
    expect(api.deleteFilterRule).not.toHaveBeenCalled();
    expect(useAppStore.getState().selectedMessage?.id).toBe(1);
  });

  it("keeps the block when unblocking cannot be saved", async () => {
    vi.mocked(api.listFilterRules).mockResolvedValue([
      {
        id: "rule-1",
        accountId: "account-1",
        name: "Block sender",
        field: "from",
        contains: "jane@example.test",
        action: "move_junk",
        enabled: true,
      },
    ]);
    vi.mocked(api.deleteFilterRule).mockRejectedValueOnce(
      new Error("disk full"),
    );
    render(<MessageReader />);

    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: strings.reader.unblockSender,
      }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("Error: disk full"),
    );
    expect(api.moveMessageToMailbox).not.toHaveBeenCalled();
    expect(useAppStore.getState().selectedMessage?.id).toBe(1);
  });

  it("rolls back failed flags and moves and reports attachment failures", async () => {
    vi.mocked(api.setMessageFlags).mockRejectedValueOnce(
      new Error("flag failed"),
    );
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.markRead }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("Error: flag failed"),
    );
    expect(useAppStore.getState().selectedMessage?.isRead).toBe(false);
    expect(useAppStore.getState().mailboxes[0].unreadCount).toBe(2);

    vi.mocked(api.setMessageFlags).mockRejectedValueOnce(
      new Error("star failed"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.addStar }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("Error: star failed"),
    );
    expect(useAppStore.getState().selectedMessage?.isStarred).toBe(false);
    expect(useAppStore.getState().messages[0].isStarred).toBe(false);

    vi.mocked(api.moveMessage).mockRejectedValueOnce(new Error("move failed"));
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.archive }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("Error: move failed"),
    );
    expect(useAppStore.getState().selectedMessage?.id).toBe(1);
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual([1]);

    vi.mocked(api.moveMessageToMailbox).mockRejectedValueOnce(
      new Error("folder move failed"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.contextMenu.moveToFolder("Receipts"),
      }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("Error: folder move failed"),
    );
    expect(useAppStore.getState().selectedMessage?.id).toBe(1);
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual([1]);

    const failureCases: Array<
      [keyof Pick<typeof api, "previewAttachment" | "saveAttachment">, string]
    > = [
      ["previewAttachment", "preview failed"],
      ["saveAttachment", "download failed"],
    ];
    for (const [method, error] of failureCases) {
      vi.mocked(api[method]).mockRejectedValueOnce(new Error(error) as never);
      if (method === "previewAttachment") {
        fireEvent.click(
          screen.getByRole("button", {
            name: `${strings.reader.preview}: photo.png`,
          }),
        );
      } else {
        fireEvent.click(
          screen.getByRole("button", {
            name: `${strings.reader.downloadFile}: photo.png`,
          }),
        );
      }
      await waitFor(() =>
        expect(useAppStore.getState().error).toBe(`Error: ${error}`),
      );
    }
  });

  it("requires two confirmations for reported links and supports snooze", async () => {
    vi.mocked(api.inspectExternalUrl).mockResolvedValue({
      url: `https://danger.example/${"x".repeat(1500)}`,
      hostname: "danger.example",
      reportedThreat: true,
    });
    render(<MessageReader />);
    fireEvent.click(screen.getByRole("link", { name: "https://example.test" }));
    await waitFor(() => expect(api.showNativeConfirm).toHaveBeenCalledTimes(2));
    expect(api.openExternalUrl).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/danger\.example/),
      true,
    );

    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.snooze }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.snoozeTomorrow }),
    );
    await waitFor(() => expect(api.snoozeMessage).toHaveBeenCalled());
    expect(useAppStore.getState().selectedMessage).toBeUndefined();
  });

  it("snoozes every loaded message in the conversation", async () => {
    const newer = readerMessage({ threadRoot: "<thread@example.test>" });
    const older = messageDetail(
      makeMessage({
        id: 2,
        threadRoot: "<thread@example.test>",
        subject: "Older note",
      }),
    );
    setReaderState(newer);
    useAppStore.setState({ messages: [newer, older], selectedMessage: newer });
    const onConversationSnoozed = vi.fn();
    vi.mocked(api.snoozeMessages).mockResolvedValue(undefined);
    render(<MessageReader onConversationSnoozed={onConversationSnoozed} />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.snoozeConversation,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.snoozeTomorrow }),
    );
    await waitFor(() =>
      expect(api.snoozeMessages).toHaveBeenCalledWith(
        "account-1",
        [newer.id, older.id],
        expect.any(String),
      ),
    );
    expect(api.snoozeMessage).not.toHaveBeenCalled();
    expect(onConversationSnoozed).toHaveBeenCalledWith("account-1", [
      newer.id,
      older.id,
    ]);
  });

  it("prints every loaded message in the conversation, oldest first", async () => {
    const newer = readerMessage({ threadRoot: "<thread@example.test>" });
    const older = messageDetail(
      makeMessage({
        id: 2,
        threadRoot: "<thread@example.test>",
        subject: "Older note",
        receivedAt: "2026-08-17T12:00:00Z",
      }),
    );
    setReaderState(newer);
    useAppStore.setState({ messages: [newer, older], selectedMessage: newer });
    vi.spyOn(api, "getMessage").mockImplementation(async (_accountId, id) => {
      if (id !== older.id) throw new Error("unexpected message");
      return {
        ...older,
        htmlBody: "<p>Older body</p><script>alert(1)</script>",
        textBody: "Older body",
      };
    });
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.printConversation,
      }),
    );
    const frame = await waitFor(() => {
      const printer = [...document.querySelectorAll("iframe")].find((node) =>
        node.srcdoc.includes("Older note"),
      );
      if (!printer) throw new Error("print document is not ready");
      return printer;
    });
    const srcdoc = frame.srcdoc;
    expect(srcdoc.indexOf("Older note")).toBeLessThan(
      srcdoc.indexOf(newer.subject),
    );
    expect(srcdoc).toContain("Older body");
    expect(srcdoc).not.toContain("alert(1)");
    expect(srcdoc).toContain("break-before:page");
    expect(api.getMessage).toHaveBeenCalledWith("account-1", older.id);
    expect(api.getMessage).not.toHaveBeenCalledWith("account-1", newer.id);
    expect(useAppStore.getState().selectedMessage?.id).toBe(newer.id);
  });

  it("forwards every loaded message in the conversation", async () => {
    const newer = readerMessage({ threadRoot: "<thread@example.test>" });
    const older = messageDetail(
      makeMessage({
        id: 2,
        threadRoot: "<thread@example.test>",
        subject: "Older note",
        receivedAt: "2026-08-17T12:00:00Z",
      }),
    );
    setReaderState(newer);
    useAppStore.setState({ messages: [newer, older], selectedMessage: newer });
    vi.spyOn(api, "getMessage").mockImplementation(async (_accountId, id) => {
      if (id !== older.id) throw new Error("unexpected message");
      return {
        ...older,
        htmlBody: "<p>Older body</p><script>alert(1)</script>",
        textBody: "Older body",
      };
    });
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.forwardConversation,
      }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().composeSeed?.forwardMessages).toHaveLength(
        2,
      ),
    );
    const seed = useAppStore.getState().composeSeed;
    expect(seed?.composeMode).toBe("forward");
    expect(seed?.sourceMessage?.id).toBe(newer.id);
    expect(seed?.forwardMessages?.[0]?.subject).toBe("Older note");
    expect(api.getMessage).toHaveBeenCalledWith("account-1", older.id);
    expect(api.getMessage).not.toHaveBeenCalledWith("account-1", newer.id);
    expect(useAppStore.getState().selectedMessage?.id).toBe(newer.id);
  });

  it("copies every loaded message in the conversation", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const newer = readerMessage({
      threadRoot: "<thread@example.test>",
      subject: "Newer note",
      textBody: "Newer body",
    });
    const older = messageDetail(
      makeMessage({
        id: 2,
        threadRoot: "<thread@example.test>",
        subject: "Older note",
        receivedAt: "2026-08-17T12:00:00Z",
      }),
    );
    const skipped = messageDetail(
      makeMessage({
        id: 3,
        threadRoot: "<thread@example.test>",
        subject: "Skipped note",
        receivedAt: "2026-08-16T12:00:00Z",
      }),
    );
    setReaderState(newer);
    useAppStore.setState({
      messages: [newer, older, skipped],
      selectedMessage: newer,
    });
    vi.spyOn(api, "getMessage").mockImplementation(async (_accountId, id) => {
      if (id === newer.id) return newer;
      if (id === older.id) {
        return {
          ...older,
          textBody: "Older body",
          htmlBody: "<p>Older body</p><script>alert(1)</script>",
        };
      }
      return { ...skipped, textBody: "", htmlBody: null };
    });
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.copyConversationText,
      }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const copied = String(writeText.mock.calls[0]?.[0]);
    expect(copied.indexOf("Older note")).toBeLessThan(
      copied.indexOf("Newer note"),
    );
    expect(copied).toContain("Older body");
    expect(copied).toContain("Newer body");
    expect(copied).not.toContain("Skipped");
    expect(copied).not.toContain("alert(1)");
    expect(useAppStore.getState().selectedMessage?.id).toBe(newer.id);
  });

  it("leaves the open message in place when conversation text cannot be copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const newer = readerMessage({ threadRoot: "<thread@example.test>" });
    const older = messageDetail(
      makeMessage({
        id: 2,
        threadRoot: "<thread@example.test>",
        receivedAt: "2026-08-17T12:00:00Z",
      }),
    );
    setReaderState(newer);
    useAppStore.setState({ messages: [newer, older], selectedMessage: newer });
    vi.spyOn(api, "getMessage").mockRejectedValue(new Error("offline"));
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.copyConversationText,
      }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("Error: offline"),
    );
    expect(writeText).not.toHaveBeenCalled();
    expect(useAppStore.getState().selectedMessage?.id).toBe(newer.id);
  });

  it("pins the open message from the message menu", async () => {
    vi.spyOn(api, "setMessagesPinned").mockResolvedValue(1);
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    expect(
      screen.queryByRole("menuitem", { name: strings.reader.pinConversation }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: strings.reader.pin }));
    await waitFor(() =>
      expect(api.setMessagesPinned).toHaveBeenCalledWith(
        "account-1",
        [1],
        true,
      ),
    );
    expect(useAppStore.getState().selectedMessage?.pinned).toBe(true);
    expect(
      screen.queryByRole("menuitem", { name: strings.reader.pinConversation }),
    ).not.toBeInTheDocument();
  });

  it("hides forward conversation on a single message", () => {
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    expect(
      screen.queryByRole("menuitem", {
        name: strings.reader.forwardConversation,
      }),
    ).not.toBeInTheDocument();
  });

  it("saves every loaded file in the conversation", async () => {
    const newer = readerMessage({ threadRoot: "<thread@example.test>" });
    const older = messageDetail(
      makeMessage({
        id: 2,
        threadRoot: "<thread@example.test>",
        subject: "Older note",
      }),
    );
    setReaderState(newer);
    useAppStore.setState({ messages: [newer, older], selectedMessage: newer });
    vi.spyOn(api, "saveConversationAttachments").mockResolvedValue(2);
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    expect(
      screen.queryByRole("menuitem", {
        name: strings.reader.saveConversationFiles,
      }),
    ).not.toBeInTheDocument();

    useAppStore.setState({
      messages: [newer, { ...older, hasAttachments: true }],
    });
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: strings.reader.saveConversationFiles,
      }),
    );
    await waitFor(() =>
      expect(api.saveConversationAttachments).toHaveBeenCalledWith(
        "account-1",
        [newer.id, older.id],
      ),
    );
  });

  it("loads remote and inline images with independent blocking outcomes", async () => {
    const message = readerMessage({
      htmlBody:
        '<p>Images</p><img src="https://img.example/one.png"><img src="https://img.example/two.png"><img src="https://img.example/three.png"><img src="https://img.example/four.png"><img src="cid:inline-one">',
      attachments: [
        {
          id: "inline",
          filename: "inline.png",
          contentType: "image/png",
          size: 10,
          inline: true,
          contentId: "inline-one",
        },
      ],
    });
    setReaderState(message);
    vi.spyOn(api, "readMessageInlineImage").mockResolvedValue(
      "data:image/png;base64,AA==",
    );
    vi.spyOn(api, "fetchRemoteImage")
      .mockResolvedValueOnce({
        status: "loaded",
        dataUrl: "data:image/png;base64,AQ==",
      })
      .mockResolvedValueOnce({ status: "blocked" })
      .mockResolvedValueOnce({ status: "reportedThreat" })
      .mockRejectedValueOnce(new Error("network"));
    render(<MessageReader />);
    await waitFor(() =>
      expect(api.readMessageInlineImage).toHaveBeenCalledWith(
        "account-1",
        1,
        "inline",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.retryImages }),
    );
    await waitFor(() => expect(api.fetchRemoteImage).toHaveBeenCalledTimes(4));
    expect(
      await screen.findByText(strings.reader.filteredImages(1)),
    ).toBeVisible();
    expect(screen.getByText(strings.reader.threatImages(1))).toBeVisible();
    expect(
      screen.getByRole("button", { name: strings.reader.retryImages }),
    ).toBeEnabled();
  });

  it("requires consent even for a remembered From address", async () => {
    const message = readerMessage({
      htmlBody: '<p>Picture</p><img src="https://img.example/one.png">',
    });
    setReaderState(message);
    useAppStore.setState({
      settings: {
        ...defaultSettings,
        readingPane: "right",
        imageSenders: ["jane@example.test"],
      },
    });
    vi.spyOn(api, "fetchRemoteImage").mockResolvedValue({
      status: "loaded",
      dataUrl: "data:image/png;base64,AQ==",
    });
    render(<MessageReader />);
    const load = await screen.findByRole("button", {
      name: strings.reader.loadImages,
    });
    expect(api.fetchRemoteImage).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /^Always load images/ }),
    ).toBeNull();
    fireEvent.click(load);
    await waitFor(() =>
      expect(api.fetchRemoteImage).toHaveBeenCalledWith(
        "https://img.example/one.png",
      ),
    );
  });

  it("says when a link's text is a different address", async () => {
    vi.mocked(api.inspectExternalUrl).mockImplementation(
      async (url: string) => ({
        url,
        hostname: new URL(url).hostname,
        reportedThreat: false,
      }),
    );
    setReaderState(
      readerMessage({ htmlBody: "<p>HTML message</p>", textBody: "" }),
    );
    render(<MessageReader />);
    const iframe = screen.getByTitle(strings.reader.messageContent);
    const body = (iframe as HTMLIFrameElement).contentDocument!.body;
    body.innerHTML =
      '<a id="web" data-external-href="https://phish.example.test/login" href="#">https://bank.example/login</a>';
    fireEvent.load(iframe);
    body
      .querySelector("#web")!
      .dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    await waitFor(() => expect(api.showNativeConfirm).toHaveBeenCalled());
    const message = vi.mocked(api.showNativeConfirm).mock.calls[0]?.[1] ?? "";
    expect(message).toContain("phish.example.test");
    expect(message).toContain(
      "The link text shows a different address: https://bank.example/login",
    );
    expect(message).not.toMatch(/\bSafe\b/);
  });

  it("wires safe iframe links and blocks native context navigation", async () => {
    setReaderState(
      readerMessage({ htmlBody: "<p>HTML message</p>", textBody: "" }),
    );
    render(<MessageReader />);
    const iframe = screen.getByTitle(strings.reader.messageContent);
    const frameWindow = (iframe as HTMLIFrameElement).contentWindow!;
    const frameScroll = vi
      .spyOn(frameWindow, "scrollBy")
      .mockImplementation(() => undefined);
    const body = (iframe as HTMLIFrameElement).contentDocument!.body;
    (
      frameWindow as unknown as { Element: typeof Element }
    ).Element.prototype.scrollIntoView = () => undefined;
    body.innerHTML =
      '<a id="web" data-external-href="https://example.test/path" href="#">web</a><a id="mail" href="mailto:jane@example.test">mail</a><span id="plain">plain</span>';
    fireEvent.load(iframe);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("postal:scroll-reader", { detail: -1 }),
      );
      window.dispatchEvent(new Event("postal:find-in-message"));
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: strings.reader.findInMessage }),
      { target: { value: "plain" } },
    );
    fireEvent.submit(
      screen
        .getByRole("textbox", { name: strings.reader.findInMessage })
        .closest("form")!,
    );
    expect(frameScroll).toHaveBeenCalledWith(0, expect.any(Number));
    expect(
      await screen.findByText(strings.reader.findMatchCount(1, 1)),
    ).toBeVisible();
    const web = body.querySelector("#web")!;
    const mail = body.querySelector("#mail")!;
    const plain = body.querySelector("#plain")!;
    web.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await waitFor(() => expect(api.openExternalUrl).toHaveBeenCalled());
    mail.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(useAppStore.getState().composeSeed?.prefill?.to).toEqual([
      "jane@example.test",
    ]);
    plain.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    web.addEventListener("auxclick", (event) => event.preventDefault());
    web.dispatchEvent(
      new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 2,
      }),
    );
    const context = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    web.dispatchEvent(context);
    expect(context.defaultPrevented).toBe(true);
    const padding = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    (
      iframe as HTMLIFrameElement
    ).contentDocument!.documentElement.dispatchEvent(padding);
    expect(padding.defaultPrevented).toBe(true);
  });

  it("keeps a newer selection when a snooze finishes late", async () => {
    let releaseSnooze: () => void = () => undefined;
    vi.mocked(api.snoozeMessage).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseSnooze = resolve;
        }),
    );
    const onSnoozed = vi.fn();
    const newer = messageDetail(
      makeMessage({ id: 2, subject: "Second message" }),
    );
    render(<MessageReader onSnoozed={onSnoozed} />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.snooze }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.snoozeTomorrow }),
    );
    await waitFor(() => expect(api.snoozeMessage).toHaveBeenCalled());

    act(() => {
      useAppStore.getState().selectMessage(newer);
    });
    await act(async () => {
      releaseSnooze();
      await Promise.resolve();
    });

    expect(useAppStore.getState().selectedMessage?.id).toBe(newer.id);
    expect(onSnoozed).toHaveBeenCalledWith("account-1", 1);
  });

  it("intercepts image-map areas and strips usemap references", async () => {
    setReaderState(readerMessage({ htmlBody: "<p>Map</p>", textBody: "" }));
    render(<MessageReader />);
    const iframe = screen.getByTitle(strings.reader.messageContent);
    const body = (iframe as HTMLIFrameElement).contentDocument!.body;
    body.innerHTML =
      '<img id="mapped" usemap="#links" alt="map"><map name="links"><area id="area" href="https://map.example/path" alt="map link"></map>';
    fireEvent.load(iframe);

    expect(body.querySelector("[usemap]")).toBeNull();
    const area = body.querySelector("#area")!;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    area.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    await waitFor(() => expect(api.openExternalUrl).toHaveBeenCalled());
    const context = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    area.dispatchEvent(context);
    expect(context.defaultPrevented).toBe(true);
  });

  it("honors canceled link confirmations and reports command failures", async () => {
    render(<MessageReader />);
    const link = () =>
      screen.getByRole("link", { name: "https://example.test" });

    vi.mocked(api.showNativeConfirm).mockResolvedValueOnce(false);
    fireEvent.click(link());
    await waitFor(() => expect(api.showNativeConfirm).toHaveBeenCalledTimes(1));
    expect(api.openExternalUrl).not.toHaveBeenCalled();

    vi.mocked(api.inspectExternalUrl).mockResolvedValueOnce({
      url: "https://danger.example/",
      hostname: "danger.example",
      reportedThreat: true,
    });
    vi.mocked(api.showNativeConfirm)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    fireEvent.click(link());
    await waitFor(() => expect(api.showNativeConfirm).toHaveBeenCalledTimes(3));
    expect(api.openExternalUrl).not.toHaveBeenCalled();

    vi.mocked(api.inspectExternalUrl).mockRejectedValueOnce(
      new Error("inspect"),
    );
    fireEvent.click(link());
    await waitFor(() =>
      expect(api.inspectExternalUrl).toHaveBeenCalledTimes(3),
    );

    vi.mocked(api.prepareForwardAttachments).mockRejectedValueOnce(
      new Error("forward failed"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.forward }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("Error: forward failed"),
    );

    vi.mocked(api.snoozeMessage).mockRejectedValueOnce(
      new Error("snooze failed"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.snooze }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.snoozeTomorrow }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toBe("Error: snooze failed"),
    );
    expect(useAppStore.getState().selectedMessage?.id).toBe(1);
  });

  it("copies the open message into another folder and leaves it open", async () => {
    vi.spyOn(api, "copyMessageToMailbox").mockResolvedValue(undefined);
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.contextMenu.copyToFolder("Receipts"),
      }),
    );
    await waitFor(() =>
      expect(api.copyMessageToMailbox).toHaveBeenCalledWith("account-1", 1, 5),
    );
    expect(useAppStore.getState().selectedMessage?.id).toBe(1);
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual([1]);
  });

  it("moves every loaded message in the conversation to another folder", async () => {
    const newer = readerMessage({ threadRoot: "<thread@example.test>" });
    const older = messageDetail(
      makeMessage({
        id: 2,
        threadRoot: "<thread@example.test>",
        subject: "Older note",
      }),
    );
    const next = messageDetail(
      makeMessage({ id: 3, subject: "Library hours" }),
    );
    setReaderState(newer);
    useAppStore.setState({
      messages: [newer, older, next],
      selectedMessage: newer,
    });
    vi.spyOn(api, "moveMessagesToMailbox").mockResolvedValue({
      updated: 2,
      queued: 0,
      failed: 0,
    });
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.contextMenu.moveConversationToFolder("Receipts"),
      }),
    );
    await waitFor(() =>
      expect(api.moveMessagesToMailbox).toHaveBeenCalledWith(
        "account-1",
        [newer.id, older.id],
        5,
      ),
    );
    expect(api.moveMessageToMailbox).not.toHaveBeenCalled();
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual([
      next.id,
    ]);
  });

  it("copies every loaded message in the conversation and leaves them open", async () => {
    const newer = readerMessage({ threadRoot: "<thread@example.test>" });
    const older = messageDetail(
      makeMessage({
        id: 2,
        threadRoot: "<thread@example.test>",
        subject: "Older note",
      }),
    );
    setReaderState(newer);
    useAppStore.setState({ messages: [newer, older], selectedMessage: newer });
    vi.spyOn(api, "copyMessageToMailbox").mockResolvedValue(undefined);
    vi.spyOn(api, "copyMessagesToMailbox").mockResolvedValue({
      updated: 2,
      queued: 0,
      failed: 0,
    });
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.contextMenu.copyConversationToFolder("Receipts"),
      }),
    );
    await waitFor(() =>
      expect(api.copyMessagesToMailbox).toHaveBeenCalledWith(
        "account-1",
        [newer.id, older.id],
        5,
      ),
    );
    expect(api.copyMessageToMailbox).not.toHaveBeenCalled();
    expect(useAppStore.getState().selectedMessage?.id).toBe(newer.id);
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual([
      newer.id,
      older.id,
    ]);
  });

  it("replies to the list address instead of the sender", () => {
    setReaderState(readerMessage({ listPost: "list@example.test" }));
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.replyToList }),
    );
    expect(useAppStore.getState().composeSeed?.composeMode).toBe("replyList");
    expect(useAppStore.getState().composeSeed?.sourceMessage?.listPost).toBe(
      "list@example.test",
    );
  });

  it("forwards the open message as an attached copy", async () => {
    vi.spyOn(api, "prepareForwardedMessage").mockResolvedValue({
      token: "eml-1",
      filename: "First message.eml",
      contentType: "message/rfc822",
      inline: false,
      size: 80,
    });
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.forwardAsAttachment,
      }),
    );
    await waitFor(() =>
      expect(api.prepareForwardedMessage).toHaveBeenCalledWith("account-1", 1),
    );
    const seed = useAppStore.getState().composeSeed;
    expect(seed?.composeMode).toBe("forwardAttachment");
    expect(seed?.prefill?.attachments).toEqual([
      expect.objectContaining({
        token: "eml-1",
        contentType: "message/rfc822",
      }),
    ]);
  });

  it("replies with the message files and leaves inline images out", async () => {
    setReaderState(
      readerMessage({
        attachments: [
          {
            id: "photo",
            filename: "photo.png",
            contentType: "image/png",
            size: 1024,
            inline: false,
          },
          {
            id: "logo",
            filename: "logo.png",
            contentType: "image/png",
            size: 12,
            inline: true,
          },
        ],
      }),
    );
    vi.mocked(api.prepareReplyAttachments).mockResolvedValueOnce([
      {
        token: "file-1",
        filename: "photo.png",
        contentType: "image/png",
        inline: false,
        size: 1024,
      },
      {
        token: "logo",
        filename: "logo.png",
        contentType: "image/png",
        inline: true,
        size: 12,
      },
    ]);
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.replyWithAttachments,
      }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().composeSeed?.composeMode).toBe("reply"),
    );
    expect(api.prepareReplyAttachments).toHaveBeenCalledWith("account-1", 1);
    const seed = useAppStore.getState().composeSeed;
    expect(seed?.composeMode).toBe("reply");
    expect(seed?.prefill?.attachments).toEqual([
      expect.objectContaining({ token: "file-1", filename: "photo.png" }),
    ]);
    expect(seed?.sourceMessage?.messageId).toBe("<first@example.test>");

    useAppStore.setState({ composeSeed: undefined });
    vi.mocked(api.prepareReplyAttachments).mockResolvedValueOnce([
      {
        token: "file-1",
        filename: "photo.png",
        contentType: "image/png",
        inline: false,
        size: 1024,
      },
    ]);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.replyAllWithAttachments,
      }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().composeSeed?.composeMode).toBe("replyAll"),
    );
    expect(useAppStore.getState().composeSeed?.prefill?.attachments).toEqual([
      expect.objectContaining({ token: "file-1" }),
    ]);
  });

  it("hides reply with attachments when the message has no files", () => {
    setReaderState(
      readerMessage({
        attachments: [
          {
            id: "logo",
            filename: "logo.png",
            contentType: "image/png",
            size: 12,
            inline: true,
          },
        ],
      }),
    );
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    expect(
      screen.queryByRole("menuitem", {
        name: strings.reader.replyWithAttachments,
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("menuitem", {
        name: strings.reader.replyAllWithAttachments,
      }),
    ).toBeNull();
  });

  it("keeps the message open when a reply has no files to attach", async () => {
    vi.mocked(api.prepareReplyAttachments).mockResolvedValueOnce([]);
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.replyWithAttachments,
      }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().error).toBe(strings.reader.noFilesToAttach),
    );
    expect(useAppStore.getState().composeSeed).toBeUndefined();
  });

  it("opens the message as a new draft without reply headers", async () => {
    vi.mocked(api.prepareForwardAttachments).mockResolvedValueOnce([
      {
        token: "file-1",
        filename: "photo.png",
        contentType: "image/png",
        inline: false,
        size: 1024,
      },
    ]);
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.editAsNew }),
    );
    await waitFor(() =>
      expect(api.prepareForwardAttachments).toHaveBeenCalledWith(
        "account-1",
        1,
      ),
    );
    const seed = useAppStore.getState().composeSeed;
    expect(seed?.composeMode).toBe("editAsNew");
    expect(seed?.prefill?.attachments).toEqual([
      expect.objectContaining({ token: "file-1" }),
    ]);
    expect(seed?.sourceMessage?.messageId).toBe("<first@example.test>");
  });

  it("opens a redirect that keeps the original message", () => {
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.redirect }),
    );
    const seed = useAppStore.getState().composeSeed;
    expect(seed?.composeMode).toBe("redirect");
    expect(seed?.prefill).toBeUndefined();
    expect(seed?.sourceMessage?.messageId).toBe("<first@example.test>");
    expect(api.prepareForwardAttachments).not.toHaveBeenCalled();
    useAppStore.setState({ composeSeed: undefined });
    act(() => {
      window.dispatchEvent(
        new CustomEvent("postal:menu-action", { detail: "redirect" }),
      );
    });
    expect(useAppStore.getState().composeSeed?.composeMode).toBe("redirect");
  });

  it("routes native menu actions and dismisses open menus", async () => {
    render(<MessageReader />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("postal:menu-action", { detail: "reply" }),
      );
      window.dispatchEvent(
        new CustomEvent("postal:menu-action", { detail: "reply-all" }),
      );
      window.dispatchEvent(
        new CustomEvent("postal:menu-action", { detail: "find-in-message" }),
      );
      window.dispatchEvent(
        new CustomEvent("postal:menu-action", { detail: "unknown" }),
      );
    });
    expect(useAppStore.getState().composeSeed?.composeMode).toBe("replyAll");
    expect(
      screen.getByRole("textbox", { name: strings.reader.findInMessage }),
    ).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    expect(screen.getByRole("menu")).toBeVisible();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moreActions }),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  });

  it("opens the next and previous previewable file", async () => {
    vi.mocked(api.previewAttachment).mockImplementation(
      async (_accountId, _messageId, attachmentId) =>
        attachmentId === "notes"
          ? {
              filename: "notes.txt",
              contentType: "text/plain",
              size: 20,
              text: "Bring the salad.",
            }
          : {
              filename: "photo.png",
              contentType: "image/png",
              size: 1024,
              imageDataUrl: "data:image/png;base64,AA==",
            },
    );
    setReaderState(
      readerMessage({
        attachments: [
          {
            id: "photo",
            filename: "photo.png",
            contentType: "image/png",
            size: 1024,
            inline: false,
          },
          {
            id: "notes",
            filename: "notes.txt",
            contentType: "text/plain",
            size: 20,
            inline: false,
          },
        ],
      }),
    );
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", {
        name: `${strings.reader.preview}: photo.png`,
      }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Preview of photo.png" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: strings.reader.previousFile }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.nextFile }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Preview of notes.txt" }),
    ).toBeVisible();
    expect(screen.getByText("Bring the salad.")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: strings.reader.nextFile }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(
      screen.getByRole("dialog", { name: "Preview of notes.txt" }),
      { key: "ArrowLeft" },
    );
    expect(
      await screen.findByRole("dialog", { name: "Preview of photo.png" }),
    ).toBeVisible();
  });

  it("ignores attachment previews and forwards that finish after selection changes", async () => {
    let finishPreview!: (
      value: Awaited<ReturnType<typeof api.previewAttachment>>,
    ) => void;
    vi.mocked(api.previewAttachment).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPreview = resolve;
        }),
    );
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", {
        name: `${strings.reader.preview}: photo.png`,
      }),
    );
    await waitFor(() => expect(api.previewAttachment).toHaveBeenCalled());
    act(() => {
      useAppStore.getState().selectMessage(readerMessage({ id: 2, uid: 2 }));
    });
    await act(async () => {
      finishPreview({
        filename: "photo.png",
        contentType: "image/png",
        size: 1024,
        imageDataUrl: "data:image/png;base64,AA==",
      });
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    let finishForward!: (
      value: Awaited<ReturnType<typeof api.prepareForwardAttachments>>,
    ) => void;
    vi.mocked(api.prepareForwardAttachments).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishForward = resolve;
        }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.forward }),
    );
    await waitFor(() =>
      expect(api.prepareForwardAttachments).toHaveBeenCalledTimes(1),
    );
    act(() => {
      useAppStore.getState().selectMessage(readerMessage({ id: 3, uid: 3 }));
    });
    await act(async () => {
      finishForward([]);
    });
    expect(useAppStore.getState().composerOpen).toBe(false);
    expect(useAppStore.getState().composeSeed).toBeUndefined();
  });

  it("closes the snooze panel without changing the message", async () => {
    render(<MessageReader />);
    const more = screen.getByRole("button", {
      name: strings.reader.moreActions,
    });
    fireEvent.click(more);
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.snooze }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.common.cancel }),
    );
    expect(
      screen.queryByRole("button", { name: strings.reader.snoozeTomorrow }),
    ).not.toBeInTheDocument();
    expect(useAppStore.getState().selectedMessage?.id).toBe(1);
    await waitFor(() => expect(more).toHaveFocus());
  });

  it("prints from the menu and ignores a no-op folder move", async () => {
    const printed = vi.fn();
    window.addEventListener("postal:print-message", printed);
    setReaderState(
      readerMessage({
        mailboxId: archive.id,
        accountId: archive.accountId,
      }),
    );
    useAppStore.setState({ activeMailboxId: archive.id });
    render(<MessageReader />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("postal:menu-action", { detail: "file-print" }),
      );
      window.dispatchEvent(
        new CustomEvent("postal:menu-action", { detail: "print" }),
      );
    });
    expect(printed).toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(
        new CustomEvent("postal:menu-action", { detail: "archive" }),
      );
    });
    expect(api.moveMessage).not.toHaveBeenCalled();
    expect(api.moveMessageToMailbox).not.toHaveBeenCalled();
    window.removeEventListener("postal:print-message", printed);
  });

  it("shows the new text and tucks the quoted reply", () => {
    setReaderState(
      readerMessage({
        htmlBody:
          "<p>Thanks, I will send it tomorrow.</p><blockquote><p>Can you send the notes before Friday morning so I can review them?</p></blockquote>",
        textBody: "Thanks, I will send it tomorrow.",
      }),
    );
    render(<MessageReader />);
    const frame = screen.getByTitle(strings.reader.messageContent);
    const srcdoc = (frame as HTMLIFrameElement).srcdoc;
    expect(srcdoc).toContain("Thanks, I will send it tomorrow.");
    expect(srcdoc).toContain("<details");
    expect(srcdoc).toContain(strings.reader.quotedText);
    expect(srcdoc).toContain("min-height:2.75em");
  });

  it("opens the next message after the open one is archived", async () => {
    const first = readerMessage();
    const second = readerMessage({
      id: 2,
      uid: 2,
      subject: "Second message",
    });
    setReaderState(first);
    useAppStore.setState({
      messages: [first, second],
      selectedMessage: first,
      settings: {
        ...defaultSettings,
        groupThreads: false,
        readingPane: "right",
      },
    });
    vi.spyOn(api, "getMessage").mockImplementation(async (_accountId, id) =>
      readerMessage({
        id,
        uid: id,
        subject: id === 2 ? "Second message" : "First message",
      }),
    );
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.archive }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().selectedMessage?.id).toBe(2),
    );
    expect(api.moveMessage).toHaveBeenCalledWith("account-1", 1, "archive");
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual([2]);
  });

  it("puts the open message back when the move fails", async () => {
    const first = readerMessage();
    const second = readerMessage({
      id: 2,
      uid: 2,
      subject: "Second message",
    });
    setReaderState(first);
    useAppStore.setState({
      messages: [first, second],
      selectedMessage: first,
      settings: {
        ...defaultSettings,
        groupThreads: false,
        readingPane: "right",
      },
    });
    vi.spyOn(api, "moveMessage").mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(api, "getMessage").mockResolvedValue(
      readerMessage({ id: 2, uid: 2, subject: "Second message" }),
    );
    render(<MessageReader />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.archive }),
    );

    await waitFor(() =>
      expect(useAppStore.getState().error).toMatch(/offline/),
    );
    expect(useAppStore.getState().selectedMessage?.id).toBe(1);
    expect(useAppStore.getState().messages.map((item) => item.id)).toEqual([
      1, 2,
    ]);
  });

  it("trashes the store-selected message before the reader re-renders", async () => {
    const first = readerMessage();
    const second = readerMessage({ id: 2, subject: "Second message" });
    setReaderState(first);
    useAppStore.setState({
      messages: [first, second],
      selectedMessage: first,
    });
    render(<MessageReader />);
    useAppStore.setState({ selectedMessage: second });
    act(() => {
      window.dispatchEvent(
        new CustomEvent("postal:menu-action", { detail: "trash" }),
      );
    });
    await waitFor(() =>
      expect(api.moveMessage).toHaveBeenCalledWith("account-1", 2, "trash"),
    );
  });
});
