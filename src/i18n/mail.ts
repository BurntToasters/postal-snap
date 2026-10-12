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

// Flat lists (move menus) need the parent path so "Work/Receipts" and
// "Personal/Receipts" stay distinguishable.
export function folderPathLabel(mailbox: MailboxSummary): string {
  const name = mailbox.displayName || mailbox.name;
  const segments = mailbox.delimiter
    ? name.split(mailbox.delimiter).filter(Boolean)
    : [name];
  const roleLabel = roleLabels[mailbox.role];
  if (roleLabel) {
    return segments.length > 1
      ? [...segments.slice(0, -1), roleLabel].join(" / ")
      : roleLabel;
  }
  return mailbox.delimiter ? segments.join(" / ") : name;
}

/** The folders above this one, when the visible name is only the last part. */
export function folderParentLabel(mailbox: MailboxSummary): string | undefined {
  const path = folderPathLabel(mailbox);
  const label = folderLabel(mailbox);
  const suffix = ` / ${label}`;
  if (path === label || !path.endsWith(suffix)) return undefined;
  return path.slice(0, -suffix.length);
}

// English source catalog namespace: mail section.
// Split from src/i18n.ts with zero text changes.
export const mail = {
  compose: "Compose",
  getMail: "Get Mail",
  search: "Search mail",
  recentSearches: "Recent searches",
  clearRecentSearches: "Clear recent searches",
  forgetRecentSearch: (query: string) =>
    `Remove “${query}” from recent searches`,
  searchMailboxOnly: "Search this list",
  searchTips: "Search tips",
  searchTipsTitle: "Search tips",
  searchTipsIntro:
    "Type words, or add filters. Put quotes around values with spaces.",
  searchTipsClose: "Close search tips",
  searchTipsItems: [
    { syntax: "from:jane", meaning: "Sender name or address" },
    { syntax: "from:me", meaning: "Mail sent from this account" },
    { syntax: "to:sam@example.com", meaning: "Recipient name or address" },
    { syntax: "to:me", meaning: "Mail addressed to this account" },
    { syntax: "cc:lee@example.com", meaning: "Copied on this message" },
    { syntax: "cc:me", meaning: "You are copied on the message" },
    { syntax: 'subject:"trip plans"', meaning: "Words in the subject" },
    { syntax: "body:invoice", meaning: "Words in the message text" },
    { syntax: "has:attachment", meaning: "Has an attachment" },
    { syntax: "filename:plan.pdf", meaning: "Attachment file name" },
    { syntax: "larger:5M", meaning: "Larger than this size" },
    { syntax: "smaller:1M", meaning: "Smaller than this size" },
    { syntax: "is:unread", meaning: "Not read yet (or is:read)" },
    { syntax: "is:flagged", meaning: "Starred messages (or is:starred)" },
    { syntax: "is:muted", meaning: "Muted conversations" },
    { syntax: "is:pinned", meaning: "Pinned on this computer" },
    { syntax: "is:important", meaning: "High importance (or is:low)" },
    { syntax: "is:replied", meaning: "You replied to the message" },
    { syntax: "is:forwarded", meaning: "You forwarded the message" },
    { syntax: "after:2026-08-01", meaning: "On or after this date" },
    { syntax: "before:2026-09-01", meaning: "Before this date" },
    { syntax: "on:2026-08-18", meaning: "On this date" },
    { syntax: "in:inbox", meaning: "In this folder" },
  ],
  thisMailbox: "This mailbox",
  thisAccount: "This account",
  inFolder: (name: string) => `In ${name}`,
  settings: "Settings",
  noMessage: "Choose a message to read it.",
  emptyMailbox: "No messages here.",
  showMessages: "Show",
  filterAll: "All",
  sortMessages: "Sort",
  sortDate: "Date",
  sortOldest: "Oldest first",
  sortDescending: "Z to A",
  sortSmallest: "Smallest first",
  sortFrom: "From",
  sortSubject: "Subject",
  sortSize: "Size",
  noUnread: "No unread messages.",
  noStarred: "No starred messages.",
  noAttachments: "No messages with attachments.",
  noPinned: "No pinned messages.",
  toMe: "To me",
  noToMe: "No messages addressed to you.",
  invitations: "Invitations",
  noInvitations: "No calendar invitations.",
  mail: "Mail",
  drafts: "Drafts",
  duplicate: "Duplicate",
  outbox: "Outbox",
  account: "Account",
  emailAccounts: "Email accounts",
  accountSettings: "Account settings",
  getMailAllAccounts: "Get mail for all accounts",
  moreGetMailOptions: "More ways to get mail",
  unreadCount: (count: number) => `${count} unread`,
  unreadInside: (count: number) =>
    count === 1 ? "1 unread in a subfolder" : `${count} unread in subfolders`,
  unreadInOtherAccounts: (count: number) => `${count} unread in other accounts`,
  refreshAllPartial: (failed: number) =>
    failed === 1
      ? "1 account could not be refreshed. Check its status in the account list."
      : `${failed} accounts could not be refreshed. Check their status in the account list.`,
  accountReady: "Ready",
  accountSyncing: "Syncing",
  accountOffline: "Offline",
  accountSignInNeeded: "Sign-in needed",
  addAccount: "Add account",
  mailboxes: "Mailboxes",
  unreadFolders: "Unread folders",
  pinnedFolders: "Pinned",
  hiddenFolders: "Hidden",
  findMailbox: "Find a mailbox",
  noMailboxMatch: "No mailboxes match.",
  accountsAndMailboxes: "Accounts and mailboxes",
  showMailboxes: "Show mailboxes",
  hideMailboxes: "Hide mailboxes",
  closeMailboxes: "Close mailboxes",
  localFolders: "On This Computer",
  checkingMail: "Checking mail…",
  downloadingMail: (done: number, total: number) =>
    `Downloading ${done.toLocaleString()} of ${total.toLocaleString()}`,
  mailUpToDate: "Mail is up to date",
  quietHoursUntil: (time: string) => `Quiet hours until ${time}.`,
  checkedAt: (when: string) => `Checked ${when}.`,
  mailSyncError: "Mail could not sync",
  clearSearch: "Clear search",
  searchAllMailboxes: "Search all mailboxes",
  messages: "Messages",
  newMessages: "New messages",
  loadingMessages: "Loading messages…",
  downloadingMessage: "Downloading message…",
  openToDownload: "Open to download message",
  messageTooLarge:
    "This message is too large to download safely. You can still move, archive, or delete it from the list.",
  emptyBody: "This message has no readable text.",
  bodyOffline:
    "This message has not downloaded yet. Check your internet connection, then open it again.",
  bodySignInNeeded:
    "This message could not download because the mail server did not accept your sign-in. Update the password in Settings, then open it again.",
  loadOlder: "Load older mail",
  loadingOlder: "Loading older mail…",
  read: "Read",
  unread: "Unread",
  starred: "Starred",
  you: "You",
  peopleAndMore: (first: string, second: string, extra: number) =>
    extra === 1
      ? `${first}, ${second}, and 1 other`
      : `${first}, ${second}, and ${extra} others`,
  pinned: "Pinned",
  hasAttachments: "Has attachments",
  replied: "Replied",
  forwarded: "Forwarded",
  muted: "Muted",
  arrivedLater: "Arrived later",
  hasInvitation: "Calendar invitation",
  highImportance: "High importance",
  lowImportance: "Low importance",
  resizeFolders: "Resize mailbox sidebar",
  resizeMessages: "Resize message list",
  resizeReader: "Resize reading pane",
  closeAddAccount: "Close add account",
  addEmailAccount: "Add email account",
  mailboxFallback: "Mailbox",
  noDrafts: "No saved drafts on this device.",
  noDraftMatch: "No drafts match this search.",
  draftFiles: (count: number) => (count === 1 ? "1 file" : `${count} files`),
  draftFrom: (address: string) => `From: ${address}`,
  draftReply: "Unsent reply",
  draftForward: "Unsent forward",
  draftRedirect: "Unsent redirect",
  noQueued: "No queued messages.",
  noOutboxMatch: "No queued messages match this search.",
  outboxEmptyBody: "This message has no text yet.",
  offlineChangesDropped:
    "Some offline changes could not be applied and were undone.",
  noSnoozed: "Nothing snoozed. Snoozed mail waits here until its time comes.",
  noSnoozedMatch: "No snoozed messages match this search.",
  snoozed: "Snoozed",
  unsnooze: "Bring back",
  snoozedUntil: (when: string) => `Snoozed until ${when}`,
  noRecipientYet: "No recipient yet",
  noRecipient: "No recipient",
  toPeople: (people: string) => `To ${people}`,
  savedServer: "Saved here and on mail server",
  recoveredConflict: "Recovered conflict copy",
  savedLocal: "Saved here — server sync pending",
  savingServer: "Saving to mail server…",
  queuedAt: (when: string) => `Queued ${when}`,
  waitingSend: "Waiting to send",
  sending: "Sending",
  sentCopyPending: "Sent — copy pending",
  needsAttention: "Needs attention",
  retrySending: "Retry sending",
  editQueued: "Edit",
  editUncertainTitle: "Edit this message?",
  editUncertainDetail:
    "Delivery of this message could not be confirmed. Editing it removes it from the Outbox, and sending it again may deliver another copy.",
  saveSentCopy: "Save Sent copy",
  retryWarning:
    "Retry this message? Delivery may already have happened. Retrying could send a duplicate.",
  retryAll: "Retry all",
  retryAllWarning: (count: number) =>
    `Retry ${count} messages? Delivery may already have happened. Retrying could send duplicates.`,
  retryAllFailed: (count: number) =>
    count === 1
      ? "1 message could not be retried. It is still in Outbox."
      : `${count} messages could not be retried. They are still in Outbox.`,
  scheduledWaiting: "Held before sending",
  sendIn: (seconds: number) =>
    seconds <= 0 ? "Sending…" : `Sending in ${seconds}s`,
  sendInMinutes: (minutes: number) =>
    minutes === 1 ? "Sending in 1 minute" : `Sending in ${minutes} minutes`,
  sendsAt: (when: string) => `Sends ${when}`,
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
  today: "Today",
  yesterday: "Yesterday",
  justNow: "just now",
  minutesAgo: (count: number) => `${count}m ago`,
  hoursAgo: (count: number) => `${count}h ago`,
  daysAgo: (count: number) => `${count}d ago`,
  updateReadyBadge: "Update Ready · Click to Restart",
  updateReadyBadgeShort: "Restart to Update",
  updateReadyBadgeTiny: "Update",
  updateReadyTooltip: (version: string) =>
    `Version ${version} is downloaded and ready to install. Click to restart.`,
  itemCount: (count: number) => (count === 1 ? "1 item" : `${count} items`),
  loadedOfTotal: (shown: number, total: number) => `${shown} of ${total}`,
  partialSearch: (detail: string) =>
    `Server search unavailable. Showing cached results. ${detail}`,
  noSearchResults: (query: string) =>
    `No messages matching "${query}". Check your spelling or try All Folders.`,
  newFolder: "New folder",
  newFolderInside: (name: string) => `New folder inside ${name}`,
  renameFolderInside: (name: string) => `Inside ${name}`,
  moveFolder: "Move folder",
  moveFolderDetail: (name: string) => `Choose where to put ${name}.`,
  topLevel: "Top level",
  folderName: "Folder name",
  createFolder: "Create folder",
  rename: "Rename",
  deleteFolder: "Delete folder",
  deleteFolderQuestion: (name: string) =>
    `Delete "${name}" and all messages in it? This cannot be undone.`,
  emptyTrash: "Empty trash",
  emptyTrashQuestion:
    "Permanently delete every message in Trash? This cannot be undone.",
  deleteForever: "Delete",
  deleteForeverQuestion: (count: number) =>
    count === 1
      ? "Permanently delete this message? This cannot be undone."
      : `Permanently delete ${count} messages? This cannot be undone.`,
  emptyJunk: "Empty junk",
  emptyJunkQuestion:
    "Permanently delete every message in Junk? This cannot be undone.",
  select: "Select",
  doneSelecting: "Done",
  selectedCount: (count: number) =>
    count === 1 ? "1 selected" : `${count} selected`,
  selectMessage: (subject: string) => `Select ${subject}`,
  selectDay: (label: string) => `Select ${label}`,
  paneSize: (pixels: number) => `${pixels} pixels`,
  markAllRead: "Mark all read",
  collapseFolders: "Collapse folders",
  expandFolders: "Expand folders",
  expandConversations: "Expand conversations",
  collapseConversations: "Collapse conversations",
  nextUnread: "Next unread",
  goToInbox: "Go to Inbox",
  noInbox: "This account does not have an Inbox.",
  goToSent: "Go to Sent",
  noSent: "This account does not have a Sent mailbox.",
  nextUnreadMailbox: "Next unread mailbox",
  previousUnreadMailbox: "Previous unread mailbox",
  noOtherUnreadMailbox: "No other mailbox has unread mail.",
  moreMailboxActions: "More mailbox actions",
  snoozeSelected: "Snooze selected",
  pinSelected: "Pin selected",
  unpinSelected: "Unpin selected",
  conversation: "Conversation",
  threadMessages: (count: number) =>
    count === 1 ? "1 message" : `${count} messages`,
  threadUnread: (count: number) =>
    count === 1 ? "1 unread" : `${count} unread`,
  copyQueued:
    "Some copies will finish when this account reconnects. The originals stay here.",
  bulkPartial: (failed: number) =>
    `${failed} message${failed === 1 ? " could" : "s could"} not be updated. The rest succeeded.`,
  bulkTooMany: "Select up to 200 messages at a time.",
  noTargetFolder: "This account does not have that folder.",
} as const;
