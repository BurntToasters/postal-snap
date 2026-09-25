import type { MailboxRole, MailboxSummary } from "../types";

export const roleLabels: Record<MailboxRole, string> = {
  inbox: "Inbox",
  sent: "Sent",
  drafts: "Drafts",
  archive: "Archive",
  trash: "Trash",
  junk: "Junk",
  other: "",
};

/** Localized display label for a mailbox. Role folders get the i18n name;
 *  custom folders get the leaf segment after the last delimiter. */
export function folderLabel(mailbox: MailboxSummary): string {
  const label = roleLabels[mailbox.role];
  if (label) return label;
  const name = mailbox.displayName || mailbox.name;
  if (mailbox.delimiter && name.includes(mailbox.delimiter)) {
    return name.slice(name.lastIndexOf(mailbox.delimiter) + 1);
  }
  return name;
}

// English source catalog namespace: mail section.
// Split from src/i18n.ts with zero text changes.
export const mail = {
  compose: "Compose",
  getMail: "Get Mail",
  search: "Search mail",
  searchMailboxOnly: "Search this list",
  thisMailbox: "This mailbox",
  thisAccount: "This account",
  settings: "Settings",
  noMessage: "Choose a message to read it.",
  emptyMailbox: "No messages here.",
  mail: "Mail",
  drafts: "Drafts",
  outbox: "Outbox",
  account: "Account",
  emailAccounts: "Email accounts",
  accountSettings: "Account settings",
  getMailAllAccounts: "Get mail for all accounts",
  accountReady: "Ready",
  accountSyncing: "Syncing",
  accountOffline: "Offline",
  accountSignInNeeded: "Sign-in needed",
  addAccount: "Add account",
  mailboxes: "Mailboxes",
  accountsAndMailboxes: "Accounts and mailboxes",
  showMailboxes: "Show mailboxes",
  hideMailboxes: "Hide mailboxes",
  closeMailboxes: "Close mailboxes",
  localFolders: "On This Computer",
  checkingMail: "Checking mail…",
  mailUpToDate: "Mail is up to date",
  mailSyncError: "Mail could not sync",
  clearSearch: "Clear search",
  messages: "Messages",
  loadingMessages: "Loading messages…",
  downloadingMessage: "Downloading message…",
  openToDownload: "Open to download message",
  messageTooLarge:
    "This message is too large to download safely. You can still move, archive, or delete it from the list.",
  emptyBody: "This message has no readable text.",
  loadOlder: "Load older mail",
  loadingOlder: "Loading older mail…",
  read: "Read",
  unread: "Unread",
  starred: "Starred",
  hasAttachments: "Has attachments",
  resizeFolders: "Resize mailbox sidebar",
  resizeMessages: "Resize message list",
  resizeReader: "Resize reading pane",
  closeAddAccount: "Close add account",
  addEmailAccount: "Add email account",
  mailboxFallback: "Mailbox",
  noDrafts: "No saved drafts on this device.",
  noQueued: "No queued messages.",
  offlineChangesDropped:
    "Some offline changes could not be applied and were undone.",
  noSnoozed: "Nothing snoozed. Snoozed mail waits here until its time comes.",
  snoozed: "Snoozed",
  unsnooze: "Bring back",
  snoozedUntil: (when: string) => `Snoozed until ${when}`,
  noRecipientYet: "No recipient yet",
  noRecipient: "No recipient",
  savedServer: "Saved here and on mail server",
  recoveredConflict: "Recovered conflict copy",
  savedLocal: "Saved here — server sync pending",
  savingServer: "Saving to mail server…",
  waitingSend: "Waiting to send",
  sending: "Sending",
  sentCopyPending: "Sent — copy pending",
  needsAttention: "Needs attention",
  retrySending: "Retry sending",
  saveSentCopy: "Save Sent copy",
  retryWarning:
    "Retry this message? Delivery may already have happened. Retrying could send a duplicate.",
  scheduledWaiting: "Held before sending",
  sendIn: (seconds: number) =>
    seconds <= 0 ? "Sending…" : `Sending in ${seconds}s`,
  sendNow: "Send now",
  sendingNow: (subject: string) => `Sending "${subject}" now`,
  messageScheduled: "Send scheduled",
  viewOutbox: "View Outbox",
  dismissNotice: "Dismiss",
  undoSend: "Undo",
  undoSendQuestion: "Stop this message before it sends?",
  undoSendWindow: "Undo send window",
  undoSendHelp:
    "Hold sent messages briefly so you can undo. Off sends immediately.",
  undoSendOff: "Off",
  undoSendSeconds: (count: number) =>
    `After ${count} second${count === 1 ? "" : "s"}`,
  discardQueued: "Remove this unsent message from Outbox?",
  dismissSentCopy:
    "Stop trying to save a Sent copy? The message was already sent.",
  dismissWarning: "Dismiss warning",
  yesterday: "Yesterday",
  justNow: "just now",
  minutesAgo: (count: number) => `${count}m ago`,
  hoursAgo: (count: number) => `${count}h ago`,
  daysAgo: (count: number) => `${count}d ago`,
  updateReadyBadge: "Update Ready · Click to Restart",
  updateReadyTooltip: (version: string) =>
    `Version ${version} is downloaded and ready to install. Click to restart.`,
  itemCount: (count: number) => (count === 1 ? "1 item" : `${count} items`),
  partialSearch: (detail: string) =>
    `Server search unavailable. Showing cached results. ${detail}`,
  noSearchResults: (query: string) =>
    `No messages matching "${query}". Check your spelling or try All Folders.`,
  newFolder: "New folder",
  folderName: "Folder name",
  createFolder: "Create folder",
  rename: "Rename",
  deleteFolder: "Delete folder",
  deleteFolderQuestion: (name: string) =>
    `Delete "${name}" and all messages in it? This cannot be undone.`,
  emptyTrash: "Empty trash",
  emptyTrashQuestion:
    "Permanently delete every message in Trash? This cannot be undone.",
  emptyJunk: "Empty junk",
  emptyJunkQuestion:
    "Permanently delete every message in Junk? This cannot be undone.",
  select: "Select",
  doneSelecting: "Done",
  selectedCount: (count: number) =>
    count === 1 ? "1 selected" : `${count} selected`,
  selectMessage: (subject: string) => `Select ${subject}`,
  paneSize: (pixels: number) => `${pixels} pixels`,
  markAllRead: "Mark all read",
  moreMailboxActions: "More mailbox actions",
  conversation: "Conversation",
  threadMessages: (count: number) =>
    count === 1 ? "1 message" : `${count} messages`,
  threadUnread: (count: number) =>
    count === 1 ? "1 unread" : `${count} unread`,
  bulkPartial: (failed: number) =>
    `${failed} message${failed === 1 ? " could" : "s could"} not be updated. The rest succeeded.`,
  bulkTooMany: "Select up to 200 messages at a time.",
  noTargetFolder: "This account does not have that folder.",
} as const;
