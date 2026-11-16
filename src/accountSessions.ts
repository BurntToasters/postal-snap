import { forgetLetterScrolls, letterScrollKeys } from "./letterScroll";
import { forgetListScrollsForAccount, listScrollKeys } from "./listScroll";
import {
  expandedThreadKeys,
  forgetExpandedThreadsForAccount,
} from "./threadExpand";
import { forgetOpenMessagesForAccount, openMessageKeys } from "./recentMessage";

/** Drops remembered scroll, thread and open-message state for one account. */
export function forgetAccountSessions(accountId: string): void {
  forgetListScrollsForAccount(accountId);
  forgetExpandedThreadsForAccount(accountId);
  forgetOpenMessagesForAccount(accountId);
  forgetLetterScrolls();
}

/** Remembered session keys, for DEV probes and tests. */
export function rememberedSessionKeys(): Record<string, string[]> {
  return {
    listScroll: listScrollKeys(),
    threadExpand: expandedThreadKeys(),
    recentMessage: openMessageKeys(),
    letterScroll: letterScrollKeys(),
  };
}
