import type { Page } from "@playwright/test";
import type { MockShared } from "./context";

// Mailbox listing plus folder create/rename/delete/empty. The init script
// below is stringified into the page, so keep it self-contained: type-only
// imports, locals, and browser globals only.
export async function registerMockFolders(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as MockShared;
    const { mailboxes } = mock;
    Object.assign(mock.handlers, {
      list_mailboxes(args: Record<string, unknown>) {
        return mailboxes.filter(
          (mailbox) => mailbox.accountId === String(args.accountId),
        );
      },
      list_all_mailboxes() {
        return mailboxes.map((mailbox) => ({ ...mailbox }));
      },
      create_folder(args: Record<string, unknown>) {
        const name = String(args.name);
        const id = Math.max(...mailboxes.map((mailbox) => mailbox.id)) + 1;
        mailboxes.push({
          id,
          accountId: mock.account.id,
          name,
          displayName: name,
          role: "other",
          unreadCount: 0,
          totalCount: 0,
        });
        return undefined;
      },
      rename_folder(args: Record<string, unknown>) {
        const mailbox = mailboxes.find(
          (entry) => entry.id === Number(args.mailboxId),
        );
        if (mailbox) {
          mailbox.name = String(args.name);
          mailbox.displayName = String(args.name);
        }
        return undefined;
      },
      delete_folder(args: Record<string, unknown>) {
        const index = mailboxes.findIndex(
          (entry) => entry.id === Number(args.mailboxId),
        );
        if (index >= 0) mailboxes.splice(index, 1);
        return undefined;
      },
      empty_trash() {
        const trash = mailboxes.find((entry) => entry.role === "trash");
        if (trash) {
          trash.totalCount = 0;
          trash.unreadCount = 0;
        }
        return undefined;
      },
      empty_junk() {
        const junk = mailboxes.find((entry) => entry.role === "junk");
        if (junk) {
          junk.totalCount = 0;
          junk.unreadCount = 0;
        }
        return undefined;
      },
    });
  });
}
