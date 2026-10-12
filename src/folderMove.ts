import { folderPathLabel } from "./i18n/mail";
import { strings } from "./i18n";
import type { MailboxSummary } from "./types";

export interface FolderMoveDestination {
  parentId: number | null;
  label: string;
}

/** Places a personal folder can move. Skips itself, its children, and its current parent. */
export function folderMoveDestinations(
  mailbox: MailboxSummary,
  mailboxes: MailboxSummary[],
): FolderMoveDestination[] {
  if (mailbox.role !== "other") return [];
  const delimiter = mailbox.delimiter ?? "";
  const parentName =
    delimiter && mailbox.name.includes(delimiter)
      ? mailbox.name.slice(0, mailbox.name.lastIndexOf(delimiter))
      : "";
  const destinations: FolderMoveDestination[] = [];
  if (parentName) {
    destinations.push({ parentId: null, label: strings.mail.topLevel });
  }
  for (const candidate of mailboxes) {
    if (
      candidate.accountId !== mailbox.accountId ||
      candidate.id === mailbox.id
    )
      continue;
    if (!candidate.delimiter) continue;
    if (
      delimiter &&
      (candidate.name === mailbox.name ||
        candidate.name.startsWith(`${mailbox.name}${delimiter}`))
    ) {
      continue;
    }
    if (candidate.name === parentName) continue;
    destinations.push({
      parentId: candidate.id,
      label: folderPathLabel(candidate),
    });
  }
  return destinations;
}
