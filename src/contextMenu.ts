import { strings } from "./i18n";
import { folderPathLabel } from "./i18n/mail";
import { useAppStore } from "./store";
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
  | { kind: "link"; href: string }
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
  | "archive"
  | "junk"
  | "not-junk"
  | "trash"
  | "snooze"
  | "unsnooze"
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
  if (/^https?:/i.test(url)) return { kind: "link", href: url };
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

function messageItems(
  message: MessageSummary,
  mailbox: MailboxSummary | undefined,
  mailboxes: MailboxSummary[],
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    item("reply", strings.reader.reply, { icon: "reply" }),
    item("reply-all", strings.reader.replyAll, { icon: "reply-all" }),
    item("forward", strings.reader.forward, { icon: "forward" }),
    { type: "separator" },
    message.isRead
      ? item("toggle-read", strings.reader.markUnread, { icon: "mark-unread" })
      : item("toggle-read", strings.reader.markRead, { icon: "mark-read" }),
    message.isStarred
      ? item("toggle-star", strings.reader.removeStar, { icon: "unstar" })
      : item("toggle-star", strings.reader.addStar, { icon: "star" }),
    item("snooze", strings.reader.snooze, { icon: "snooze" }),
    { type: "separator" },
    item("archive", strings.reader.archive, {
      icon: "archive",
      disabled: mailbox?.role === "archive",
    }),
    mailbox?.role === "junk"
      ? item("not-junk", strings.reader.notJunk, { icon: "not-junk" })
      : item("junk", strings.reader.junk, { icon: "junk" }),
    item("trash", strings.reader.trash, {
      icon: "trash",
      disabled: mailbox?.role === "trash",
    }),
  ];
  // Archive, Junk, and Trash already have direct actions above.
  const destinations = mailboxes.filter(
    (box) =>
      box.id !== message.mailboxId &&
      box.role !== "archive" &&
      box.role !== "junk" &&
      box.role !== "trash",
  );
  if (destinations.length > 0) {
    items.push({ type: "separator" });
    items.push({ type: "heading", label: strings.contextMenu.moveTo });
    for (const box of destinations) {
      const name = folderPathLabel(box);
      items.push(
        item(`move-mailbox:${box.id}`, name, {
          icon: `folder:${box.role}`,
          ariaLabel: strings.contextMenu.moveToFolder(name),
        }),
      );
    }
  }
  return items;
}

function folderItems(mailbox: MailboxSummary): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    item("open", strings.contextMenu.open, { icon: `folder:${mailbox.role}` }),
    item("get-mail", strings.mail.getMail, { icon: "refresh" }),
    item("mark-all-read", strings.mail.markAllRead, {
      icon: "mark-all-read",
      disabled: mailbox.unreadCount === 0,
    }),
    item("new-subfolder", strings.mail.newFolder, { icon: "new-folder" }),
  ];
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
  const items: ContextMenuItem[] = [];
  const busy = row.state === "sending" || outboxRowBusy(row.id);
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

const editItems: ContextMenuItem[] = [
  item("undo", strings.composer.undo, { icon: "undo" }),
  item("redo", strings.composer.redo, { icon: "redo" }),
  { type: "separator" },
  item("cut", strings.contextMenu.cut, { icon: "cut" }),
  item("copy", strings.contextMenu.copy, { icon: "copy" }),
  item("paste", strings.contextMenu.paste, { icon: "paste" }),
  { type: "separator" },
  item("select-all", strings.contextMenu.selectAll, { icon: "select-all" }),
];

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
      return messageItems(message, mailbox, state.mailboxes);
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
      return [
        item("copy-address", strings.reader.copyAddress, {
          icon: "copy-address",
        }),
      ];
    case "composer":
    case "editable":
      return editItems;
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
  if (detail.href) return { kind: "link", href: detail.href };
  if (detail.mailto) return { kind: "mailto", href: detail.mailto };
  return { kind: "reader" };
}
