import { rememberedFilter, type MessageListFilter } from "./listFilter";
import { rememberedSort, type MessageListSort } from "./listSort";
import type { MailboxView } from "./types";

const VIEW_LIMIT = 40;

/** The list saved for this folder, or the account-wide choice when none is stored. */
export function mailboxListView(
  views: MailboxView[] | undefined,
  accountId: string | undefined,
  mailboxId: number | undefined,
  fallbackSort: string | undefined,
  fallbackFilter: string | undefined,
): { sort: MessageListSort; filter: MessageListFilter } {
  const saved = views?.find(
    (view) => view.accountId === accountId && view.mailboxId === mailboxId,
  );
  return {
    sort: rememberedSort(saved?.sort ?? fallbackSort),
    filter: rememberedFilter(saved?.filter ?? fallbackFilter),
  };
}

/** Store this folder's list and keep the newest 40 folders. */
export function rememberMailboxView(
  views: MailboxView[] | undefined,
  accountId: string,
  mailboxId: number,
  sort: MessageListSort,
  filter: MessageListFilter,
): MailboxView[] {
  const next = (views ?? []).filter(
    (view) => !(view.accountId === accountId && view.mailboxId === mailboxId),
  );
  next.push({ accountId, mailboxId, sort, filter });
  return next.slice(-VIEW_LIMIT);
}
