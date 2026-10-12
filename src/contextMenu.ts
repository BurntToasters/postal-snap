import {
  blockableDomain,
  canBlockSender,
  domainIsBlocked,
  senderIsBlocked,
} from "./blockedSenders";
import { differentLinkAddress } from "./security";
import { strings } from "./i18n";
import { folderPathLabel } from "./i18n/mail";
import { folderMoveDestinations } from "./folderMove";
import {
  HIDDEN_MAILBOX_LIMIT,
  mailboxIsPinned,
  PINNED_MAILBOX_LIMIT,
} from "./pinnedMailboxes";
import { withRecentMoveMailbox } from "./recentMailbox";
import { useAppStore } from "./store";
import {
  conversationMessages,
  conversationRead,
  conversationUnread,
} from "./threads";
import type {
  MailboxRole,
  MailboxSummary,
  MessageSummary,
  OutboxSummary,
} from "./types";

export const CONTEXT_ACTION_EVENT = "postal:context-action";
export const IFRAME_CONTEXT_EVENT = "postal:iframe-contextmenu";
export const CONTEXT_DISMISS_EVENT = "postal:context-dismiss";

export type LocalMailView = "drafts" | "outbox" | "snoozed";

export type ContextMenuTarget =
  | { kind: "suppress" }
  | { kind: "account"; accountId: string }
  | { kind: "message"; messageId: number }
  | { kind: "folder"; mailboxId: number }
  | { kind: "local-nav"; view: LocalMailView }
  | { kind: "draft"; draftId: string }
  | { kind: "outbox"; outboxId: string }
  | { kind: "snoozed"; messageId: number }
  | { kind: "reader" }
  | { kind: "link"; href: string; text?: string }
  | { kind: "mailto"; href: string }
  | {
      kind: "attachment";
      attachmentId: string;
      previewable: boolean;
      filename: string;
    }
  | { kind: "address"; address: string }
  | { kind: "composer" }
  | { kind: "composer-attachment"; index: number }
  | { kind: "editable" };

export type ContextMenuIcon =
  | "reply"
  | "reply-all"
  | "forward"
  | "mark-read"
  | "mark-unread"
  | "star"
  | "unstar"
  | "pin"
  | "unpin"
  | "archive"
  | "inbox"
  | "junk"
  | "not-junk"
  | "trash"
  | "snooze"
  | "unsnooze"
  | "filter"
  | "open"
  | "refresh"
  | "mark-all-read"
  | "new-folder"
  | "rename"
  | "delete"
  | "retry"
  | "send"
  | "discard"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "select-all"
  | "find"
  | "print"
  | "open-link"
  | "copy-link"
  | "copy-address"
  | "compose"
  | "preview"
  | "download"
  | "remove"
  | "settings"
  | "mute"
  | "unmute"
  | `folder:${MailboxRole}`;

export type ContextMenuItem =
  | { type: "separator" }
  | { type: "heading"; label: string }
  | {
      type: "item";
      id: string;
      label: string;
      icon?: ContextMenuIcon;
      ariaLabel?: string;
      disabled?: boolean;
      danger?: boolean;
    };

export interface ContextMenuActionDetail {
  id: string;
  target: ContextMenuTarget;
}

export interface IframeContextMenuDetail {
  x: number;
  y: number;
  href?: string;
  mailto?: string;
  text?: string;
}

const LOCAL_VIEWS = new Set<string>(["drafts", "outbox", "snoozed"]);

export function item(
  id: string,
  label: string,
  extra?: {
    icon?: ContextMenuIcon;
    ariaLabel?: string;
    disabled?: boolean;
    danger?: boolean;
  },
): ContextMenuItem {
  return { type: "item", id, label, ...extra };
}

function linkFromElement(element: HTMLElement): ContextMenuTarget | undefined {
  const marked = element.getAttribute("data-external-href")?.trim() ?? "";
  const href = element.getAttribute("href")?.trim() ?? "";
  const url = /^https?:/i.test(marked)
    ? marked
    : /^https?:/i.test(href)
      ? href
      : /^mailto:/i.test(marked)
        ? marked
        : /^mailto:/i.test(href)
          ? href
          : "";
  if (/^https?:/i.test(url)) {
    const text = differentLinkAddress(element.textContent ?? "", url);
    return text
      ? { kind: "link", href: url, text }
      : { kind: "link", href: url };
  }
  if (/^mailto:/i.test(url)) return { kind: "mailto", href: url };
  return undefined;
}

export function resolveContextTarget(
  start: EventTarget | null,
): ContextMenuTarget {
  if (!(start instanceof Element)) return { kind: "suppress" };
  if (start.closest(".context-menu")) return { kind: "suppress" };

  const link = start.closest<HTMLElement>(
    "a[data-external-href], a[href], area[href]",
  );
  if (link) {
    const fromLink = linkFromElement(link);
    if (fromLink) return fromLink;
  }

  const marked = start.closest<HTMLElement>("[data-context]");
  if (marked) {
    const kind = marked.dataset.context;
    if (kind === "chrome") return { kind: "suppress" };
    if (kind === "account" && marked.dataset.accountId) {
      return { kind: "account", accountId: marked.dataset.accountId };
    }
    if (kind === "message") {
      const messageId = Number(marked.dataset.messageId);
      if (Number.isFinite(messageId)) return { kind: "message", messageId };
    }
    if (kind === "folder") {
      const mailboxId = Number(marked.dataset.mailboxId);
      if (Number.isFinite(mailboxId)) return { kind: "folder", mailboxId };
    }
    if (
      kind === "local-nav" &&
      LOCAL_VIEWS.has(marked.dataset.localView ?? "")
    ) {
      return {
        kind: "local-nav",
        view: marked.dataset.localView as LocalMailView,
      };
    }
    if (kind === "draft" && marked.dataset.draftId) {
      return { kind: "draft", draftId: marked.dataset.draftId };
    }
    if (kind === "outbox" && marked.dataset.outboxId) {
      return { kind: "outbox", outboxId: marked.dataset.outboxId };
    }
    if (kind === "snoozed") {
      const messageId = Number(marked.dataset.messageId);
      if (Number.isFinite(messageId)) return { kind: "snoozed", messageId };
    }
    if (kind === "reader") return { kind: "reader" };
    if (kind === "attachment" && marked.dataset.attachmentId) {
      return {
        kind: "attachment",
        attachmentId: marked.dataset.attachmentId,
        previewable: marked.dataset.previewable === "true",
        filename: marked.dataset.filename ?? "",
      };
    }
    if (kind === "address" && marked.dataset.address) {
      return { kind: "address", address: marked.dataset.address };
    }
    if (kind === "composer") return { kind: "composer" };
    if (kind === "composer-attachment") {
      const index = Number(marked.dataset.attachmentIndex);
      if (Number.isFinite(index)) return { kind: "composer-attachment", index };
    }
    if (kind === "editable") return { kind: "editable" };
  }

  if (start.closest(".composer-editor, .ProseMirror")) {
    return { kind: "composer" };
  }
  const field = start.closest<HTMLElement>(
    "input:not([type='button']):not([type='submit']):not([type='checkbox']):not([type='radio']), textarea, [contenteditable='true']",
  );
  if (field && !field.closest(".context-menu")) return { kind: "editable" };
  return { kind: "suppress" };
}

/** Sender text a mail rule can store. Empty when the address is unusable. */
function messageAccount(accountId: string) {
  return useAppStore
    .getState()
    .accounts.find((account) => account.id === accountId);
}

export function senderRuleNeedle(address: string): string | undefined {
  const needle = address.trim();
  if (!needle || needle.length > 200) return undefined;
  if (
    [...needle].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    return undefined;
  }
  return needle;
}

/** Subject text a mail rule can store. Long subjects keep the first 200 characters. */
export function subjectRuleNeedle(subject: string): string | undefined {
  const needle = subject.trim();
  if (!needle) return undefined;
  if (
    [...needle].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    return undefined;
  }
  return [...needle].slice(0, 200).join("");
}

/** Mailbox inside an address chip, without a display name. */
export function addressMailbox(value: string): string | undefined {
  const trimmed = value.trim();
  const bracketed = trimmed.match(/<([^<>]+)>$/)?.[1]?.trim();
  const mailbox = (bracketed ?? trimmed).replaceAll('"', "").trim();
  const needle = senderRuleNeedle(mailbox);
  if (!needle || !/\p{L}|\p{N}/u.test(needle)) return undefined;
  return needle;
}

/** Account search for mail from or to this address, or nothing if it is unusable. */
export function addressSearchQuery(
  field: "from" | "to",
  address: string,
): string | undefined {
  const mailbox = addressMailbox(address);
  if (!mailbox) return undefined;
  return `${field}:"${mailbox}"`;
}

/** Account search that finds mail from this address, or nothing if it is unusable. */
export function senderSearchQuery(address: string): string | undefined {
  return addressSearchQuery("from", address);
}

const SUBJECT_PREFIX = /^(?:re|fwd|fw)\s*:\s*/i;

/** Account search for this subject, without reply or forward prefixes. */
export function subjectSearchQuery(subject: string): string | undefined {
  let text = subject.trim();
  if (
    !text ||
    text.includes('"') ||
    [...text].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    return undefined;
  }
  let previous = "";
  while (text !== previous) {
    previous = text;
    text = text.replace(SUBJECT_PREFIX, "").trim();
  }
  text = [...text].slice(0, 200).join("");
  if (!text || !/\p{L}|\p{N}/u.test(text)) return undefined;
  return `subject:"${text}"`;
}

/** The nearest earlier Message-ID this message names, skipping its own id. */
export function earlierHeaderId(message: {
  messageId?: string | null;
  references?: string[];
}): string | undefined {
  const own = message.messageId?.trim().toLowerCase();
  const references = message.references ?? [];
  for (let index = references.length - 1; index >= 0; index -= 1) {
    const id = references[index]?.trim();
    if (!id) continue;
    if (own && id.toLowerCase() === own) continue;
    return id;
  }
  return undefined;
}

/** Loaded messages whose sender address matches, ignoring case. */
export function sameSenderMessages(
  messages: MessageSummary[],
  address: string,
): MessageSummary[] {
  const needle = address.trim().toLowerCase();
  if (!needle) return [];
  return messages.filter(
    (item) => item.senderAddress.trim().toLowerCase() === needle,
  );
}

/** A message can be muted when it has a Message-ID later replies can name. */
export function canMuteConversation(message: MessageSummary): boolean {
  return Boolean(message.messageId?.trim());
}

function messageItems(
  message: MessageSummary,
  mailbox: MailboxSummary | undefined,
  mailboxes: MailboxSummary[],
  messages: MessageSummary[],
): ContextMenuItem[] {
  const peers = conversationMessages(messages, message);
  const items: ContextMenuItem[] = [
    item("reply", strings.reader.reply, { icon: "reply" }),
    item("reply-all", strings.reader.replyAll, { icon: "reply-all" }),
    item("reply-bare", strings.reader.replyWithoutQuoting, { icon: "reply" }),
    item("reply-all-bare", strings.reader.replyAllWithoutQuoting, {
      icon: "reply-all",
    }),
    ...(message.hasAttachments
      ? [
          item("reply-with-attachments", strings.reader.replyWithAttachments, {
            icon: "reply",
          }),
          item(
            "reply-all-with-attachments",
            strings.reader.replyAllWithAttachments,
            { icon: "reply-all" },
          ),
        ]
      : []),
    item("forward", strings.reader.forward, { icon: "forward" }),
    ...(peers.length > 1
      ? [
          item("forward-conversation", strings.reader.forwardConversation, {
            icon: "forward",
          }),
        ]
      : []),
    item("forward-attachment", strings.reader.forwardAsAttachment, {
      icon: "forward",
    }),
    item("redirect", strings.reader.redirect, { icon: "forward" }),
    item("edit-as-new", strings.reader.editAsNew, { icon: "compose" }),
    ...(addressMailbox(message.senderAddress)
      ? [
          item("compose-to-sender", strings.reader.newMessageToSender, {
            icon: "compose",
          }),
        ]
      : []),
    item("copy-message-text", strings.reader.copyMessageText, { icon: "copy" }),
    ...(message.subject.trim()
      ? [item("copy-subject", strings.reader.copySubject, { icon: "copy" })]
      : []),
    ...(addressMailbox(message.senderAddress)
      ? [
          item("copy-sender-address", strings.reader.copySenderAddress, {
            icon: "copy",
          }),
        ]
      : []),
    item("save-eml", strings.reader.saveEml, { icon: "download" }),
    ...(message.recipients.trim()
      ? [
          item("copy-recipients", strings.reader.copyRecipients, {
            icon: "copy",
          }),
        ]
      : []),
    ...(peers.length > 1
      ? [
          item("copy-conversation-text", strings.reader.copyConversationText, {
            icon: "copy",
          }),
        ]
      : []),
    ...(peers.length > 1
      ? [
          item("print-conversation", strings.reader.printConversation, {
            icon: "print",
          }),
        ]
      : []),
    ...(peers.length > 1 && peers.some((row) => row.hasAttachments)
      ? [
          item(
            "save-conversation-files",
            strings.reader.saveConversationFiles,
            { icon: "download" },
          ),
        ]
      : []),
    { type: "separator" },
    message.isRead
      ? item("toggle-read", strings.reader.markUnread, { icon: "mark-unread" })
      : item("toggle-read", strings.reader.markRead, { icon: "mark-read" }),
    ...(conversationUnread(messages, message).length > 0
      ? [
          item("mark-conversation-read", strings.reader.markConversationRead, {
            icon: "mark-all-read",
          }),
        ]
      : []),
    ...(conversationRead(messages, message).length > 0
      ? [
          item(
            "mark-conversation-unread",
            strings.reader.markConversationUnread,
            { icon: "mark-unread" },
          ),
        ]
      : []),
    message.isStarred
      ? item("toggle-star", strings.reader.removeStar, { icon: "unstar" })
      : item("toggle-star", strings.reader.addStar, { icon: "star" }),
    ...(peers.some((row) => !row.isStarred)
      ? [
          item("star-conversation", strings.reader.starConversation, {
            icon: "star",
          }),
        ]
      : peers.length > 1
        ? [
            item("unstar-conversation", strings.reader.unstarConversation, {
              icon: "unstar",
            }),
          ]
        : []),
    ...(peers.some((row) => !row.pinned)
      ? [
          item("pin-conversation", strings.reader.pinConversation, {
            icon: "pin",
          }),
        ]
      : peers.length > 1
        ? [
            item("unpin-conversation", strings.reader.unpinConversation, {
              icon: "unpin",
            }),
          ]
        : []),
    message.pinned
      ? item("unpin", strings.reader.unpin, { icon: "unpin" })
      : item("pin", strings.reader.pin, { icon: "pin" }),
    ...(peers.length > 1
      ? [
          item("select-conversation", strings.reader.selectConversation, {
            icon: "select-all",
          }),
        ]
      : []),
    ...(sameSenderMessages(messages, message.senderAddress).length > 1
      ? [
          item("select-from-sender", strings.reader.selectFromSender, {
            icon: "select-all",
          }),
        ]
      : []),
    ...(earlierHeaderId(useAppStore.getState().selectedMessage ?? {}) &&
    useAppStore.getState().selectedMessage?.id === message.id
      ? [
          item("open-earlier", strings.reader.openEarlier, {
            icon: "open",
          }),
        ]
      : []),
    item("snooze", strings.reader.snooze, { icon: "snooze" }),
    ...(peers.length > 1
      ? [
          item("snooze-conversation", strings.reader.snoozeConversation, {
            icon: "snooze",
          }),
        ]
      : []),
    ...(senderRuleNeedle(message.senderAddress)
      ? [
          item("create-rule", strings.reader.createRuleFromSender, {
            icon: "filter",
          }),
          ...(senderSearchQuery(message.senderAddress)
            ? [
                item(
                  "messages-from-sender",
                  strings.reader.messagesFromSender,
                  { icon: "find" },
                ),
              ]
            : []),
        ]
      : []),
    ...(subjectRuleNeedle(message.subject)
      ? [
          item("create-subject-rule", strings.reader.createRuleFromSubject, {
            icon: "filter",
          }),
        ]
      : []),
    ...(subjectSearchQuery(message.subject)
      ? [
          item("messages-with-subject", strings.reader.messagesWithSubject, {
            icon: "find",
          }),
        ]
      : []),
    { type: "separator" },
    mailbox?.role === "archive"
      ? item("move-to-inbox", strings.reader.moveToInbox, { icon: "inbox" })
      : item("archive", strings.reader.archive, { icon: "archive" }),
    ...(peers.length > 1
      ? [
          mailbox?.role === "archive"
            ? item(
                "move-conversation-inbox",
                strings.reader.moveConversationToInbox,
                { icon: "inbox" },
              )
            : item("archive-conversation", strings.reader.archiveConversation, {
                icon: "archive",
              }),
        ]
      : []),
    ...(peers.length > 1 && mailbox?.role === "junk"
      ? [
          item(
            "move-conversation-inbox",
            strings.reader.moveConversationToInbox,
            { icon: "inbox" },
          ),
        ]
      : []),
    mailbox?.role === "junk"
      ? item("not-junk", strings.reader.notJunk, { icon: "not-junk" })
      : item("junk", strings.reader.junk, { icon: "junk" }),
    ...(peers.length > 1 && mailbox?.role !== "junk"
      ? [
          item("junk-conversation", strings.reader.junkConversation, {
            icon: "junk",
          }),
        ]
      : []),
    ...(senderRuleNeedle(message.senderAddress) &&
    (senderIsBlocked(message.accountId, message.senderAddress) ||
      canBlockSender(message.senderAddress, messageAccount(message.accountId)))
      ? [
          senderIsBlocked(message.accountId, message.senderAddress)
            ? item("unblock-sender", strings.reader.unblockSender, {
                icon: "not-junk",
              })
            : item("block-sender", strings.reader.blockSender, {
                icon: "junk",
              }),
        ]
      : []),
    ...(domainIsBlocked(message.accountId, message.senderAddress) ||
    blockableDomain(message.senderAddress, messageAccount(message.accountId))
      ? [
          domainIsBlocked(message.accountId, message.senderAddress)
            ? item("unblock-domain", strings.reader.unblockDomain, {
                icon: "not-junk",
              })
            : item("block-domain", strings.reader.blockDomain, {
                icon: "junk",
              }),
        ]
      : []),
    ...(canMuteConversation(message)
      ? [
          item(
            "mute-conversation",
            message.conversationMuted
              ? strings.reader.unmuteConversation
              : strings.reader.muteConversation,
            { icon: message.conversationMuted ? "unmute" : "mute" },
          ),
        ]
      : []),
    mailbox?.role === "trash"
      ? item("delete-forever", strings.mail.deleteForever, {
          icon: "trash",
          danger: true,
        })
      : item("trash", strings.reader.trash, { icon: "trash" }),
    ...(peers.length > 1 && mailbox?.role === "trash"
      ? [
          item("delete-conversation", strings.reader.deleteConversation, {
            icon: "trash",
            danger: true,
          }),
        ]
      : []),
    ...(peers.length > 1 && mailbox?.role !== "trash"
      ? [
          item("trash-conversation", strings.reader.trashConversation, {
            icon: "trash",
          }),
        ]
      : []),
  ];
  // Archive, Junk, and Trash already have direct actions above.
  const destinations = mailboxes.filter(
    (box) =>
      box.id !== message.mailboxId &&
      box.role !== "archive" &&
      box.role !== "junk" &&
      box.role !== "trash" &&
      !(mailbox?.role === "archive" && box.role === "inbox"),
  );
  const orderedDestinations = withRecentMoveMailbox(destinations);
  if (orderedDestinations.length > 0) {
    items.push({ type: "separator" });
    items.push({ type: "heading", label: strings.contextMenu.moveTo });
    for (const box of orderedDestinations) {
      const name = folderPathLabel(box);
      items.push(
        item(`move-mailbox:${box.id}`, name, {
          icon: `folder:${box.role}`,
          ariaLabel: strings.contextMenu.moveToFolder(name),
        }),
      );
    }
    if (peers.length > 1) {
      items.push({ type: "separator" });
      items.push({
        type: "heading",
        label: strings.contextMenu.moveConversationTo,
      });
      for (const box of orderedDestinations) {
        const name = folderPathLabel(box);
        items.push(
          item(`move-conversation:${box.id}`, name, {
            icon: `folder:${box.role}`,
            ariaLabel: strings.contextMenu.moveConversationToFolder(name),
          }),
        );
      }
    }
    items.push({ type: "separator" });
    items.push({ type: "heading", label: strings.contextMenu.copyTo });
    for (const box of orderedDestinations) {
      const name = folderPathLabel(box);
      items.push(
        item(`copy-mailbox:${box.id}`, name, {
          icon: `folder:${box.role}`,
          ariaLabel: strings.contextMenu.copyToFolder(name),
        }),
      );
    }
    if (peers.length > 1) {
      items.push({ type: "separator" });
      items.push({
        type: "heading",
        label: strings.contextMenu.copyConversationTo,
      });
      for (const box of orderedDestinations) {
        const name = folderPathLabel(box);
        items.push(
          item(`copy-conversation:${box.id}`, name, {
            icon: `folder:${box.role}`,
            ariaLabel: strings.contextMenu.copyConversationToFolder(name),
          }),
        );
      }
    }
  }
  return items;
}

function folderItems(mailbox: MailboxSummary): ContextMenuItem[] {
  const { settings, activeAccountId } = useAppStore.getState();
  const pinned = mailboxIsPinned(
    settings.pinnedMailboxes,
    activeAccountId,
    mailbox.id,
  );
  const hidden =
    mailbox.role !== "inbox" &&
    mailboxIsPinned(settings.hiddenMailboxes, activeAccountId, mailbox.id);
  const items: ContextMenuItem[] = [
    item("open", strings.contextMenu.open, { icon: `folder:${mailbox.role}` }),
    item("get-mail", strings.mail.getMail, { icon: "refresh" }),
    item("mark-all-read", strings.mail.markAllRead, {
      icon: "mark-all-read",
      disabled: mailbox.unreadCount === 0,
    }),
    item(
      pinned ? "unpin-folder" : "pin-folder",
      pinned
        ? strings.contextMenu.unpinMailbox
        : strings.contextMenu.pinMailbox,
      {
        icon: pinned ? "unpin" : "pin",
        disabled:
          !pinned &&
          (settings.pinnedMailboxes?.length ?? 0) >= PINNED_MAILBOX_LIMIT,
      },
    ),
    item("new-subfolder", strings.mail.newFolder, {
      icon: "new-folder",
      disabled: !mailbox.delimiter,
    }),
  ];
  if (mailbox.role !== "inbox") {
    items.push(
      item(
        hidden ? "show-folder" : "hide-folder",
        hidden
          ? strings.contextMenu.showMailbox
          : strings.contextMenu.hideMailbox,
        {
          icon: hidden ? "preview" : "remove",
          disabled:
            !hidden &&
            (settings.hiddenMailboxes?.length ?? 0) >= HIDDEN_MAILBOX_LIMIT,
        },
      ),
    );
  }
  const destructive: ContextMenuItem[] = [];
  if (mailbox.role === "trash" && mailbox.totalCount > 0) {
    destructive.push(
      item("empty-trash", strings.mail.emptyTrash, {
        icon: "delete",
        danger: true,
      }),
    );
  }
  if (mailbox.role === "junk" && mailbox.totalCount > 0) {
    destructive.push(
      item("empty-junk", strings.mail.emptyJunk, {
        icon: "delete",
        danger: true,
      }),
    );
  }
  if (mailbox.role === "other") {
    items.push(item("rename-folder", strings.mail.rename, { icon: "rename" }));
    if (
      folderMoveDestinations(mailbox, useAppStore.getState().mailboxes).length >
      0
    ) {
      items.push(
        item("move-folder", strings.mail.moveFolder, { icon: "archive" }),
      );
    }
    destructive.push(
      item("delete-folder", strings.mail.deleteFolder, {
        icon: "delete",
        danger: true,
      }),
    );
  }
  if (destructive.length > 0) {
    items.push({ type: "separator" }, ...destructive);
  }
  return items;
}

function outboxRowBusy(outboxId: string): boolean {
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(outboxId)
      : outboxId.replace(/["\\]/g, "");
  const node = document.querySelector(
    `[data-context="outbox"][data-outbox-id="${escaped}"]`,
  );
  return node?.getAttribute("data-busy") === "true";
}

function outboxItems(row: OutboxSummary): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    item("open", strings.contextMenu.open, { icon: "open" }),
  ];
  const busy = row.state === "sending" || outboxRowBusy(row.id);
  if (row.state === "queued" || row.state === "needs_attention") {
    items.push(
      item("edit", strings.mail.editQueued, {
        icon: "compose",
        disabled: busy,
      }),
    );
  }
  if (row.state === "needs_attention") {
    items.push(item("retry", strings.mail.retrySending, { icon: "retry" }));
  } else if (row.state === "sent_copy_pending") {
    items.push(
      item("retry-copy", strings.mail.saveSentCopy, { icon: "retry" }),
    );
  } else if (row.state === "scheduled") {
    items.push(
      item("send-now", strings.mail.sendNow, { icon: "send", disabled: busy }),
    );
  }
  items.push(
    item(
      "discard",
      row.state === "sent_copy_pending"
        ? strings.mail.dismissWarning
        : row.state === "scheduled"
          ? strings.mail.undoSend
          : strings.common.discard,
      {
        icon: row.state === "scheduled" ? "undo" : "discard",
        danger: row.state !== "sent_copy_pending",
        disabled: busy,
      },
    ),
  );
  return items;
}

function editItems(plainPaste: boolean): ContextMenuItem[] {
  return [
    item("undo", strings.composer.undo, { icon: "undo" }),
    item("redo", strings.composer.redo, { icon: "redo" }),
    { type: "separator" },
    item("cut", strings.contextMenu.cut, { icon: "cut" }),
    item("copy", strings.contextMenu.copy, { icon: "copy" }),
    item("paste", strings.contextMenu.paste, { icon: "paste" }),
    ...(plainPaste
      ? [
          item("paste-plain", strings.composer.pasteWithoutFormatting, {
            icon: "paste",
          }),
        ]
      : []),
    { type: "separator" },
    item("select-all", strings.contextMenu.selectAll, { icon: "select-all" }),
  ];
}

function addressItems(address: string): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (addressMailbox(address)) {
    items.push(
      item("compose-to-address", strings.reader.newMessageToAddress, {
        icon: "compose",
      }),
      item("messages-from-sender", strings.reader.messagesFromSender, {
        icon: "find",
      }),
      item("messages-to-address", strings.reader.messagesToAddress, {
        icon: "find",
      }),
      ...(senderRuleNeedle(addressMailbox(address) ?? "")
        ? [
            item("create-address-rule", strings.reader.createRuleForAddress, {
              icon: "filter",
            }),
          ]
        : []),
      { type: "separator" },
    );
  }
  items.push(
    item("copy-address", strings.reader.copyAddress, {
      icon: "copy-address",
    }),
  );
  return items;
}

export function itemsForTarget(target: ContextMenuTarget): ContextMenuItem[] {
  const state = useAppStore.getState();
  switch (target.kind) {
    case "suppress":
      return [];
    case "account":
      return state.accounts.some((account) => account.id === target.accountId)
        ? [
            item("get-mail", strings.mail.getMail, { icon: "refresh" }),
            item("account-settings", strings.mail.accountSettings, {
              icon: "settings",
            }),
          ]
        : [];
    case "message": {
      const message = state.messages.find((row) => row.id === target.messageId);
      if (!message) return [];
      const mailbox = state.mailboxes.find(
        (box) => box.id === message.mailboxId,
      );
      return messageItems(message, mailbox, state.mailboxes, state.messages);
    }
    case "folder": {
      const mailbox = state.mailboxes.find(
        (box) => box.id === target.mailboxId,
      );
      return mailbox ? folderItems(mailbox) : [];
    }
    case "local-nav":
      return [item("open", strings.contextMenu.open, { icon: "open" })];
    case "draft":
      return [
        item("open", strings.contextMenu.open, { icon: "open" }),
        item("duplicate-draft", strings.mail.duplicate, { icon: "copy" }),
        item("delete-draft", strings.common.discard, {
          icon: "discard",
          danger: true,
        }),
      ];
    case "outbox": {
      const row = state.outbox.find((entry) => entry.id === target.outboxId);
      return row ? outboxItems(row) : [];
    }
    case "snoozed":
      return [
        item("open", strings.contextMenu.open, { icon: "open" }),
        item("unsnooze", strings.mail.unsnooze, { icon: "unsnooze" }),
      ];
    case "reader":
      return [
        item("copy", strings.contextMenu.copy, { icon: "copy" }),
        item("copy-message-text", strings.reader.copyMessageText, {
          icon: "copy",
        }),
        item("copy-subject", strings.reader.copySubject, { icon: "copy" }),
        item("copy-sender-address", strings.reader.copySenderAddress, {
          icon: "copy",
        }),
        item("find-in-message", strings.reader.findInMessage, {
          icon: "find",
        }),
        item("print", strings.reader.print, { icon: "print" }),
      ];
    case "link":
      return [
        item("open-link", strings.contextMenu.openLink, { icon: "open-link" }),
        item("copy-link", strings.contextMenu.copyLink, { icon: "copy-link" }),
      ];
    case "mailto":
      return [
        item("open", strings.contextMenu.open, { icon: "compose" }),
        item("copy-address", strings.reader.copyAddress, {
          icon: "copy-address",
        }),
      ];
    case "attachment": {
      const items: ContextMenuItem[] = [];
      if (target.previewable) {
        items.push(
          item("preview", strings.reader.preview, { icon: "preview" }),
        );
      }
      items.push(
        item("download", strings.reader.downloadFile, { icon: "download" }),
      );
      return items;
    }
    case "address":
      return addressItems(target.address);
    case "composer":
      return editItems(true);
    case "editable":
      return editItems(false);
    case "composer-attachment":
      return [
        item("remove-attachment", strings.common.remove, {
          icon: "remove",
        }),
      ];
  }
}

export function iframeTargetFromDetail(
  detail: IframeContextMenuDetail,
): ContextMenuTarget {
  if (detail.href) {
    return detail.text
      ? { kind: "link", href: detail.href, text: detail.text }
      : { kind: "link", href: detail.href };
  }
  if (detail.mailto) return { kind: "mailto", href: detail.mailto };
  return { kind: "reader" };
}
