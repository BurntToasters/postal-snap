import { describe, expect, it } from "vitest";
import { groupThreads, threadKey } from "../threads";
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

  it("falls back to unique keys without roots", () => {
    const groups = groupThreads([summary({ id: 1 }), summary({ id: 2 })]);
    expect(groups).toHaveLength(2);
    expect(threadKey(summary({ id: 1 }))).not.toBe(
      threadKey(summary({ id: 2 })),
    );
  });
});
