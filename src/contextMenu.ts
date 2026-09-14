import { strings } from "./i18n";
import { useAppStore } from "./store";
import type { MailboxSummary, MessageSummary, OutboxSummary } from "./types";

export const CONTEXT_ACTION_EVENT = "postal:context-action";
export const IFRAME_CONTEXT_EVENT = "postal:iframe-contextmenu";

export type LocalMailView = "drafts" | "outbox" | "snoozed";

export type ContextMenuTarget =
  | { kind: "suppress" }
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

export type ContextMenuItem =
  | { type: "separator" }
  | {
      type: "item";
      id: string;
      label: string;
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
  extra?: { disabled?: boolean; danger?: boolean },
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
    item("reply", strings.reader.reply),
    item("reply-all", strings.reader.replyAll),
    item("forward", strings.reader.forward),
    { type: "separator" },
    item(
      "toggle-read",
      message.isRead ? strings.reader.markUnread : strings.reader.markRead,
    ),
    item(
      "toggle-star",
      message.isStarred ? strings.reader.removeStar : strings.reader.addStar,
    ),
    item("archive", strings.reader.archive, {
      disabled: mailbox?.role === "archive",
    }),
    item(
      mailbox?.role === "junk" ? "not-junk" : "junk",
      mailbox?.role === "junk" ? strings.reader.notJunk : strings.reader.junk,
    ),
    item("trash", strings.reader.trash, {
      disabled: mailbox?.role === "trash",
    }),
    item("snooze", strings.reader.snooze),
  ];
  const destinations = mailboxes.filter((box) => box.id !== message.mailboxId);
  if (destinations.length > 0) {
    items.push({ type: "separator" });
    for (const box of destinations) {
      items.push(
        item(
          `move-mailbox:${box.id}`,
          `${strings.reader.move} ${box.displayName}`,
        ),
      );
    }
  }
  return items;
}

function folderItems(mailbox: MailboxSummary): ContextMenuItem[] {
  const items: ContextMenuItem[] = [item("open", strings.contextMenu.open)];
  if (mailbox.role === "trash" && mailbox.totalCount > 0) {
    items.push(item("empty-trash", strings.mail.emptyTrash, { danger: true }));
  }
  if (mailbox.role === "junk" && mailbox.totalCount > 0) {
    items.push(item("empty-junk", strings.mail.emptyJunk, { danger: true }));
  }
  if (mailbox.role === "other") {
    items.push(item("rename-folder", strings.mail.rename));
    items.push(
      item("delete-folder", strings.mail.deleteFolder, { danger: true }),
    );
  }
  return items;
}

function outboxItems(row: OutboxSummary): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (row.state === "needs_attention") {
    items.push(item("retry", strings.mail.retrySending));
  } else if (row.state === "sent_copy_pending") {
    items.push(item("retry-copy", strings.mail.saveSentCopy));
  } else if (row.state === "scheduled") {
    items.push(item("send-now", strings.mail.sendNow));
  }
  items.push(
    item(
      "discard",
      row.state === "sent_copy_pending"
        ? strings.mail.dismissWarning
        : row.state === "scheduled"
          ? strings.mail.undoSend
          : strings.common.discard,
      { danger: row.state !== "sent_copy_pending" },
    ),
  );
  return items;
}

const editItems: ContextMenuItem[] = [
  item("undo", strings.composer.undo),
  item("redo", strings.composer.redo),
  item("cut", strings.contextMenu.cut),
  item("copy", strings.contextMenu.copy),
  item("paste", strings.contextMenu.paste),
  item("select-all", strings.contextMenu.selectAll),
];

export function itemsForTarget(target: ContextMenuTarget): ContextMenuItem[] {
  const state = useAppStore.getState();
  switch (target.kind) {
    case "suppress":
      return [];
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
      return [item("open", strings.contextMenu.open)];
    case "draft":
      return [item("open", strings.contextMenu.open)];
    case "outbox": {
      const row = state.outbox.find((entry) => entry.id === target.outboxId);
      return row ? outboxItems(row) : [];
    }
    case "snoozed":
      return [
        item("open", strings.contextMenu.open),
        item("unsnooze", strings.mail.unsnooze),
      ];
    case "reader":
      return [
        item("find-in-message", strings.reader.findInMessage),
        item("print", strings.reader.print),
      ];
    case "link":
      return [
        item("open-link", strings.contextMenu.openLink),
        item("copy-link", strings.contextMenu.copyLink),
      ];
    case "mailto":
      return [
        item("open", strings.contextMenu.open),
        item("copy-address", strings.reader.copyAddress),
      ];
    case "attachment": {
      const items: ContextMenuItem[] = [];
      if (target.previewable) {
        items.push(item("preview", strings.reader.preview));
      }
      items.push(item("download", strings.reader.downloadFile));
      return items;
    }
    case "address":
      return [item("copy-address", strings.reader.copyAddress)];
    case "composer":
    case "editable":
      return editItems;
    case "composer-attachment":
      return [item("remove-attachment", strings.common.remove)];
  }
}

export function iframeTargetFromDetail(
  detail: IframeContextMenuDetail,
): ContextMenuTarget {
  if (detail.href) return { kind: "link", href: detail.href };
  if (detail.mailto) return { kind: "mailto", href: detail.mailto };
  return { kind: "reader" };
}
