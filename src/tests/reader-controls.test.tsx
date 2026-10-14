import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentList } from "../components/reader/attachmentList";
import { MessageHeader } from "../components/reader/messageHeader";
import { ReaderToolbar } from "../components/reader/readerToolbar";
import { SnoozePanel } from "../components/reader/snoozePanel";
import { laterTodayIso } from "../components/reader/snoozeTimes";
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
    expect(screen.getByText("2.0 KB", { selector: "dd" })).toBeVisible();
    expect(screen.queryByRole("note")).toBeNull();
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
    expect(
      screen.getAllByRole("status").map((element) => element.textContent),
    ).toContain(strings.reader.copied);
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
    rerender(
      <MessageHeader
        message={messageDetail(
          makeMessage({
            senderName: "PayPal <service@paypal.com>",
            senderAddress: "jane@example.com",
          }),
        )}
        showDetails={false}
        onToggleDetails={vi.fn()}
        titleRef={createRef()}
        treatAsOverlay={false}
      />,
    );
    expect(
      screen.getByRole("note", {
        name: strings.reader.nameIncludesDifferentAddress("service@paypal.com"),
      }),
    ).toBeVisible();
  });

  it("names a mailing list on the message and in the details", () => {
    const message = messageDetail(makeMessage(), {
      listPost: "list@example.test",
    });
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
      screen.getByRole("note", {
        name: strings.reader.mailingList("list@example.test"),
      }),
    ).toBeVisible();
    rerender(
      <MessageHeader
        message={messageDetail(makeMessage(), { listPost: "not-a-list" })}
        showDetails
        onToggleDetails={vi.fn()}
        titleRef={createRef()}
        treatAsOverlay={false}
      />,
    );
    expect(screen.queryByRole("note", { name: /Mailing list/i })).toBeNull();
    rerender(
      <MessageHeader
        message={message}
        showDetails
        onToggleDetails={vi.fn()}
        titleRef={createRef()}
        treatAsOverlay={false}
      />,
    );
    expect(screen.getByText(strings.reader.mailingListLabel)).toBeVisible();
    expect(screen.getByText("list@example.test")).toBeVisible();
  });

  it("shows a hidden copy when the message has one", () => {
    const message = messageDetail(makeMessage(), {
      to: ["sam@example.test"],
      bcc: ["hidden@example.test"],
    });
    const { rerender } = render(
      <MessageHeader
        message={message}
        showDetails
        onToggleDetails={vi.fn()}
        titleRef={createRef()}
        treatAsOverlay={false}
      />,
    );
    expect(
      screen.getByText(strings.reader.bcc, { selector: "dt" }),
    ).toBeVisible();
    expect(screen.getAllByText("hidden@example.test")[0]).toBeVisible();
    rerender(
      <MessageHeader
        message={messageDetail(makeMessage(), { bcc: [] })}
        showDetails
        onToggleDetails={vi.fn()}
        titleRef={createRef()}
        treatAsOverlay={false}
      />,
    );
    expect(screen.queryByText(strings.reader.bcc)).toBeNull();
  });

  it("shows when the server received a message long after its date", () => {
    const message = messageDetail(
      makeMessage({
        receivedAt: "2026-08-18T12:00:00Z",
        arrivedAt: "2026-08-18T18:00:00Z",
      }),
    );
    const { rerender } = render(
      <MessageHeader
        message={message}
        showDetails
        onToggleDetails={vi.fn()}
        titleRef={createRef()}
        treatAsOverlay={false}
      />,
    );
    expect(screen.getByText(strings.reader.arrived)).toBeVisible();
    rerender(
      <MessageHeader
        message={messageDetail(
          makeMessage({
            receivedAt: "2026-08-18T12:00:00Z",
            arrivedAt: "2026-08-18T12:05:00Z",
          }),
        )}
        showDetails
        onToggleDetails={vi.fn()}
        titleRef={createRef()}
        treatAsOverlay={false}
      />,
    );
    expect(screen.queryByText(strings.reader.arrived)).toBeNull();
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
    onCopyMessageText: vi.fn(),
    onToggleRead: vi.fn(),
    onToggleStar: vi.fn(),
    onMoveJunk: vi.fn(),
    onBlockSender: vi.fn(),
    onMuteConversation: vi.fn(),
    onMoveToInbox: vi.fn(),
    onMoveToMailbox: vi.fn(),
    onOpenSnooze: vi.fn(),
    onCreateRule: vi.fn(),
    onMessagesFromSender: vi.fn(),
    onUnsubscribe: vi.fn(),
    onShowOriginal: vi.fn(),
    onTogglePlain: vi.fn(),
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
          makeMailbox({
            id: 2,
            role: "other",
            name: "Projects",
            displayName: "Projects",
          }),
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
      strings.reader.copyMessageText,
      strings.reader.markRead,
      strings.reader.addStar,
      strings.reader.junk,
      strings.reader.blockSender,
      strings.reader.muteConversation,
      strings.reader.snooze,
      strings.reader.createRuleFromSender,
      strings.reader.messagesFromSender,
    ]) {
      fireEvent.click(screen.getByRole("menuitem", { name: label }));
    }
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.contextMenu.moveToFolder("Projects"),
      }),
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
    expect(callbacks.onCopyMessageText).toHaveBeenCalled();
    expect(callbacks.onToggleRead).toHaveBeenCalled();
    expect(callbacks.onToggleStar).toHaveBeenCalled();
    expect(callbacks.onMoveJunk).toHaveBeenCalled();
    expect(callbacks.onBlockSender).toHaveBeenCalled();
    expect(callbacks.onMuteConversation).toHaveBeenCalled();
    expect(callbacks.onOpenSnooze).toHaveBeenCalled();
    expect(callbacks.onCreateRule).toHaveBeenCalled();
    expect(callbacks.onMessagesFromSender).toHaveBeenCalled();
    expect(
      screen.queryByRole("menuitem", { name: strings.reader.viewPlain }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", {
        name: strings.reader.markConversationRead,
      }),
    ).not.toBeInTheDocument();
    expect(callbacks.onMoveToMailbox).toHaveBeenCalledWith(2);
  });

  it("starts a subject rule from the message menu", () => {
    const onCreateSubjectRule = vi.fn();
    render(toolbar({ onCreateSubjectRule }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.createRuleFromSubject,
      }),
    );
    expect(onCreateSubjectRule).toHaveBeenCalledOnce();
  });

  it("replies with attachments from the message menu", () => {
    const onReplyWithAttachments = vi.fn();
    const onReplyAllWithAttachments = vi.fn();
    render(toolbar({ onReplyWithAttachments, onReplyAllWithAttachments }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.replyWithAttachments,
      }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.replyAllWithAttachments,
      }),
    );
    expect(onReplyWithAttachments).toHaveBeenCalledOnce();
    expect(onReplyAllWithAttachments).toHaveBeenCalledOnce();
    expect(callbacks.onCloseMore).toHaveBeenCalledTimes(2);
  });

  it("steps to the previous and next message", () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const { rerender } = render(toolbar({ onNext }));
    expect(
      screen.getByRole("button", { name: strings.reader.previousMessage }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.nextMessage }),
    );
    expect(onNext).toHaveBeenCalledOnce();
    rerender(toolbar({ onPrevious }));
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.previousMessage }),
    );
    expect(onPrevious).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: strings.reader.nextMessage }),
    ).toBeDisabled();
  });

  it("replies to the list when that action is available", () => {
    const onReplyToList = vi.fn();
    render(toolbar({ onReplyToList }));
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.replyToList }),
    );
    expect(onReplyToList).toHaveBeenCalledOnce();
  });

  it("redirects the open message", () => {
    const onRedirect = vi.fn();
    render(toolbar({ onRedirect }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.redirect }),
    );
    expect(onRedirect).toHaveBeenCalledOnce();
  });

  it("forwards the open message as an attachment", () => {
    const onForwardAsAttachment = vi.fn();
    render(toolbar({ onForwardAsAttachment }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.forwardAsAttachment,
      }),
    );
    expect(onForwardAsAttachment).toHaveBeenCalledOnce();
  });

  it("starts a new message from the open message", () => {
    const onEditAsNew = vi.fn();
    render(toolbar({ onEditAsNew }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.editAsNew }),
    );
    expect(onEditAsNew).toHaveBeenCalledOnce();
  });

  it("marks the conversation read from the message menu", () => {
    const onMarkConversationRead = vi.fn();
    render(toolbar({ onMarkConversationRead }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.markConversationRead,
      }),
    );
    expect(onMarkConversationRead).toHaveBeenCalledOnce();
  });

  it("archives the conversation from the message menu", () => {
    const onArchiveConversation = vi.fn();
    render(toolbar({ onArchiveConversation }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.archiveConversation,
      }),
    );
    expect(onArchiveConversation).toHaveBeenCalledOnce();
  });

  it("marks the conversation as junk from the message menu", () => {
    const onJunkConversation = vi.fn();
    render(toolbar({ onJunkConversation }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.junkConversation,
      }),
    );
    expect(onJunkConversation).toHaveBeenCalledOnce();
  });

  it("pins the open message from the message menu", () => {
    const onPin = vi.fn();
    render(toolbar({ onPin }));
    fireEvent.click(screen.getByRole("menuitem", { name: strings.reader.pin }));
    expect(onPin).toHaveBeenCalledOnce();
  });

  it("forwards the conversation from the message menu", () => {
    const onForwardConversation = vi.fn();
    render(toolbar({ onForwardConversation }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.forwardConversation,
      }),
    );
    expect(onForwardConversation).toHaveBeenCalledOnce();
  });

  it("copies the conversation from the message menu", () => {
    const onCopyConversationText = vi.fn();
    render(toolbar({ onCopyConversationText }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.copyConversationText,
      }),
    );
    expect(onCopyConversationText).toHaveBeenCalledOnce();
  });

  it("prints the conversation from the message menu", () => {
    const onPrintConversation = vi.fn();
    render(toolbar({ onPrintConversation }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.printConversation,
      }),
    );
    expect(onPrintConversation).toHaveBeenCalledOnce();
  });

  it("moves the conversation from the message menu", () => {
    const onMoveConversationToMailbox = vi.fn();
    render(toolbar({ onMoveConversationToMailbox }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.contextMenu.moveConversationToFolder("Projects"),
      }),
    );
    expect(onMoveConversationToMailbox).toHaveBeenCalledWith(2);
  });

  it("copies the conversation from the message menu", () => {
    const onCopyConversationToMailbox = vi.fn();
    render(toolbar({ onCopyConversationToMailbox }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.contextMenu.copyConversationToFolder("Projects"),
      }),
    );
    expect(onCopyConversationToMailbox).toHaveBeenCalledWith(2);
  });

  it("saves the conversation files from the message menu", () => {
    const onSaveConversationFiles = vi.fn();
    render(toolbar({ onSaveConversationFiles }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.saveConversationFiles,
      }),
    );
    expect(onSaveConversationFiles).toHaveBeenCalledOnce();
  });

  it("snoozes the conversation from the message menu", () => {
    const onSnoozeConversation = vi.fn();
    render(toolbar({ onSnoozeConversation }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.snoozeConversation,
      }),
    );
    expect(onSnoozeConversation).toHaveBeenCalledOnce();
  });

  it("selects the conversation from the message menu", () => {
    const onSelectConversation = vi.fn();
    render(toolbar({ onSelectConversation }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.selectConversation,
      }),
    );
    expect(onSelectConversation).toHaveBeenCalledOnce();
  });

  it("stars the conversation from the message menu", () => {
    const onStarConversation = vi.fn();
    render(toolbar({ onStarConversation }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.starConversation,
      }),
    );
    expect(onStarConversation).toHaveBeenCalledOnce();
  });

  it("marks the conversation unread from the message menu", () => {
    const onMarkConversationUnread = vi.fn();
    render(toolbar({ onMarkConversationUnread }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.markConversationUnread,
      }),
    );
    expect(onMarkConversationUnread).toHaveBeenCalledOnce();
  });

  it("unblocks a sender from the message menu", () => {
    const onUnblockSender = vi.fn();
    render(
      toolbar({
        senderBlocked: true,
        onUnblockSender,
      }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.unblockSender,
      }),
    );
    expect(onUnblockSender).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("menuitem", {
        name: strings.reader.blockSender,
      }),
    ).not.toBeInTheDocument();
  });

  it("deletes a conversation from the message menu", () => {
    const onDeleteConversation = vi.fn();
    render(toolbar({ isTrashMailbox: true, onDeleteConversation }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: strings.reader.deleteConversation,
      }),
    );
    expect(onDeleteConversation).toHaveBeenCalledOnce();
  });

  it("switches a formatted message to plain text", () => {
    render(toolbar({ canViewPlain: true }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: strings.reader.viewPlain }),
    );
    expect(callbacks.onTogglePlain).toHaveBeenCalled();
    render(toolbar({ canViewPlain: true, viewingPlain: true }));
    expect(
      screen.getByRole("menuitem", { name: strings.reader.viewFormatted }),
    ).toBeVisible();
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
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.moveToInbox }),
    );
    expect(callbacks.onMoveToInbox).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", { name: strings.mail.deleteForever }),
    );
    expect(callbacks.onTrash).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("menuitem", {
        name: strings.reader.deleteConversation,
      }),
    ).not.toBeInTheDocument();
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
    expect(callbacks.onMoveToInbox).toHaveBeenCalledTimes(2);
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
    const onSaveAll = vi.fn();
    const onPreviewDownload = vi.fn();
    const onPreviewClose = vi.fn();
    const { rerender } = render(
      <AttachmentList
        message={message}
        preview={{
          messageId: message.id,
          attachmentId: "image",
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
        onSaveAll={onSaveAll}
        onPreviewDownload={onPreviewDownload}
        onPreviewClose={onPreviewClose}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.reader.saveAllFiles }),
    );
    expect(onSaveAll).toHaveBeenCalled();
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
          attachmentId: "image",
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
        onSaveAll={onSaveAll}
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
          attachmentId: "old",
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
        onSaveAll={vi.fn()}
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
  it("offers later today while 6 PM is still an hour away", () => {
    expect(laterTodayIso(new Date(2026, 9, 9, 15, 0, 0))).toBe(
      new Date(2026, 9, 9, 18, 0, 0).toISOString(),
    );
    expect(laterTodayIso(new Date(2026, 9, 9, 17, 0, 0))).toBe(
      new Date(2026, 9, 9, 18, 0, 0).toISOString(),
    );
    expect(laterTodayIso(new Date(2026, 9, 9, 17, 30, 0))).toBeUndefined();
    expect(laterTodayIso(new Date(2026, 9, 9, 19, 0, 0))).toBeUndefined();
  });

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
