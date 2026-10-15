import { fireEvent, render, screen } from "@testing-library/react";
import { Inbox } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { PostalError } from "../errors";
import {
  DraftList,
  OutboxList,
  SnoozedList,
} from "../components/mail/localLists";
import { SentNoticeToast } from "../components/mail/mailDialogs";
import {
  isOversizeError,
  matchesLocalQuery,
  mergeSearchResults,
} from "../components/mail/mailSearch";
import {
  mailboxByRole,
  mailboxesMatchingQuery,
  mailboxesForUnreadView,
  nextUnreadMailbox,
  previousUnreadMailbox,
} from "../components/mail/folderTreeModel";
import { FolderButton } from "../components/mail/folderButton";
import { MessageList } from "../components/mail/messageList";
import { toggleListedRead } from "../markRead";
import { toggleListedStar } from "../starConversation";
import { messageListDay } from "../format";
import { strings } from "../i18n";
import { defaultSettings, useAppStore } from "../store";
import type { DraftSummary, OutboxSummary } from "../types";
import { makeMailbox, makeMessage } from "./helpers/fixtures";
import { resetStore } from "./helpers/store";

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("listed star", () => {
  it("keeps the star when saving it fails", async () => {
    const message = makeMessage({ id: 4, isStarred: false });
    useAppStore.setState({
      messages: [message],
      activeAccountId: message.accountId,
      activeMailboxId: message.mailboxId,
    });
    const flags = vi
      .spyOn(api, "setMessageFlags")
      .mockResolvedValueOnce(undefined);
    await toggleListedStar(message.id);
    expect(useAppStore.getState().messages[0]?.isStarred).toBe(true);
    flags.mockRejectedValueOnce(new Error("offline"));
    await toggleListedStar(message.id);
    expect(useAppStore.getState().messages[0]?.isStarred).toBe(true);
    expect(useAppStore.getState().error).toMatch(/offline/i);
  });

  it("marks a listed message read and restores the unread count when saving fails", async () => {
    const message = makeMessage({ id: 5, isRead: false, mailboxId: 1 });
    useAppStore.setState({
      messages: [message],
      mailboxes: [makeMailbox({ id: 1, unreadCount: 2 })],
      activeAccountId: message.accountId,
      activeMailboxId: 1,
    });
    const flags = vi
      .spyOn(api, "setMessageFlags")
      .mockResolvedValueOnce(undefined);
    await toggleListedRead(message.id);
    expect(useAppStore.getState().messages[0]?.isRead).toBe(true);
    expect(useAppStore.getState().mailboxes[0]?.unreadCount).toBe(1);
    flags.mockRejectedValueOnce(new Error("offline"));
    await toggleListedRead(message.id);
    expect(useAppStore.getState().messages[0]?.isRead).toBe(true);
    expect(useAppStore.getState().mailboxes[0]?.unreadCount).toBe(1);
    expect(useAppStore.getState().error).toMatch(/offline/i);
  });
});

describe("local mailbox lists", () => {
  it("renders empty local-list states", () => {
    const { rerender } = render(
      <SnoozedList items={[]} onOpen={vi.fn()} onUnsnooze={vi.fn()} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      strings.mail.noSnoozed,
    );
    rerender(<DraftList drafts={[]} accountEmail="" onOpen={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(strings.mail.noDrafts);
    rerender(
      <OutboxList
        items={[]}
        onRetry={vi.fn()}
        onRetryCopy={vi.fn()}
        onSendNow={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(strings.mail.noQueued);
  });

  it("opens and restores snoozed messages", () => {
    const onOpen = vi.fn();
    const onUnsnooze = vi.fn();
    const message = makeMessage({ senderName: "", subject: "" });
    render(
      <SnoozedList
        items={[
          {
            message,
            snoozedUntil: new Date(Date.now() + 86_400_000).toISOString(),
          },
        ]}
        onOpen={onOpen}
        onUnsnooze={onUnsnooze}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Unread/ }));
    fireEvent.click(
      screen.getByRole("button", {
        name: strings.mail.unsnoozeMessage(strings.common.noSubject),
      }),
    );
    expect(onOpen).toHaveBeenCalledWith(message);
    expect(onUnsnooze).toHaveBeenCalledWith(message.id);
  });

  it("shows every draft synchronization state", () => {
    const onOpen = vi.fn();
    const states: DraftSummary["syncState"][] = [
      "synced",
      "conflict",
      "localOnly",
      "localPending",
    ];
    const drafts: DraftSummary[] = states.map((syncState, index) => ({
      id: `draft-${index}`,
      accountId: "account-1",
      recipients: index ? "to@example.test" : "",
      subject: index ? `Draft ${index}` : "",
      updatedAt: "2026-09-01T12:00:00Z",
      syncState,
      syncDetail: index === 1 ? "Recovered after conflict" : null,
    }));
    render(<DraftList drafts={drafts} accountEmail="" onOpen={onOpen} />);
    expect(screen.getByText(strings.mail.savedServer)).toBeVisible();
    expect(screen.getByText(strings.mail.recoveredConflict)).toBeVisible();
    expect(screen.getByText(strings.mail.savedLocal)).toBeVisible();
    expect(screen.getByText(strings.mail.savingServer)).toBeVisible();
    fireEvent.click(screen.getByText("Draft 2").closest("button")!);
    expect(onOpen).toHaveBeenCalledWith("draft-2");
  });

  it("dispatches every outbox recovery action", () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-01T12:00:00Z");
    vi.setSystemTime(now);
    const base = {
      accountId: "account-1",
      recipients: "to@example.test",
      subject: "Message",
      detail: "Status detail",
      createdAt: now.toISOString(),
    };
    const states: OutboxSummary["state"][] = [
      "queued",
      "sending",
      "sent_copy_pending",
      "needs_attention",
      "scheduled",
    ];
    const items = states.map((state, index) => ({
      ...base,
      id: `outbox-${index}`,
      state,
      sendAt:
        state === "scheduled"
          ? new Date(now.getTime() + 10_000).toISOString()
          : null,
    }));
    const onRetry = vi.fn();
    const onRetryCopy = vi.fn();
    const onSendNow = vi.fn();
    const onDiscard = vi.fn();
    render(
      <OutboxList
        items={items}
        onRetry={onRetry}
        onRetryCopy={onRetryCopy}
        onSendNow={onSendNow}
        onDiscard={onDiscard}
      />,
    );
    expect(screen.getByText(strings.mail.waitingSend)).toBeVisible();
    expect(screen.getByText(strings.mail.sending)).toBeVisible();
    expect(screen.getByText(strings.mail.sentCopyPending)).toBeVisible();
    expect(screen.getByText(strings.mail.needsAttention)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: strings.mail.retryAll }),
    ).toBeNull();
    expect(screen.getByText(strings.mail.scheduledWaiting)).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: strings.mail.retrySending }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.mail.saveSentCopy }),
    );
    fireEvent.click(screen.getByRole("button", { name: strings.mail.sendNow }));
    screen.getAllByRole("button", { name: strings.common.discard })[0].click();
    screen.getByRole("button", { name: strings.mail.dismissWarning }).click();
    screen.getByRole("button", { name: strings.mail.undoSend }).click();
    expect(onRetry).toHaveBeenCalledWith("outbox-3");
    expect(onRetryCopy).toHaveBeenCalledWith("outbox-2");
    expect(onSendNow).toHaveBeenCalledWith("outbox-4");
    expect(onDiscard).toHaveBeenCalledWith("outbox-2", "sent_copy_pending");
    expect(onDiscard).toHaveBeenCalledWith("outbox-4", "scheduled");
    vi.advanceTimersByTime(1000);
  });

  it("offers one retry for every message that needs attention", () => {
    const onRetryAll = vi.fn();
    const base = {
      accountId: "account-1",
      recipients: "to@example.test",
      subject: "Message",
      detail: "Status detail",
      createdAt: "2026-09-01T12:00:00Z",
      sendAt: null,
    };
    render(
      <OutboxList
        items={[
          { ...base, id: "outbox-1", state: "needs_attention" },
          {
            ...base,
            id: "outbox-2",
            state: "needs_attention",
            subject: "Later",
          },
          { ...base, id: "outbox-3", state: "queued" },
        ]}
        onRetry={vi.fn()}
        onRetryAll={onRetryAll}
        onRetryCopy={vi.fn()}
        onSendNow={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.mail.retryAll }),
    );
    expect(onRetryAll).toHaveBeenCalledOnce();
    expect(
      screen.getAllByRole("button", { name: strings.mail.retrySending }),
    ).toHaveLength(2);
  });
});

describe("sent notice", () => {
  it("opens Outbox, dismisses, expires, and reports failed undo", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "restoreOutbox").mockRejectedValue(
      new Error("restore failed"),
    );
    useAppStore.setState({
      lastSent: { outboxId: "outbox", accountId: "account-1", scheduled: true },
    });
    const { rerender } = render(<SentNoticeToast />);
    expect(screen.getByText(strings.mail.messageScheduled)).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: strings.mail.undoSend }),
    );
    await vi.runAllTicks();
    expect(useAppStore.getState().error).toBe("Error: restore failed");
    fireEvent.click(
      screen.getByRole("button", { name: strings.mail.viewOutbox }),
    );
    expect(useAppStore.getState().activeLocalView).toBe("outbox");
    expect(useAppStore.getState().lastSent).toBeUndefined();

    useAppStore.setState({
      lastSent: {
        outboxId: "second",
        accountId: "account-1",
        scheduled: false,
      },
    });
    rerender(<SentNoticeToast />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.mail.dismissNotice }),
    );
    expect(useAppStore.getState().lastSent).toBeUndefined();

    useAppStore.setState({
      lastSent: { outboxId: "third", accountId: "account-1", scheduled: false },
    });
    rerender(<SentNoticeToast />);
    vi.advanceTimersByTime(17_000);
    expect(useAppStore.getState().lastSent).toBeUndefined();
  });

  it("undo reopens the message without moving mail; Rust cancels the archive", async () => {
    vi.spyOn(api, "restoreOutbox").mockResolvedValue({
      id: "draft-1",
      accountId: "account-1",
      to: ["jane@example.test"],
      cc: [],
      bcc: [],
      subject: "Re: Picnic",
      htmlBody: "<p></p>",
      textBody: "",
      attachments: [],
    });
    const moveBack = vi
      .spyOn(api, "moveMessageToMailbox")
      .mockResolvedValue(undefined);
    useAppStore.setState({
      lastSent: {
        outboxId: "outbox",
        accountId: "account-1",
        scheduled: false,
        undoSeconds: 10,
      },
    });
    render(<SentNoticeToast />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.mail.undoSend }),
    );
    await vi.waitFor(() =>
      expect(useAppStore.getState().composerOpen).toBe(true),
    );
    expect(moveBack).not.toHaveBeenCalled();
  });
});

describe("mail search helpers", () => {
  it("recognizes oversize failures and merges unique newest server hits", () => {
    expect(
      isOversizeError(
        new PostalError({
          code: "limitExceeded",
          message: "large",
          retryable: false,
        }),
      ),
    ).toBe(true);
    expect(isOversizeError(new Error("exceeds the safety limit"))).toBe(true);
    expect(isOversizeError(new Error("offline"))).toBe(false);
    const first = makeMessage({ id: 1, receivedAt: "2026-01-01T00:00:00Z" });
    const second = makeMessage({ id: 2, receivedAt: "2026-03-01T00:00:00Z" });
    const third = makeMessage({ id: 3, receivedAt: "2026-02-01T00:00:00Z" });
    expect(mergeSearchResults([first, first], [first, third, second])).toEqual([
      first,
      second,
      third,
    ]);
    expect(matchesLocalQuery("Hello World", " world ")).toBe(true);
    expect(matchesLocalQuery("Hello", "missing")).toBe(false);
    expect(matchesLocalQuery("anything", "  ")).toBe(true);
  });
});

describe("message list states and keyboard", () => {
  const first = makeMessage({ hasAttachments: true, isStarred: true });
  const second = makeMessage({
    id: 2,
    senderName: "",
    subject: "",
    preview: "",
  });

  it("shows the message size beside the date", () => {
    render(
      <MessageList
        messages={[makeMessage({ id: 1, size: 2048 })]}
        loading={false}
        onChoose={vi.fn()}
        hasMore={false}
        onLoadMore={vi.fn()}
      />,
    );
    const row = screen.getByRole("option", { name: /First message/i });
    expect(row).toHaveTextContent("2.0 KB");
    expect(row).toHaveAccessibleName(/2\.0 KB/);
  });

  it("stars a listed message without opening it", () => {
    const onChoose = vi.fn();
    const onToggleStar = vi.fn();
    render(
      <MessageList
        messages={[first]}
        loading={false}
        onChoose={onChoose}
        hasMore={false}
        onLoadMore={vi.fn()}
        onToggleStar={onToggleStar}
      />,
    );
    // Pointer shortcut: hidden from assistive tech; the s key is the keyboard path.
    const star = document.querySelector<HTMLButtonElement>(
      ".row-action[data-action='star']",
    )!;
    expect(star).toHaveAttribute("aria-label", strings.reader.removeStar);
    expect(star).toHaveAttribute("tabindex", "-1");
    expect(star.closest(".row-actions")).toHaveAttribute("aria-hidden", "true");
    expect(
      document.querySelector(".message-subject .star-mark"),
    ).not.toBeNull();
    expect(document.querySelector(".message-star-hit")).toBeNull();
    fireEvent.click(star);
    expect(onToggleStar).toHaveBeenCalledWith(
      expect.objectContaining({ id: first.id }),
    );
    expect(onChoose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("option", { name: /First message/i }), {
      key: "s",
    });
    expect(onToggleStar).toHaveBeenCalledTimes(2);
  });

  it("marks a listed message read without opening it", () => {
    const onChoose = vi.fn();
    const onToggleRead = vi.fn();
    render(
      <MessageList
        messages={[first]}
        loading={false}
        onChoose={onChoose}
        hasMore={false}
        onLoadMore={vi.fn()}
        onToggleRead={onToggleRead}
      />,
    );
    // Pointer shortcut: hidden from assistive tech; the u key is the keyboard path.
    const read = document.querySelector<HTMLButtonElement>(
      ".row-action[data-action='read']",
    )!;
    expect(read).toHaveAttribute("aria-label", strings.reader.markRead);
    expect(read).toHaveAttribute("tabindex", "-1");
    expect(read.closest(".row-actions")).toHaveAttribute("aria-hidden", "true");
    expect(document.querySelector(".message-read-hit")).toBeNull();
    fireEvent.click(read);
    expect(onToggleRead).toHaveBeenCalledWith(
      expect.objectContaining({ id: first.id }),
    );
    expect(onChoose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("option", { name: /First message/i }), {
      key: "u",
    });
    expect(onToggleRead).toHaveBeenCalledTimes(2);
  });

  it("checks the focused message without opening it", () => {
    const onChoose = vi.fn();
    const onCheckFocused = vi.fn();
    render(
      <MessageList
        messages={[first]}
        loading={false}
        onChoose={onChoose}
        hasMore={false}
        onLoadMore={vi.fn()}
        onCheckFocused={onCheckFocused}
      />,
    );
    fireEvent.keyDown(screen.getByRole("option", { name: /First message/i }), {
      key: "x",
    });
    expect(onCheckFocused).toHaveBeenCalledWith([first.id]);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("checks every loaded message in a focused conversation", () => {
    const threaded = [first, second].map((message) => ({
      ...message,
      subject: "Thread",
      threadRoot: "<thread@example.test>",
    }));
    const onChoose = vi.fn();
    const onCheckFocused = vi.fn();
    render(
      <MessageList
        messages={threaded}
        loading={false}
        onChoose={onChoose}
        hasMore={false}
        onLoadMore={vi.fn()}
        onCheckFocused={onCheckFocused}
      />,
    );
    fireEvent.keyDown(screen.getByRole("treeitem", { name: /Conversation/ }), {
      key: "x",
    });
    expect(onCheckFocused.mock.calls[0]?.[0].slice().sort()).toEqual([
      first.id,
      second.id,
    ]);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("archives the focused message without opening it", () => {
    const onChoose = vi.fn();
    const onArchiveFocused = vi.fn();
    render(
      <MessageList
        messages={[first]}
        loading={false}
        onChoose={onChoose}
        hasMore={false}
        onLoadMore={vi.fn()}
        onArchiveFocused={onArchiveFocused}
      />,
    );
    fireEvent.keyDown(screen.getByRole("option", { name: /First message/i }), {
      key: "e",
    });
    expect(onArchiveFocused).toHaveBeenCalledWith(
      expect.objectContaining({ id: first.id }),
      false,
    );
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("archives every loaded message in a focused conversation", () => {
    const threaded = [first, second].map((message) => ({
      ...message,
      subject: "Thread",
      threadRoot: "<thread@example.test>",
    }));
    const onChoose = vi.fn();
    const onArchiveFocused = vi.fn();
    render(
      <MessageList
        messages={threaded}
        loading={false}
        onChoose={onChoose}
        hasMore={false}
        onLoadMore={vi.fn()}
        onArchiveFocused={onArchiveFocused}
      />,
    );
    fireEvent.keyDown(screen.getByRole("treeitem", { name: /Conversation/ }), {
      key: "e",
    });
    expect(onArchiveFocused).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Thread" }),
      true,
    );
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("moves the focused message toward Trash without opening it", () => {
    const onChoose = vi.fn();
    const onTrashFocused = vi.fn();
    render(
      <MessageList
        messages={[first]}
        loading={false}
        onChoose={onChoose}
        hasMore={false}
        onLoadMore={vi.fn()}
        onTrashFocused={onTrashFocused}
      />,
    );
    const row = screen.getByRole("option", { name: /First message/i });
    fireEvent.keyDown(row, { key: "Delete" });
    fireEvent.keyDown(row, { key: "#" });
    expect(onTrashFocused).toHaveBeenCalledTimes(2);
    expect(onTrashFocused).toHaveBeenCalledWith(
      expect.objectContaining({ id: first.id }),
      false,
    );
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("marks the focused message as junk without opening it", () => {
    const onChoose = vi.fn();
    const onJunkFocused = vi.fn();
    render(
      <MessageList
        messages={[first]}
        loading={false}
        onChoose={onChoose}
        hasMore={false}
        onLoadMore={vi.fn()}
        onJunkFocused={onJunkFocused}
      />,
    );
    fireEvent.keyDown(screen.getByRole("option", { name: /First message/i }), {
      key: "!",
    });
    expect(onJunkFocused).toHaveBeenCalledWith(
      expect.objectContaining({ id: first.id }),
      false,
    );
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("replies to the focused message without opening it", () => {
    const onChoose = vi.fn();
    const onReplyFocused = vi.fn();
    render(
      <MessageList
        messages={[first]}
        loading={false}
        onChoose={onChoose}
        hasMore={false}
        onLoadMore={vi.fn()}
        onReplyFocused={onReplyFocused}
      />,
    );
    const row = screen.getByRole("option", { name: /First message/i });
    fireEvent.keyDown(row, { key: "r" });
    fireEvent.keyDown(row, { key: "a" });
    expect(onReplyFocused).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: first.id }),
      "reply",
    );
    expect(onReplyFocused).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: first.id }),
      "replyAll",
    );
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("shows loading, empty, and searchable empty states", () => {
    const props = {
      selectedId: undefined,
      loading: true,
      onChoose: vi.fn(),
      hasMore: false,
      onLoadMore: vi.fn(),
      onToggleSelect: vi.fn(),
    };
    const { rerender } = render(<MessageList {...props} messages={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      strings.mail.loadingMessages,
    );
    rerender(<MessageList {...props} messages={[]} loading={false} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      strings.mail.emptyMailbox,
    );
    const clear = vi.fn();
    rerender(
      <MessageList
        {...props}
        messages={[]}
        loading={false}
        searchQuery="needle"
        onClearSearch={clear}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.mail.clearSearch }),
    );
    expect(clear).toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: strings.mail.searchAllMailboxes }),
    ).toBeNull();
    const widen = vi.fn();
    rerender(
      <MessageList
        {...props}
        messages={[]}
        loading={false}
        searchQuery="needle"
        onClearSearch={clear}
        onSearchAllFolders={widen}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.mail.searchAllMailboxes }),
    );
    expect(widen).toHaveBeenCalled();
  });

  it("names the people a Sent or Drafts message was written to", () => {
    useAppStore.setState({
      settings: { ...defaultSettings, groupThreads: false },
      mailboxes: [
        makeMailbox(),
        makeMailbox({
          id: 2,
          name: "Sent",
          displayName: "Sent",
          role: "sent",
          unreadCount: 0,
          totalCount: 2,
        }),
        makeMailbox({
          id: 3,
          name: "Drafts",
          displayName: "Drafts",
          role: "drafts",
          unreadCount: 0,
          totalCount: 1,
        }),
      ],
    });
    const inboxMessage = makeMessage({ subject: "Picnic" });
    const sent = makeMessage({
      id: 2,
      mailboxId: 2,
      senderName: "Sam",
      subject: "Notes",
      recipients: "jane@example.test, lee@example.test",
    });
    const draft = makeMessage({
      id: 3,
      mailboxId: 3,
      senderName: "Sam",
      subject: "Later",
      recipients: "  ",
    });
    render(
      <MessageList
        messages={[inboxMessage, sent, draft]}
        selectedId={undefined}
        loading={false}
        onChoose={vi.fn()}
        hasMore={false}
        onLoadMore={vi.fn()}
      />,
    );
    const inboxRow = screen.getByRole("option", { name: /Picnic/ });
    const sentRow = screen.getByRole("option", { name: /Notes/ });
    const draftRow = screen.getByRole("option", { name: /Later/ });
    expect(inboxRow.querySelector(".message-sender")).toHaveTextContent("Jane");
    expect(sentRow.querySelector(".message-sender")).toHaveTextContent(
      "To jane@example.test, lee@example.test",
    );
    expect(sentRow).toHaveAccessibleName(
      /To jane@example.test, lee@example.test/,
    );
    expect(sentRow).not.toHaveAccessibleName(/Sam/);
    expect(draftRow.querySelector(".message-sender")).toHaveTextContent(
      strings.mail.noRecipient,
    );
  });

  it("names the mailbox on account-wide search rows", () => {
    useAppStore.setState({
      settings: { ...defaultSettings, groupThreads: false },
      mailboxes: [
        makeMailbox(),
        makeMailbox({
          id: 4,
          name: "Work/Receipts",
          displayName: "Work/Receipts",
          role: "other",
          delimiter: "/",
          unreadCount: 0,
          totalCount: 1,
        }),
      ],
    });
    const inboxMessage = makeMessage({ subject: "Picnic" });
    const receipt = makeMessage({
      id: 4,
      mailboxId: 4,
      subject: "Invoice",
    });
    const props = {
      messages: [inboxMessage, receipt],
      selectedId: undefined,
      loading: false,
      onChoose: vi.fn(),
      hasMore: false,
      onLoadMore: vi.fn(),
      searchQuery: "picnic",
    };
    const { rerender } = render(<MessageList {...props} />);
    expect(document.querySelector(".message-folder")).toBeNull();
    rerender(<MessageList {...props} showFolders />);
    const inboxRow = screen.getByRole("option", { name: /Picnic/ });
    const receiptRow = screen.getByRole("option", { name: /Invoice/ });
    expect(inboxRow).toHaveAccessibleName(/In Inbox/);
    expect(inboxRow.querySelector(".message-folder")).toHaveTextContent(
      "Inbox",
    );
    expect(receiptRow).toHaveAccessibleName(/In Work \/ Receipts/);
    expect(receiptRow.querySelector(".message-folder")).toHaveTextContent(
      "Work / Receipts",
    );
  });

  it("selects rows, navigates by keyboard, and loads older mail", () => {
    useAppStore.setState({
      settings: { ...defaultSettings, groupThreads: false },
    });
    const onChoose = vi.fn();
    const onToggleSelect = vi.fn();
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <MessageList
        messages={[first, second]}
        selectedId={first.id}
        loading={false}
        loadingMessageId={first.id}
        onChoose={onChoose}
        hasMore
        onLoadMore={onLoadMore}
        selecting={false}
        selectedIds={[]}
        onToggleSelect={onToggleSelect}
      />,
    );
    const rows = screen.getAllByRole("option");
    expect(rows[0]).toHaveTextContent(strings.mail.downloadingMessage);
    expect(rows[1]).toHaveTextContent(strings.mail.openToDownload);
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    fireEvent.keyDown(rows[1], { key: "Home" });
    fireEvent.keyDown(rows[0], { key: "End" });
    fireEvent.keyDown(rows[0], { key: "Escape" });
    expect(onChoose).toHaveBeenCalledWith(second);
    fireEvent.click(
      screen.getByRole("button", { name: strings.mail.loadOlder }),
    );
    expect(onLoadMore).toHaveBeenCalled();

    rerender(
      <MessageList
        messages={[first, second]}
        selectedId={undefined}
        loading
        onChoose={onChoose}
        hasMore
        onLoadMore={onLoadMore}
        selecting
        selectedIds={[first.id]}
        onToggleSelect={onToggleSelect}
      />,
    );
    const selectingRows = screen.getAllByRole("option");
    fireEvent.click(selectingRows[1]);
    fireEvent.keyDown(selectingRows[0], { key: "ArrowDown" });
    expect(onToggleSelect).toHaveBeenCalledWith(second.id);
    expect(
      screen.getByRole("button", { name: strings.mail.loadingOlder }),
    ).toBeDisabled();
  });

  it("expands and collapses grouped conversations as a tree", () => {
    const threaded = [first, second].map((message) => ({
      ...message,
      subject: "Thread",
      threadRoot: "<thread@example.test>",
    }));
    const onChoose = vi.fn();
    render(
      <MessageList
        messages={threaded}
        selectedId={undefined}
        loading={false}
        onChoose={onChoose}
        hasMore={false}
        onLoadMore={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("tree", { name: strings.mail.messages }),
    ).toBeVisible();
    const header = screen.getByRole("treeitem", { name: /Conversation/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(header).toHaveAttribute("tabindex", "0");
    fireEvent.click(header);
    const expandedItems = screen.getAllByRole("treeitem");
    expect(expandedItems).toHaveLength(3);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(header.getAttribute("aria-owns")).toBe(
      document.querySelector(".thread-children")?.id,
    );
    fireEvent.keyDown(header, { key: "ArrowDown" });
    expect(expandedItems[1]).toHaveFocus();
    expect(onChoose).toHaveBeenLastCalledWith(threaded[1]);
    fireEvent.keyDown(expandedItems[1], { key: "Home" });
    expect(header).toHaveFocus();
    fireEvent.click(header);
    expect(screen.getAllByRole("treeitem")).toEqual([header]);
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  it("expands every conversation and keeps the open one open", () => {
    const threaded = [first, second].map((message) => ({
      ...message,
      subject: "Thread",
      threadRoot: "<thread@example.test>",
    }));
    const other = [
      makeMessage({
        id: 3,
        subject: "Other thread",
        threadRoot: "<other@example.test>",
        receivedAt: "2026-08-10T12:00:00Z",
      }),
      makeMessage({
        id: 4,
        subject: "Other reply",
        threadRoot: "<other@example.test>",
        receivedAt: "2026-08-09T12:00:00Z",
      }),
    ];
    const { rerender } = render(
      <MessageList
        messages={[...threaded, ...other]}
        selectedId={undefined}
        loading={false}
        onChoose={vi.fn()}
        hasMore={false}
        onLoadMore={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("treeitem")).toHaveLength(2);
    fireEvent(window, new Event("postal:expand-conversations"));
    expect(screen.getAllByRole("treeitem")).toHaveLength(6);
    fireEvent(window, new Event("postal:collapse-conversations"));
    expect(screen.getAllByRole("treeitem")).toHaveLength(2);

    rerender(
      <MessageList
        messages={[...threaded, ...other]}
        selectedId={second.id}
        loading={false}
        onChoose={vi.fn()}
        hasMore={false}
        onLoadMore={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("treeitem").length).toBeGreaterThan(2);
    fireEvent(window, new Event("postal:collapse-conversations"));
    expect(
      screen
        .getByRole("treeitem", { name: /Other thread/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen
        .getAllByRole("treeitem", { name: /Conversation/ })
        .some((item) => item.getAttribute("aria-expanded") === "true"),
    ).toBe(true);
  });

  it("exposes tree levels and supports arrow expand and collapse", () => {
    const threaded = [first, second].map((message) => ({
      ...message,
      subject: "Thread",
      threadRoot: "<thread@example.test>",
    }));
    const onChoose = vi.fn();
    render(
      <MessageList
        messages={threaded}
        selectedId={undefined}
        loading={false}
        onChoose={onChoose}
        hasMore={false}
        onLoadMore={vi.fn()}
      />,
    );
    const header = screen.getByRole("treeitem", { name: /Conversation/ });
    expect(header).toHaveAttribute("aria-level", "1");

    fireEvent.keyDown(header, { key: "ArrowRight" });
    expect(header).toHaveAttribute("aria-expanded", "true");
    const children = screen
      .getAllByRole("treeitem")
      .filter((item) => item.dataset.optionKey?.startsWith("message:"));
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child).toHaveAttribute("aria-level", "2");
    }

    fireEvent.keyDown(header, { key: "ArrowRight" });
    expect(children[0]).toHaveFocus();
    fireEvent.keyDown(children[0], { key: "ArrowLeft" });
    expect(header).toHaveFocus();
    fireEvent.keyDown(header, { key: "ArrowLeft" });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("keeps thread selection visuals aligned with aria-selected", () => {
    const threaded = [first, second].map((message) => ({
      ...message,
      threadRoot: "<thread@example.test>",
    }));
    const props = {
      messages: threaded,
      loading: false,
      onChoose: vi.fn(),
      hasMore: false,
      onLoadMore: vi.fn(),
    };
    const { rerender } = render(
      <MessageList {...props} selectedId={second.id} />,
    );
    const header = screen.getByRole("treeitem", { name: /Conversation/ });
    const newestChild = screen
      .getAllByRole("treeitem")
      .find((item) => item.dataset.optionKey === `message:${second.id}`);
    expect(header).toHaveAttribute("aria-selected", "true");
    expect(header).toHaveClass("selected");
    expect(newestChild).toHaveAttribute("aria-selected", "false");
    expect(newestChild).not.toHaveClass("selected");

    rerender(<MessageList {...props} selectedId={first.id} />);
    const olderChild = screen
      .getAllByRole("treeitem")
      .find((item) => item.dataset.optionKey === `message:${first.id}`);
    expect(olderChild).toHaveAttribute("aria-selected", "true");
    expect(olderChild).toHaveClass("selected");
    expect(header).not.toHaveClass("selected");
  });

  it("groups a date-ordered list under day headings and leaves search ungrouped", () => {
    useAppStore.setState({
      settings: { ...defaultSettings, groupThreads: false },
    });
    const atHour = (dayOffset: number, hour: number) => {
      const date = new Date();
      date.setDate(date.getDate() + dayOffset);
      date.setHours(hour, 0, 0, 0);
      return date.toISOString();
    };
    const morning = makeMessage({
      id: 1,
      receivedAt: atHour(0, 9),
      subject: "Morning note",
    });
    const earlier = makeMessage({
      id: 2,
      receivedAt: atHour(0, 8),
      subject: "Earlier today",
    });
    const previous = makeMessage({
      id: 3,
      receivedAt: atHour(-1, 18),
      subject: "Yesterday note",
    });
    const olderAt = atHour(-20, 12);
    const older = makeMessage({
      id: 4,
      receivedAt: olderAt,
      subject: "Older note",
    });
    const props = {
      selectedId: undefined,
      loading: false,
      onChoose: vi.fn(),
      hasMore: false,
      onLoadMore: vi.fn(),
    };
    const { rerender } = render(
      <MessageList {...props} messages={[morning, earlier, previous, older]} />,
    );
    const today = screen.getByRole("group", { name: strings.mail.today });
    expect(today).toHaveTextContent("Morning note");
    expect(today).toHaveTextContent("Earlier today");
    expect(today).not.toHaveTextContent("Yesterday note");
    expect(
      screen.getByRole("group", { name: strings.mail.yesterday }),
    ).toHaveTextContent("Yesterday note");
    expect(
      screen.getByRole("group", { name: messageListDay(olderAt) }),
    ).toHaveTextContent("Older note");
    expect(screen.getAllByRole("option")).toHaveLength(4);

    rerender(
      <MessageList
        {...props}
        messages={[morning, previous]}
        searchQuery="note"
      />,
    );
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("offers new messages when mail arrives below the top of the list", () => {
    useAppStore.setState({
      settings: { ...defaultSettings, groupThreads: false },
    });
    const older = makeMessage({
      id: 1,
      receivedAt: "2026-08-17T12:00:00Z",
      subject: "Older note",
    });
    const newer = makeMessage({
      id: 2,
      receivedAt: "2026-08-18T12:00:00Z",
      subject: "Just arrived",
    });
    const props = {
      selectedId: undefined,
      loading: false,
      onChoose: vi.fn(),
      hasMore: false,
      onLoadMore: vi.fn(),
    };
    const { rerender } = render(<MessageList {...props} messages={[older]} />);
    const list = document.querySelector(".message-list") as HTMLElement;
    let scrollTop = 200;
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    rerender(<MessageList {...props} messages={[newer, older]} />);
    fireEvent.click(
      screen.getByRole("button", { name: strings.mail.newMessages }),
    );
    expect(scrollTop).toBe(0);
    expect(
      screen.queryByRole("button", { name: strings.mail.newMessages }),
    ).not.toBeInTheDocument();
  });

  it("stays quiet when older mail or a different folder arrives", () => {
    useAppStore.setState({
      settings: { ...defaultSettings, groupThreads: false },
    });
    const current = makeMessage({
      id: 1,
      receivedAt: "2026-08-18T12:00:00Z",
      subject: "Current note",
    });
    const olderPage = makeMessage({
      id: 2,
      receivedAt: "2026-08-01T12:00:00Z",
      subject: "Earlier page",
    });
    const props = {
      selectedId: undefined,
      loading: false,
      onChoose: vi.fn(),
      hasMore: false,
      onLoadMore: vi.fn(),
    };
    const { rerender } = render(
      <MessageList {...props} messages={[current]} />,
    );
    const list = document.querySelector(".message-list") as HTMLElement;
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      get: () => 200,
      set: () => undefined,
    });
    rerender(<MessageList {...props} messages={[current, olderPage]} />);
    expect(
      screen.queryByRole("button", { name: strings.mail.newMessages }),
    ).not.toBeInTheDocument();
    rerender(
      <MessageList
        {...props}
        messages={[
          makeMessage({
            id: 9,
            receivedAt: "2026-08-19T12:00:00Z",
            subject: "Other folder",
          }),
        ]}
      />,
    );
    expect(
      screen.queryByRole("button", { name: strings.mail.newMessages }),
    ).not.toBeInTheDocument();
  });

  it("marks search words in the sender, subject, and preview", () => {
    useAppStore.setState({
      settings: {
        ...defaultSettings,
        groupThreads: false,
        showMessagePreviews: true,
      },
    });
    render(
      <MessageList
        messages={[
          makeMessage({
            senderName: "Jane",
            subject: "Weekend plans",
            preview: "Saturday picnic",
          }),
        ]}
        selectedId={undefined}
        loading={false}
        onChoose={vi.fn()}
        hasMore={false}
        onLoadMore={vi.fn()}
        searchQuery='picnic subject:"weekend plans" from:jane is:unread'
      />,
    );
    const row = screen.getByRole("option", { name: /Weekend plans/i });
    expect(row.querySelector(".message-subject mark")).toHaveTextContent(
      "Weekend plans",
    );
    expect(row.querySelector(".message-sender mark")).toHaveTextContent("Jane");
    expect(row.querySelector(".message-preview mark")).toHaveTextContent(
      "picnic",
    );
    expect(row.querySelector("mark")?.textContent).not.toMatch(/unread/i);
  });

  it("selects the loaded messages under a day heading", () => {
    useAppStore.setState({
      settings: { ...defaultSettings, groupThreads: false },
    });
    const atHour = (dayOffset: number, hour: number) => {
      const date = new Date();
      date.setDate(date.getDate() + dayOffset);
      date.setHours(hour, 0, 0, 0);
      return date.toISOString();
    };
    const morning = makeMessage({
      id: 1,
      receivedAt: atHour(0, 9),
      subject: "Morning note",
    });
    const earlier = makeMessage({
      id: 2,
      receivedAt: atHour(0, 8),
      subject: "Earlier today",
    });
    const previous = makeMessage({
      id: 3,
      receivedAt: atHour(-1, 18),
      subject: "Yesterday note",
    });
    const onSelectDay = vi.fn();
    render(
      <MessageList
        messages={[morning, earlier, previous]}
        loading={false}
        onChoose={vi.fn()}
        hasMore={false}
        onLoadMore={vi.fn()}
        onSelectDay={onSelectDay}
      />,
    );
    const today = [
      ...document.querySelectorAll<HTMLButtonElement>("button.list-day"),
    ].find(
      (button) =>
        button.getAttribute("aria-label") ===
        `${strings.mail.selectDay(strings.mail.today)}, ${strings.mail.threadMessages(2)}`,
    )!;
    expect(today).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(today);
    expect(onSelectDay).toHaveBeenCalledWith([morning.id, earlier.id]);
  });
});

describe("mailbox find", () => {
  const inbox = makeMailbox({ id: 1, name: "INBOX", displayName: "INBOX" });
  const projects = makeMailbox({
    id: 4,
    name: "Projects",
    displayName: "Projects",
    role: "other",
  });
  const launch = makeMailbox({
    id: 5,
    name: "Projects/Launch",
    displayName: "Projects/Launch",
    role: "other",
    delimiter: "/",
  });

  it("keeps a matching folder and the parents above it", () => {
    const boxes = [inbox, projects, launch];
    expect(mailboxesMatchingQuery(boxes, "   ").map((box) => box.id)).toEqual([
      1, 4, 5,
    ]);
    expect(
      mailboxesMatchingQuery(boxes, "launch").map((box) => box.id),
    ).toEqual([4, 5]);
    expect(mailboxesMatchingQuery(boxes, "zzzz")).toEqual([]);
  });
});

describe("next unread mailbox", () => {
  const inbox = makeMailbox({ id: 1, unreadCount: 1 });
  const archive = makeMailbox({
    id: 2,
    name: "Archive",
    role: "archive",
    unreadCount: 0,
  });
  const nested = makeMailbox({
    id: 4,
    name: "Projects",
    role: "other",
    unreadCount: 0,
  });
  const child = makeMailbox({
    id: 5,
    name: "Projects/Receipts",
    displayName: "Projects/Receipts",
    role: "other",
    unreadCount: 4,
    delimiter: "/",
  });

  it("keeps inbox, the open folder, unread folders, and their parents", () => {
    const boxes = [inbox, archive, nested, child];
    expect(
      mailboxesForUnreadView(boxes, false, inbox.id).map((box) => box.id),
    ).toEqual([1, 2, 4, 5]);
    expect(
      mailboxesForUnreadView(boxes, true, undefined).map((box) => box.id),
    ).toEqual([1, 4, 5]);
    expect(
      mailboxesForUnreadView(boxes, true, archive.id).map((box) => box.id),
    ).toEqual([1, 2, 4, 5]);
  });

  it("skips empty mailboxes and wraps to a parent before its child", () => {
    const boxes = [inbox, archive, nested, child];
    expect(nextUnreadMailbox(boxes, inbox.id)?.id).toBe(child.id);
    expect(nextUnreadMailbox(boxes, child.id)?.id).toBe(inbox.id);
    expect(previousUnreadMailbox(boxes, child.id)?.id).toBe(inbox.id);
    expect(previousUnreadMailbox(boxes, inbox.id)?.id).toBe(child.id);
    expect(nextUnreadMailbox([inbox], inbox.id)).toBeUndefined();
    expect(previousUnreadMailbox([inbox], inbox.id)).toBeUndefined();
    const sent = makeMailbox({
      id: 7,
      name: "Personal/Sent",
      displayName: "Personal/Sent",
      role: "sent",
      delimiter: "/",
    });
    const sentParent = makeMailbox({
      id: 6,
      name: "Personal",
      role: "other",
    });
    expect(mailboxByRole([sentParent, sent, inbox], "sent")?.id).toBe(sent.id);
    expect(mailboxByRole([inbox], "sent")).toBeUndefined();
  });
});

describe("folder path names", () => {
  it("names a nested folder by the folders above it", () => {
    render(
      <FolderButton
        icon={Inbox}
        label="2026"
        pathLabel="Projects / 2026"
        count={1}
        active={false}
        onClick={() => undefined}
      />,
    );
    const folder = screen.getByRole("button", {
      name: "Projects / 2026, 1 unread",
    });
    expect(folder).toHaveAttribute("title", "Projects / 2026");
    expect(folder).toHaveTextContent("2026");
  });

  it("keeps a top-level folder name when the path is the same", () => {
    render(
      <FolderButton
        icon={Inbox}
        label="Projects"
        pathLabel="Projects"
        count={0}
        active={false}
        onClick={() => undefined}
      />,
    );
    const folder = screen.getByRole("button", { name: "Projects" });
    expect(folder).not.toHaveAttribute("title");
  });
});
