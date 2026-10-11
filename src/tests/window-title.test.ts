import { describe, expect, it } from "vitest";
import { mailboxWindowTitle, unreadBadgeCount } from "../windowTitle";

describe("mailbox window title", () => {
  it("names Postal Snap when Inbox has no unread mail", () => {
    expect(mailboxWindowTitle({ unread: 0, severalAccounts: false })).toBe(
      "Postal Snap",
    );
    expect(
      mailboxWindowTitle({
        unread: 0,
        accountLabel: "Sam",
        severalAccounts: true,
      }),
    ).toBe("Postal Snap");
  });

  it("counts the active Inbox and names the account when several are open", () => {
    expect(mailboxWindowTitle({ unread: 4, severalAccounts: false })).toBe(
      "Inbox (4) — Postal Snap",
    );
    expect(
      mailboxWindowTitle({
        unread: 1,
        accountLabel: " Sam ",
        severalAccounts: true,
      }),
    ).toBe("Sam (1) — Postal Snap");
    expect(
      mailboxWindowTitle({
        unread: 3,
        accountLabel: "   ",
        severalAccounts: true,
      }),
    ).toBe("Inbox (3) — Postal Snap");
  });

  it("clears a badge at zero and stops a huge count at 9999", () => {
    expect(unreadBadgeCount(0)).toBeNull();
    expect(unreadBadgeCount(4.8)).toBe(4);
    expect(unreadBadgeCount(20_000)).toBe(9999);
  });
});
