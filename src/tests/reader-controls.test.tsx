import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentList } from "../components/reader/attachmentList";
import { MessageHeader } from "../components/reader/messageHeader";
import { ReaderToolbar } from "../components/reader/readerToolbar";
import { SnoozePanel } from "../components/reader/snoozePanel";
import { strings } from "../i18n";
import {
  makeAccount,
  makeMailbox,
  makeMessage,
  messageDetail,
} from "./helpers/fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("message header", () => {
  it("shows complete details and copies protected identifiers", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const onToggleDetails = vi.fn();
    const message = messageDetail(makeMessage({ size: 2048 }), {
      to: ["sam@example.test"],
      cc: ["copy@example.test"],
      replyTo: "reply@example.test",
    });
    render(
      <MessageHeader
        message={message}
        account={makeAccount()}
        currentMailbox={makeMailbox()}
        showDetails
        onToggleDetails={onToggleDetails}
        titleRef={createRef()}
        treatAsOverlay
      />,
    );
    expect(
      screen.getByRole("heading", { name: message.subject }),
    ).toHaveAttribute("tabindex", "-1");
    expect(screen.getByText("2.0 KB")).toBeVisible();
    expect(screen.getByText(/Sam.*Inbox/)).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.hideDetails }),
    );
    expect(onToggleDetails).toHaveBeenCalled();

    const copyAddress = screen.getAllByRole("button", {
      name: strings.reader.copyAddress,
    })[0];
    await act(async () => {
      fireEvent.click(copyAddress);
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(message.senderAddress);
    expect(
      screen.getByRole("button", { name: strings.reader.copied }),
    ).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(
      screen.getAllByRole("button", { name: strings.reader.copyAddress }),
    ).not.toHaveLength(0);
  });

  it("uses safe fallbacks and tolerates unavailable clipboard", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    const message = messageDetail(
      makeMessage({ subject: "", senderName: "", messageId: "" }),
      { to: [], cc: [], replyTo: null },
    );
    const { rerender } = render(
      <MessageHeader
        message={message}
        showDetails={false}
        onToggleDetails={vi.fn()}
        titleRef={createRef()}
        treatAsOverlay={false}
      />,
    );
    expect(
      screen.getByRole("heading", { name: strings.common.noSubject }),
    ).not.toHaveAttribute("tabindex");
    expect(screen.getByText(strings.reader.noRecipients)).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.showDetails }),
    );

    rerender(
      <MessageHeader
        message={message}
        showDetails
        onToggleDetails={vi.fn()}
        titleRef={createRef()}
        treatAsOverlay={false}
      />,
    );
    expect(screen.getByText("Mailbox")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.copyAddress }),
    );
    await Promise.resolve();
    expect(
      screen.getByRole("button", { name: strings.reader.copyAddress }),
    ).toBeVisible();
  });
});

describe("reader toolbar", () => {
  const callbacks = {
    onBack: vi.fn(),
    onReply: vi.fn(),
    onReplyAll: vi.fn(),
    onForward: vi.fn(),
    onArchive: vi.fn(),
    onTrash: vi.fn(),
    onPrint: vi.fn(),
    onToggleRead: vi.fn(),
    onToggleStar: vi.fn(),
    onMoveJunk: vi.fn(),
    onMoveToInbox: vi.fn(),
    onMoveToMailbox: vi.fn(),
    onOpenSnooze: vi.fn(),
    onToggleMore: vi.fn(),
    onOpenMore: vi.fn(),
    onCloseMore: vi.fn(),
    onDismissMore: vi.fn(),
  };

  afterEach(() => {
    for (const callback of Object.values(callbacks)) callback.mockReset();
  });

  function toolbar(
    overrides: Partial<Parameters<typeof ReaderToolbar>[0]> = {},
  ) {
    return (
      <ReaderToolbar
        message={messageDetail(makeMessage())}
        mailboxes={[
          makeMailbox(),
          makeMailbox({ id: 2, role: "archive", displayName: "Archive" }),
          makeMailbox({ id: 3, accountId: "other", displayName: "Other" }),
        ]}
        readingPane="hidden"
        moreOpen
        moreMenuRef={createRef()}
        moreTriggerRef={createRef()}
        preparingForward={false}
        isArchiveMailbox={false}
        isTrashMailbox={false}
        isJunkMailbox={false}
        {...callbacks}
        {...overrides}
      />
    );
  }

  it("dispatches primary and overflow actions", () => {
    render(toolbar());
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.backToList }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.closeMessage }),
    );
    fireEvent.click(screen.getByRole("button", { name: strings.reader.reply }));
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.replyAll }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.forward }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.archive }),
    );
    fireEvent.click(screen.getByRole("button", { name: strings.reader.trash }));
    const more = screen.getByRole("button", {
      name: strings.reader.moreActions,
    });
    fireEvent.click(more);
    fireEvent.keyDown(more, { key: "ArrowDown" });
    fireEvent.keyDown(more, { key: "ArrowUp" });
    fireEvent.keyDown(more, { key: "Escape" });

    for (const label of [
      strings.reader.print,
      strings.reader.markRead,
      strings.reader.addStar,
      strings.reader.junk,
      strings.reader.snooze,
    ]) {
      fireEvent.click(screen.getByRole("menuitem", { name: label }));
    }
    fireEvent.change(
      screen.getByRole("combobox", { name: strings.reader.moveFolder }),
      { target: { value: "2" } },
    );

    expect(callbacks.onBack).toHaveBeenCalledTimes(2);
    expect(callbacks.onReply).toHaveBeenCalled();
    expect(callbacks.onReplyAll).toHaveBeenCalled();
    expect(callbacks.onForward).toHaveBeenCalled();
    expect(callbacks.onArchive).toHaveBeenCalled();
    expect(callbacks.onTrash).toHaveBeenCalled();
    expect(callbacks.onToggleMore).toHaveBeenCalled();
    expect(callbacks.onOpenMore).toHaveBeenCalledTimes(2);
    expect(callbacks.onPrint).toHaveBeenCalled();
    expect(callbacks.onToggleRead).toHaveBeenCalled();
    expect(callbacks.onToggleStar).toHaveBeenCalled();
    expect(callbacks.onMoveJunk).toHaveBeenCalled();
    expect(callbacks.onOpenSnooze).toHaveBeenCalled();
    expect(callbacks.onMoveToMailbox).toHaveBeenCalledWith(2);
  });

  it("reflects selected mailbox and message states", () => {
    render(
      toolbar({
        message: messageDetail(makeMessage({ isRead: true, isStarred: true })),
        readingPane: "right",
        preparingForward: true,
        isArchiveMailbox: true,
        isTrashMailbox: true,
        isJunkMailbox: true,
      }),
    );
    expect(
      screen.getByRole("button", { name: strings.reader.preparing }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: strings.reader.archive }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: strings.reader.trash }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: strings.reader.closeMessage }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.markUnread }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.removeStar }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.notJunk }),
    );
    expect(callbacks.onMoveToInbox).toHaveBeenCalled();
  });
});

describe("attachments", () => {
  const message = messageDetail(makeMessage(), {
    attachments: [
      {
        id: "inline",
        filename: "inline.png",
        contentType: "image/png",
        size: 10,
        inline: true,
      },
      {
        id: "image",
        filename: "photo.png",
        contentType: "image/png",
        size: 1024,
        inline: false,
      },
      {
        id: "binary",
        filename: "archive.bin",
        contentType: "application/octet-stream",
        size: 2048,
        inline: false,
      },
    ],
  });

  it("previews and downloads regular attachments", () => {
    const onPreview = vi.fn();
    const onDownload = vi.fn();
    const onPreviewDownload = vi.fn();
    const onPreviewClose = vi.fn();
    const { rerender } = render(
      <AttachmentList
        message={message}
        preview={{
          messageId: message.id,
          preview: {
            filename: "photo.png",
            contentType: "image/png",
            size: 1024,
            imageDataUrl: "data:image/png;base64,AA==",
          },
        }}
        isPreviewable={(attachment) => attachment.contentType === "image/png"}
        onPreview={onPreview}
        onDownload={onDownload}
        onPreviewDownload={onPreviewDownload}
        onPreviewClose={onPreviewClose}
      />,
    );
    expect(
      screen.getByRole("region", { name: strings.reader.attachments }),
    ).toHaveTextContent("2");
    expect(screen.queryByText("inline.png")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: `${strings.reader.preview}: photo.png`,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: `${strings.reader.downloadFile}: archive.bin`,
      }),
    );
    expect(onPreview).toHaveBeenCalledWith("image");
    expect(onDownload).toHaveBeenCalledWith("binary", "archive.bin");
    expect(screen.getByRole("img", { name: "photo.png" })).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.downloadFile }),
    );
    expect(onPreviewDownload).toHaveBeenCalled();
    expect(onPreviewClose).toHaveBeenCalled();

    rerender(
      <AttachmentList
        message={message}
        preview={{
          messageId: message.id,
          preview: {
            filename: "notes.txt",
            contentType: "text/plain",
            size: 4,
            text: "note",
          },
        }}
        downloadingAttachmentId="binary"
        previewAttachmentId="image"
        isPreviewable={() => true}
        onPreview={onPreview}
        onDownload={onDownload}
        onPreviewDownload={onPreviewDownload}
        onPreviewClose={onPreviewClose}
      />,
    );
    expect(screen.getByText("note")).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: /photo\.png|archive\.bin/ }),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ disabled: true })]),
    );
  });

  it("omits inline-only attachments and stale previews", () => {
    render(
      <AttachmentList
        message={messageDetail(makeMessage(), {
          attachments: [message.attachments[0]],
        })}
        preview={{
          messageId: 999,
          preview: {
            filename: "old.txt",
            contentType: "text/plain",
            size: 1,
            text: "old",
          },
        }}
        isPreviewable={() => false}
        onPreview={vi.fn()}
        onDownload={vi.fn()}
        onPreviewDownload={vi.fn()}
        onPreviewClose={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("region", { name: strings.reader.attachments }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("old")).not.toBeInTheDocument();
  });
});

describe("snooze panel", () => {
  it("offers tomorrow, next week, custom time, and cancel", () => {
    const onSnooze = vi.fn();
    const onClose = vi.fn();
    render(<SnoozePanel onSnooze={onSnooze} onClose={onClose} />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.snoozeTomorrow }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.snoozeNextWeek }),
    );
    const customButton = screen.getByRole("button", {
      name: strings.reader.snoozeUntil,
    });
    expect(customButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText(strings.reader.snoozeCustom), {
      target: { value: "2026-09-15T10:30" },
    });
    fireEvent.click(customButton);
    fireEvent.click(
      screen.getByRole("button", { name: strings.common.cancel }),
    );

    expect(onSnooze).toHaveBeenCalledTimes(3);
    expect(new Date(onSnooze.mock.calls[0][0]).getHours()).toBe(8);
    expect(new Date(onSnooze.mock.calls[1][0]).getDay()).toBe(1);
    expect(onSnooze.mock.calls[2][0]).toBe(
      new Date(2026, 8, 15, 10, 30).toISOString(),
    );
    expect(onClose).toHaveBeenCalled();
  });
});
