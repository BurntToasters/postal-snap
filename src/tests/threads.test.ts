import { describe, expect, it } from "vitest";
import {
  adjacentMessage,
  conversationIndex,
  conversationMessages,
  conversationNeighbor,
  conversationRead,
  conversationUnread,
  conversationUnreadTarget,
  groupThreads,
  messageAfterRemoval,
  messageAfterRemovals,
  threadKey,
  unreadStep,
} from "../threads";
import type { MessageSummary } from "../types";

function summary(
  overrides: Partial<MessageSummary> & { id: number },
): MessageSummary {
  return {
    accountId: "account-1",
    mailboxId: 1,
    uid: overrides.id,
    messageId: `<${overrides.id}@example.test>`,
    subject: `Subject ${overrides.id}`,
    senderName: "Jane",
    senderAddress: "jane@example.test",
    recipients: "sam@example.test",
    receivedAt: "2026-08-18T12:00:00Z",
    preview: "",
    isRead: true,
    isStarred: false,
    hasAttachments: false,
    size: 100,
    ...overrides,
  };
}

describe("thread grouping", () => {
  it("steps to the older or newer loaded message in a conversation", () => {
    const newer = summary({
      id: 2,
      threadRoot: "<root@example.test>",
      receivedAt: "2026-08-18T12:00:00Z",
    });
    const older = summary({
      id: 1,
      threadRoot: "<root@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
    });
    const other = summary({ id: 3 });
    expect(conversationNeighbor([newer, older, other], newer, 1)?.id).toBe(1);
    expect(
      conversationNeighbor([newer, older, other], newer, -1),
    ).toBeUndefined();
    expect(conversationNeighbor([newer, older, other], older, -1)?.id).toBe(2);
    expect(
      conversationIndex([older, newer, other], older).map((item) => item.id),
    ).toEqual([2, 1]);
    expect(conversationIndex([other], other)).toEqual([]);
    expect(
      conversationNeighbor([newer, older, other], other, 1),
    ).toBeUndefined();
  });

  it("opens another unread message in the conversation", () => {
    const newer = summary({
      id: 2,
      threadRoot: "<root@example.test>",
      receivedAt: "2026-08-18T12:00:00Z",
      isRead: true,
    });
    const older = summary({
      id: 1,
      threadRoot: "<root@example.test>",
      receivedAt: "2026-08-17T12:00:00Z",
      isRead: false,
    });
    const oldest = summary({
      id: 4,
      threadRoot: "<root@example.test>",
      receivedAt: "2026-08-16T12:00:00Z",
      isRead: false,
    });
    expect(conversationUnreadTarget([newer, older], newer)?.id).toBe(1);
    expect(conversationUnreadTarget([newer, older, oldest], older)?.id).toBe(4);
    expect(conversationUnreadTarget([newer, older], older)?.id).toBeUndefined();
    expect(
      conversationUnreadTarget([newer, { ...older, isRead: true }], newer),
    ).toBeUndefined();
  });

  it("groups shared roots newest-first and isolates singletons", () => {
    const groups = groupThreads([
      summary({ id: 1, threadRoot: "<root@example.test>" }),
      summary({ id: 2 }),
      summary({
        id: 3,
        threadRoot: "<root@example.test>",
        receivedAt: "2026-08-19T12:00:00Z",
        isRead: false,
      }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe("<root@example.test>");
    expect(groups[0].items.map((item) => item.id)).toEqual([3, 1]);
    expect(groups[0].unread).toBe(1);
    expect(groups[1].items.map((item) => item.id)).toEqual([2]);
  });

  it("lists a pinned conversation ahead of newer mail", () => {
    const groups = groupThreads([
      summary({ id: 1, subject: "Newer", receivedAt: "2026-08-19T12:00:00Z" }),
      summary({
        id: 2,
        subject: "Older",
        receivedAt: "2026-08-17T12:00:00Z",
        pinned: true,
      }),
    ]);
    expect(groups.map((group) => group.newest.id)).toEqual([2, 1]);
  });

  it("lists unread messages only when a conversation has more than one", () => {
    const root = "<root@example.test>";
    const unread = summary({ id: 1, threadRoot: root, isRead: false });
    const read = summary({
      id: 2,
      threadRoot: root,
      isRead: true,
      mailboxId: 1,
    });
    const otherBox = summary({
      id: 3,
      threadRoot: root,
      isRead: false,
      mailboxId: 9,
    });
    expect(
      conversationUnread([unread, read, otherBox], unread).map(
        (item) => item.id,
      ),
    ).toEqual([1]);
    expect(conversationUnread([unread], unread)).toEqual([]);
    expect(
      conversationRead([unread, read, otherBox], unread).map((item) => item.id),
    ).toEqual([2]);
    expect(conversationRead([read], read)).toEqual([]);
    expect(
      conversationMessages([unread, read, otherBox], unread).map(
        (item) => item.id,
      ),
    ).toEqual([1, 2]);
    expect(conversationMessages([unread], unread)).toEqual([]);
    expect(
      conversationUnread(
        [summary({ id: 4, isRead: false })],
        summary({ id: 4, isRead: false }),
      ),
    ).toEqual([]);
  });

  it("steps to the next unread and wraps inside the loaded list", () => {
    const read = summary({ id: 1, isRead: true });
    const firstUnread = summary({ id: 2, isRead: false });
    const secondUnread = summary({ id: 3, isRead: false });
    const items = [read, firstUnread, secondUnread];
    expect(unreadStep(items, false, undefined, 1)?.id).toBe(2);
    expect(unreadStep(items, false, 2, 1)?.id).toBe(3);
    expect(unreadStep(items, false, 3, 1)?.id).toBe(2);
    expect(unreadStep(items, false, 2, -1)?.id).toBe(3);
    expect(unreadStep([read], false, 1, 1)).toBeUndefined();
  });

  it("opens the following message, or the previous when the last one leaves", () => {
    const items = [summary({ id: 1 }), summary({ id: 2 }), summary({ id: 3 })];
    expect(messageAfterRemoval(items, false, 2)?.id).toBe(3);
    expect(messageAfterRemoval(items, false, 3)?.id).toBe(2);
    expect(messageAfterRemoval([summary({ id: 1 })], false, 1)).toBeUndefined();
  });

  it("stays on a conversation when older messages remain", () => {
    const root = "<root@example.test>";
    const older = summary({ id: 1, threadRoot: root });
    const newer = summary({
      id: 3,
      threadRoot: root,
      receivedAt: "2026-08-19T12:00:00Z",
    });
    const other = summary({ id: 2 });
    expect(messageAfterRemoval([older, newer, other], true, 3)?.id).toBe(1);
    expect(messageAfterRemoval([older, newer, other], true, 2)?.id).toBe(3);
    const removed = new Set([1, 3]);
    expect(
      messageAfterRemovals([older, newer, other], true, removed, 3)?.id,
    ).toBe(2);
    expect(
      messageAfterRemovals([older, newer], true, removed, 3),
    ).toBeUndefined();
    expect(
      messageAfterRemovals([older, newer, other], true, removed, 2),
    ).toBeUndefined();
  });

  it("steps to the neighbor in list order and stops at the ends", () => {
    const older = summary({ id: 1, receivedAt: "2026-08-17T12:00:00Z" });
    const newer = summary({ id: 2, receivedAt: "2026-08-18T12:00:00Z" });
    const items = [older, newer];
    expect(adjacentMessage(items, true, newer.id, 1)?.id).toBe(older.id);
    expect(adjacentMessage(items, true, newer.id, -1)).toBeUndefined();
    expect(adjacentMessage(items, true, older.id, -1)?.id).toBe(newer.id);
    expect(adjacentMessage(items, true, older.id, 1)).toBeUndefined();
    expect(adjacentMessage(items, false, older.id, 1)?.id).toBe(newer.id);
    expect(adjacentMessage([], false, 1, 1)).toBeUndefined();
  });

  it("falls back to unique keys without roots", () => {
    const groups = groupThreads([summary({ id: 1 }), summary({ id: 2 })]);
    expect(groups).toHaveLength(2);
    expect(threadKey(summary({ id: 1 }))).not.toBe(
      threadKey(summary({ id: 2 })),
    );
  });
});
