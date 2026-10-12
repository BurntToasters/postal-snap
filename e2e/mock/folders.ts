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
        const leaf = String(args.name);
        const parent =
          args.parentMailboxId == null
            ? undefined
            : mailboxes.find(
                (entry) => entry.id === Number(args.parentMailboxId),
              );
        const delimiter = parent?.delimiter || "/";
        const name = parent ? `${parent.name}${delimiter}${leaf}` : leaf;
        const id = Math.max(...mailboxes.map((mailbox) => mailbox.id)) + 1;
        mailboxes.push({
          id,
          accountId: mock.account.id,
          name,
          displayName: name,
          role: "other",
          unreadCount: 0,
          totalCount: 0,
          delimiter: parent ? delimiter : "/",
        });
        return undefined;
      },
      move_folder(args: Record<string, unknown>) {
        const mailbox = mailboxes.find(
          (entry) => entry.id === Number(args.mailboxId),
        );
        if (!mailbox) return undefined;
        const delimiter = mailbox.delimiter || "/";
        const splitAt = mailbox.name.lastIndexOf(delimiter);
        const leaf =
          delimiter && splitAt > 0
            ? mailbox.name.slice(splitAt + delimiter.length)
            : mailbox.name;
        const parent =
          args.parentMailboxId == null
            ? undefined
            : mailboxes.find(
                (entry) => entry.id === Number(args.parentMailboxId),
              );
        const next = parent
          ? `${parent.name}${parent.delimiter || delimiter}${leaf}`
          : leaf;
        const prefix = `${mailbox.name}${delimiter}`;
        for (const child of mailboxes) {
          if (child.id === mailbox.id || !child.name.startsWith(prefix))
            continue;
          const renamed = `${next}${delimiter}${child.name.slice(prefix.length)}`;
          child.name = renamed;
          child.displayName = renamed;
        }
        mailbox.name = next;
        mailbox.displayName = next;
        return undefined;
      },
      rename_folder(args: Record<string, unknown>) {
        const mailbox = mailboxes.find(
          (entry) => entry.id === Number(args.mailboxId),
        );
        if (!mailbox) return undefined;
        const leaf = String(args.name);
        const delimiter = mailbox.delimiter ?? "";
        const nested =
          delimiter.length > 0 && mailbox.name.includes(delimiter)
            ? mailbox.name.lastIndexOf(delimiter)
            : -1;
        const next =
          nested > 0
            ? `${mailbox.name.slice(0, nested)}${delimiter}${leaf}`
            : leaf;
        const prefix = `${mailbox.name}${delimiter}`;
        if (delimiter && nested > 0) {
          for (const child of mailboxes) {
            if (!child.name.startsWith(prefix)) continue;
            const renamed = `${next}${delimiter}${child.name.slice(prefix.length)}`;
            child.name = renamed;
            child.displayName = renamed;
          }
        }
        mailbox.name = next;
        mailbox.displayName = next;
        return undefined;
      },
      delete_folder(args: Record<string, unknown>) {
        const index = mailboxes.findIndex(
          (entry) => entry.id === Number(args.mailboxId),
        );
        if (index >= 0) mailboxes.splice(index, 1);
        return undefined;
      },
      delete_trash_messages() {
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
