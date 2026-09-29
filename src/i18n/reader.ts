// English source catalog namespace: reader section.
// Split from src/i18n.ts with zero text changes.
export const reader = {
  backToList: "Back to message list",
  closeMessage: "Close message",
  actions: "Message actions",
  reply: "Reply",
  replyAll: "Reply all",
  forward: "Forward",
  preparing: "Preparing…",
  markUnread: "Mark unread",
  markRead: "Mark read",
  removeStar: "Remove star",
  addStar: "Add star",
  archive: "Archive",
  junk: "Mark as junk",
  notJunk: "Not junk",
  trash: "Move to trash",
  moveFolder: "Move to folder",
  move: "Move…",
  print: "Print message",
  findInMessage: "Find in message",
  findNext: "Find next",
  from: "From:",
  to: "To:",
  cc: "Cc:",
  replyTo: "Reply-To:",
  subject: "Subject:",
  date: "Date:",
  folder: "Folder:",
  security: "Security:",
  securityTls: "Verified TLS connection",
  securityTlsDetail: "Encrypted directly between your device and mail server.",
  messageId: "Message-ID:",
  size: "Size:",
  copyAddress: "Copy address",
  copyMessageId: "Copy Message-ID",
  copied: "Copied!",
  noRecipients: "No recipients",
  showDetails: "Details",
  hideDetails: "Hide details",
  loadImages: "Load images",
  filteredImage: "Advertising or tracking image blocked",
  filteredImages: (count: number) =>
    `${count} advertising or tracking image${count === 1 ? "" : "s"} kept blocked for privacy.`,
  threatImage: "Image from a reported potentially dangerous address",
  threatImages: (count: number) =>
    `${count} image${count === 1 ? "" : "s"} from a reported potentially dangerous address kept blocked.`,
  retryImages: "Retry loading images",
  messageContent: "Message content",
  attachments: "Attachments",
  preview: "Preview",
  previewTitle: (filename: string) => `Preview of ${filename}`,
  downloadFile: "Download file",
  moreActions: "More actions",
  snooze: "Snooze",
  snoozeTomorrow: "Tomorrow morning",
  snoozeNextWeek: "Next week",
  snoozeCustom: "Custom date and time",
  snoozeUntil: "Snooze until",
  openLink: (hostname: string, url: string) =>
    `This link goes to:\n\n${hostname}\n\n${url}\n\nOpen it in your browser?`,
  reportedThreatTitle: "This link may be dangerous",
  reportedThreat: (hostname: string, url: string) =>
    `This address was reported as potentially dangerous.\n\n${hostname}\n\n${url}\n\nIt is better not to open it. Choose Cancel unless you are sure you want to continue.`,
  reportedThreatOpenAnyway:
    "Open this reported address anyway? This can put your information at risk.",
  unsubscribe: "Unsubscribe…",
  unsubscribeTitle: "Unsubscribe from this sender?",
  unsubscribeConfirm: (hostname: string) =>
    `${hostname}\n\nPostal Snap will send a one-time request to this sender's server asking to remove you from its list. Nothing else is shared.\n\nSend the request?`,
  unsubscribeSent: "Unsubscribe request sent",
  unsubscribeSentDetail:
    "The sender decides whether and when to act on it. You may still get a few more messages.",
  unsubscribeFailed:
    "The unsubscribe request was not sent. Try again later, or use the sender's own unsubscribe page.",
  showOriginal: "Show original",
  originalTitle: "Original message",
  originalHeaders: "Headers",
  originalSource: "Source",
  originalLoading: "Loading the original message…",
  originalTruncated:
    "Showing the first part only. Save as .eml to keep the whole message.",
  copySource: "Copy source",
  saveEml: "Save as .eml",
  repliedTo: "You replied to this message",
  forwardedMessage: "You forwarded this message",
  invitation: "Calendar invitation",
  inviteMethod: (method: string | null | undefined, status?: string | null) => {
    if (method === "CANCEL" || status === "CANCELLED") return "Cancelled";
    if (method === "REQUEST") return "Invitation";
    if (method === "REPLY") return "Reply to an invitation";
    if (method === "COUNTER") return "Proposed new time";
    if (method === "PUBLISH") return "Event";
    return status === "TENTATIVE" ? "Tentative event" : "Event";
  },
  inviteUntitled: "Untitled event",
  inviteWhen: "When",
  inviteWhere: "Where",
  inviteOrganizer: "Organizer",
  inviteAllDay: "All day",
  inviteNoRsvp:
    "Postal Snap shows invitations but does not send replies. Answer from your calendar or by email.",
  blockedImages: (count: number) =>
    `${count} remote image${count === 1 ? "" : "s"} blocked for privacy.`,
  blockedImagesDetail:
    "Known trackers stay blocked if you load them, but other pictures may tell the sender you opened this message.",
} as const;
