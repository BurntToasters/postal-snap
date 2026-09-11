import type { Page } from "@playwright/test";
import type { MockShared } from "./context";

// Installs the shared account/mailbox/message fixtures on
// window.__POSTAL_SNAP_MOCK__. Must run before the other mock installers.
// The init script below is stringified into the page, so keep it
// self-contained: type-only imports, locals, and browser globals only.
export async function registerMockFixtures(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const account = {
      id: "account-1",
      provider: "icloud",
      email: "sam@icloud.com",
      displayName: "Sam",
      syncState: "idle",
      error: location.search.includes("authError")
        ? "Sign-in failed. Update the account password in Settings > Accounts."
        : null,
    };
    const mailboxes = [
      {
        id: 1,
        accountId: account.id,
        name: "INBOX",
        displayName: "Inbox",
        role: "inbox",
        unreadCount: 1,
        totalCount: 1,
      },
      {
        id: 2,
        accountId: account.id,
        name: "Archive",
        displayName: "Archive",
        role: "archive",
        unreadCount: 0,
        totalCount: 0,
      },
      {
        id: 3,
        accountId: account.id,
        name: "Deleted Messages",
        displayName: "Deleted Messages",
        role: "trash",
        unreadCount: 0,
        totalCount: 2,
      },
    ];
    const summary = {
      id: 10,
      accountId: account.id,
      mailboxId: 1,
      uid: 44,
      messageId: "<weekend@example.com>",
      subject: "Weekend plans",
      senderName: "Jane",
      senderAddress: "jane@example.com",
      recipients: "sam@icloud.com",
      receivedAt: "2026-08-18T12:00:00Z",
      preview: "Are we still meeting on Saturday?",
      isRead: false,
      isStarred: false,
      hasAttachments: false,
      size: 512,
      threadRoot: null as string | null,
    };
    const olderSummary = {
      ...summary,
      id: 9,
      uid: 43,
      messageId: "<older@example.com>",
      subject: "Older family note",
      receivedAt: "2026-08-17T12:00:00Z",
    };
    if (location.search.includes("threaded")) {
      summary.threadRoot = "<weekend@example.com>";
      olderSummary.threadRoot = "<weekend@example.com>";
    }
    const params = new URLSearchParams(location.search);
    const shared: MockShared = {
      account,
      mailboxes,
      summary,
      olderSummary,
      params,
      handlers: {},
    };
    Object.defineProperty(window, "__POSTAL_SNAP_MOCK__", { value: shared });
  });
}
