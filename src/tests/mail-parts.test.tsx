import { fireEvent, render, screen } from "@testing-library/react";
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
import { MessageList } from "../components/mail/messageList";
import { strings } from "../i18n";
import { defaultSettings, useAppStore } from "../store";
import type { DraftSummary, OutboxSummary } from "../types";
import { makeMessage } from "./helpers/fixtures";
import { resetStore } from "./helpers/store";

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("local mailbox lists", () => {
  it("renders empty local-list states", () => {
    const { rerender } = render(
      <SnoozedList items={[]} onOpen={vi.fn()} onUnsnooze={vi.fn()} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      strings.mail.noSnoozed,
    );
    rerender(<DraftList drafts={[]} onOpen={vi.fn()} />);
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
        name: `${strings.mail.unsnooze}: ${strings.common.noSubject}`,
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
    render(<DraftList drafts={drafts} onOpen={onOpen} />);
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
    vi.advanceTimersByTime(15_000);
    expect(useAppStore.getState().lastSent).toBeUndefined();
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

  it("expands and collapses grouped conversations", () => {
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
    const header = screen.getByRole("button", { name: /Conversation/ });
    fireEvent.click(header);
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.click(header);
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(onChoose).toHaveBeenCalledTimes(2);
  });
});
