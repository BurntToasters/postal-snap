import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { MessageReader } from "../components/MessageReader";
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
  setReaderState();
  vi.spyOn(api, "setMessageFlags").mockResolvedValue(undefined);
  vi.spyOn(api, "moveMessage").mockResolvedValue(undefined);
  vi.spyOn(api, "moveMessageToMailbox").mockResolvedValue(undefined);
  vi.spyOn(api, "prepareForwardAttachments").mockResolvedValue([]);
  vi.spyOn(api, "previewAttachment").mockResolvedValue({
    filename: "photo.png",
    contentType: "image/png",
    size: 1024,
    imageDataUrl: "data:image/png;base64,AA==",
  });
  vi.spyOn(api, "saveAttachment").mockResolvedValue(undefined);
  vi.spyOn(api, "snoozeMessage").mockResolvedValue(undefined);
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
    useAppStore.setState({
      settings: { ...defaultSettings, readingPane: "hidden" },
    });
    rerender(<MessageReader />);
    expect(document.getElementById("reader-pane")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
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
      fireEvent.change(
        screen.getByRole("combobox", { name: strings.reader.moveFolder }),
        { target: { value: "5" } },
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
    fireEvent.change(
      screen.getByRole("combobox", { name: strings.reader.moveFolder }),
      { target: { value: String(custom.id) } },
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
    const frameFind = vi.fn(() => true);
    Object.defineProperty(frameWindow, "find", {
      configurable: true,
      value: frameFind,
    });
    const body = (iframe as HTMLIFrameElement).contentDocument!.body;
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
      { target: { value: "HTML" } },
    );
    fireEvent.submit(
      screen
        .getByRole("textbox", { name: strings.reader.findInMessage })
        .closest("form")!,
    );
    expect(frameScroll).toHaveBeenCalledWith(0, expect.any(Number));
    expect(frameFind).toHaveBeenCalledWith("HTML");
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
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.archive }),
    );
    expect(api.moveMessage).not.toHaveBeenCalled();
    window.removeEventListener("postal:print-message", printed);
  });
});
