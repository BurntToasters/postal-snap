import { describe, expect, it } from "vitest";
import {
  PINNED_MAILBOX_LIMIT,
  hideMailbox,
  mailboxIsPinned,
  pinMailbox,
  unpinMailbox,
} from "../pinnedMailboxes";

describe("pinned mailboxes", () => {
  it("keeps a mailbox at the end and drops it again", () => {
    const first = pinMailbox([], "account-1", 12);
    expect(first).toEqual([{ accountId: "account-1", mailboxId: 12 }]);
    const second = pinMailbox(first, "account-1", 8);
    expect(second?.map((pin) => pin.mailboxId)).toEqual([12, 8]);
    expect(pinMailbox(second, "account-1", 12)).toBeUndefined();
    expect(mailboxIsPinned(second, "account-1", 8)).toBe(true);
    expect(mailboxIsPinned(second, "account-2", 8)).toBe(false);
    expect(unpinMailbox(second, "account-1", 12)).toEqual([
      { accountId: "account-1", mailboxId: 8 },
    ]);
  });

  it("hides a folder and leaves Inbox in the list", () => {
    expect(
      hideMailbox([], "account-1", { id: 1, role: "inbox" }),
    ).toBeUndefined();
    expect(hideMailbox([], "account-1", { id: 2, role: "archive" })).toEqual([
      { accountId: "account-1", mailboxId: 2 },
    ]);
  });

  it("stops at the pin limit", () => {
    const full = Array.from({ length: PINNED_MAILBOX_LIMIT }, (_, index) => ({
      accountId: "account-1",
      mailboxId: index + 1,
    }));
    expect(pinMailbox(full, "account-1", 99)).toBeUndefined();
  });
});
