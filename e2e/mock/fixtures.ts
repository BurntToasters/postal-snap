import type { Page } from "@playwright/test";
import type { MockShared } from "./context";

// Installs the shared account/mailbox/message fixtures on
// window.__POSTAL_SNAP_MOCK__. Must run before the other mock installers.
// The init script below is stringified into the page, so keep it
// self-contained: type-only imports, locals, and browser globals only.
export async function registerMockFixtures(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const params = new URLSearchParams(location.search);
    const account = {
      id: "account-1",
      provider: "icloud",
      email: "sam@icloud.com",
      displayName: "Sam",
      syncState: params.has("offline") ? "offline" : "idle",
      error: location.search.includes("authError")
        ? "Sign-in failed. Update the account password in Settings > Accounts."
        : null,
      color: "blue",
      aliases: params.has("aliasCollision") ? ["alias@example.test"] : [],
    };
    const secondAccount = {
      id: "account-2",
      provider: "manual",
      email: "reader@fastmail.com",
      displayName: "Work",
      syncState: params.has("secondOffline") ? "offline" : "idle",
      error: null,
      color: "green",
    };
    const mailboxes = [
      {
        id: 1,
        accountId: account.id,
        name: "INBOX",
        displayName: "INBOX",
        role: "inbox",
        unreadCount: 1,
        totalCount: 1,
        delimiter: "/",
      },
      {
        id: 2,
        accountId: account.id,
        name: "Archive",
        displayName: "Archive",
        role: "archive",
        unreadCount: 0,
        totalCount: 0,
        delimiter: "/",
      },
      {
        id: 3,
        accountId: account.id,
        name: "Deleted Messages",
        displayName: "Deleted Messages",
        role: "trash",
        unreadCount: 0,
        totalCount: 2,
        delimiter: "/",
      },
      {
        id: 21,
        accountId: secondAccount.id,
        name: "INBOX",
        displayName: "Inbox",
        role: "inbox",
        unreadCount: 3,
        totalCount: 7,
        delimiter: "/",
      },
      {
        id: 22,
        accountId: secondAccount.id,
        name: "Archive",
        displayName: "Archive",
        role: "archive",
        unreadCount: 0,
        totalCount: 2,
        delimiter: "/",
      },
    ];
    if (params.has("nestedFolders")) {
      mailboxes.push(
        {
          id: 4,
          accountId: account.id,
          name: "Projects",
          displayName: "Projects",
          role: "other",
          unreadCount: 0,
          totalCount: 0,
          delimiter: "/",
        },
        {
          id: 5,
          accountId: account.id,
          name: "Projects/2026",
          displayName: "Projects/2026",
          role: "other",
          unreadCount: 1,
          totalCount: 1,
          delimiter: "/",
        },
        {
          id: 6,
          accountId: account.id,
          name: "Projects/2026/Launch",
          displayName: "Projects/2026/Launch",
          role: "other",
          unreadCount: 1,
          totalCount: 1,
          delimiter: "/",
        },
      );
    }
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
    if (params.has("aliasCollision")) {
      summary.recipients = "notalias@example.test";
    }
    const olderSummary = {
      ...summary,
      id: 9,
      uid: 43,
      messageId: "<older@example.com>",
      subject: "Older family note",
      receivedAt: "2026-08-17T12:00:00Z",
    };
    const secondSummary = {
      ...summary,
      id: 20,
      accountId: secondAccount.id,
      mailboxId: 21,
      uid: 144,
      messageId: "<launch@fastmail.com>",
      subject: "Team launch",
      senderName: "Morgan",
      senderAddress: "morgan@fastmail.com",
      recipients: "reader@fastmail.com",
      receivedAt: "2026-08-19T12:00:00Z",
      preview: "The release candidate is ready.",
    };
    if (location.search.includes("threaded")) {
      summary.threadRoot = "<weekend@example.com>";
      olderSummary.threadRoot = "<weekend@example.com>";
    }
    const shared: MockShared = {
      account,
      accounts: [account, secondAccount],
      mailboxes,
      summary,
      olderSummary,
      secondSummary,
      params,
      handlers: {},
    };
    Object.defineProperty(window, "__POSTAL_SNAP_MOCK__", { value: shared });
  });
}
