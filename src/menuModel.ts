// One ordered message menu shared by the row context menu and the reader
// More menu. Callers supply facts and a kit; this module owns order and labels.
import { strings } from "./i18n";
import { formatChord } from "./format";
import type { ContextMenuIcon } from "./contextMenu";
import type { MailboxRole } from "./types";

export type FolderKind =
  "move" | "copy" | "move-conversation" | "copy-conversation";

export interface MenuFolder {
  id: number;
  name: string;
  role: MailboxRole;
}

export interface EntryDef {
  id: string;
  label: string;
  icon?: ContextMenuIcon;
  ariaLabel?: string;
  chord?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Reader-only: close the whole More menu instead of its submenu. */
  dismiss?: boolean;
}

/** Each kit method returns entry fragments; an empty array means "not offered". */
export interface MenuKit<E> {
  item(def: EntryDef): E[];
  folder(kind: FolderKind, folder: MenuFolder): E[];
  /** hideHeading keeps the group named for assistive tech, without a visible label. */
  group(label: string, entries: E[], hideHeading?: boolean): E[];
  submenu(id: string, label: string, entries: E[]): E[];
  separator(): E[];
}

export interface MessageMenuFacts {
  isRead: boolean;
  isStarred: boolean;
  pinned: boolean;
  canMute: boolean;
  conversationMuted: boolean;
  /** Mailbox role of the message; drives archive/junk/trash wording. */
  mailboxRole?: MailboxRole;
  /** More than one message in the conversation. */
  conversation: boolean;
  conversationUnread: boolean;
  conversationRead: boolean;
  conversationHasUnstarred: boolean;
  conversationHasUnpinned: boolean;
  conversationHasAttachments: boolean;
  hasAttachments: boolean;
  hasSender: boolean;
  hasSubject: boolean;
  hasRecipients: boolean;
  senderRule: boolean;
  subjectRule: boolean;
  senderSearch: boolean;
  subjectSearch: boolean;
  selectFromSender: boolean;
  openEarlier: boolean;
  blockSender?: "block" | "unblock";
  blockDomain?: "block" | "unblock";
  unsubscribe: boolean;
  /** Label of the plain/formatted toggle, when the reader offers it. */
  plainToggle?: "view" | "formatted";
  showOriginal: boolean;
  /** Older, newer and unread-in-conversation navigation (reader only). */
  conversationNav: boolean;
  /** Reply and forward still await a prepared draft. */
  preparing: boolean;
  moveFolders: MenuFolder[];
  /** The reader toolbar already shows these, so the More menu omits them. */
  inToolbar: { primary: boolean; archiveTrash: boolean };
}

/** Ordered message menu: state, move, options, then the conversation and sender groups. */
export function buildMessageMenu<E>(f: MessageMenuFacts, kit: MenuKit<E>): E[] {
  const defs = (...list: Array<EntryDef | false | undefined>): E[] =>
    list.flatMap((def) => (def ? kit.item(def) : []));
  const folders = (
    kind: FolderKind,
    label: string,
    list: MenuFolder[],
    hideHeading = false,
  ) => {
    const rows = list.flatMap((folder) => kit.folder(kind, folder));
    return rows.length > 0 ? kit.group(label, rows, hideHeading) : [];
  };
  const submenu = (id: string, label: string, entries: E[]) =>
    entries.length > 0 ? kit.submenu(id, label, entries) : [];
  // Separators only between non-empty parts, so none dangle at an edge.
  const joinParts = (parts: E[][]): E[] =>
    parts
      .filter((part) => part.length > 0)
      .flatMap((part, index) =>
        index === 0 ? part : [...kit.separator(), ...part],
      );
  const isArchive = f.mailboxRole === "archive";
  const isJunk = f.mailboxRole === "junk";
  const isTrash = f.mailboxRole === "trash";
  const hasFolders = f.moveFolders.length > 0;

  // Group 1: replies and forward.
  const primary = f.inToolbar.primary
    ? []
    : defs(
        {
          id: "reply",
          label: strings.reader.reply,
          icon: "reply",
          chord: formatChord("R"),
        },
        {
          id: "reply-all",
          label: strings.reader.replyAll,
          icon: "reply-all",
          chord: formatChord("R", { shift: true }),
        },
        {
          id: "forward",
          label: strings.reader.forward,
          icon: "forward",
          chord: formatChord("F", { shift: true }),
        },
      );

  // Group 2: read, star, pin, snooze, mute.
  const state = defs(
    f.isRead
      ? {
          id: "toggle-read",
          label: strings.reader.markUnread,
          icon: "mark-unread",
          chord: formatChord("U", { shift: true }),
        }
      : {
          id: "toggle-read",
          label: strings.reader.markRead,
          icon: "mark-read",
          chord: formatChord("U", { shift: true }),
        },
    f.isStarred
      ? {
          id: "toggle-star",
          label: strings.reader.removeStar,
          icon: "unstar",
          chord: formatChord("L", { shift: true }),
        }
      : {
          id: "toggle-star",
          label: strings.reader.addStar,
          icon: "star",
          chord: formatChord("L", { shift: true }),
        },
    f.pinned
      ? { id: "unpin", label: strings.reader.unpin, icon: "unpin" }
      : { id: "pin", label: strings.reader.pin, icon: "pin" },
    {
      id: "snooze",
      label: strings.reader.snooze,
      icon: "snooze",
      dismiss: true,
    },
    f.canMute &&
      (f.conversationMuted
        ? {
            id: "mute-conversation",
            label: strings.reader.unmuteConversation,
            icon: "unmute",
            dismiss: true,
          }
        : {
            id: "mute-conversation",
            label: strings.reader.muteConversation,
            icon: "mute",
            dismiss: true,
          }),
  );

  // Group 3: archive, move, junk, trash.
  const move = [
    ...(f.inToolbar.archiveTrash
      ? []
      : defs(
          isArchive
            ? {
                id: "move-to-inbox",
                label: strings.reader.moveToInbox,
                icon: "inbox",
              }
            : {
                id: "archive",
                label: strings.reader.archive,
                icon: "archive",
                chord: formatChord("E"),
              },
        )),
    // The submenu label already names these folders, so no visible heading.
    ...(hasFolders
      ? submenu(
          "move-to",
          strings.contextMenu.moveTo,
          joinParts([
            folders("move", strings.contextMenu.moveTo, f.moveFolders, true),
            f.conversation
              ? folders(
                  "move-conversation",
                  strings.contextMenu.moveConversationTo,
                  f.moveFolders,
                )
              : [],
          ]),
        )
      : []),
    ...defs(
      isJunk
        ? {
            id: "not-junk",
            label: strings.reader.notJunk,
            icon: "not-junk",
            dismiss: true,
          }
        : {
            id: "junk",
            label: strings.reader.junk,
            icon: "junk",
            chord: formatChord("J", { shift: true }),
            dismiss: true,
          },
    ),
    ...(f.inToolbar.archiveTrash
      ? []
      : defs(
          isTrash
            ? {
                id: "delete-forever",
                label: strings.mail.deleteForever,
                icon: "trash",
                danger: true,
              }
            : {
                id: "trash",
                label: strings.reader.trash,
                icon: "trash",
                chord: formatChord("⌫"),
              },
        )),
  ];

  // Group 4: reply, forward, copy, print, save.
  const replyOptions = defs(
    {
      id: "reply-bare",
      label: strings.reader.replyWithoutQuoting,
      icon: "reply",
    },
    {
      id: "reply-all-bare",
      label: strings.reader.replyAllWithoutQuoting,
      icon: "reply-all",
    },
    f.hasAttachments && {
      id: "reply-with-attachments",
      label: f.preparing
        ? strings.reader.preparing
        : strings.reader.replyWithAttachments,
      icon: "attach",
      disabled: f.preparing,
    },
    f.hasAttachments && {
      id: "reply-all-with-attachments",
      label: f.preparing
        ? strings.reader.preparing
        : strings.reader.replyAllWithAttachments,
      icon: "attach",
      disabled: f.preparing,
    },
    { id: "redirect", label: strings.reader.redirect, icon: "redirect" },
    {
      id: "edit-as-new",
      label: f.preparing ? strings.reader.preparing : strings.reader.editAsNew,
      icon: "compose",
      disabled: f.preparing,
    },
    f.hasSender && {
      id: "compose-to-sender",
      label: strings.reader.newMessageToSender,
      icon: "compose",
      dismiss: true,
    },
  );
  const forwardOptions = defs(
    f.conversation && {
      id: "forward-conversation",
      label: strings.reader.forwardConversation,
      icon: "forward",
    },
    {
      id: "forward-attachment",
      label: f.preparing
        ? strings.reader.preparing
        : strings.reader.forwardAsAttachment,
      icon: "attach",
      disabled: f.preparing,
    },
  );
  const copyOptions = joinParts([
    defs(
      {
        id: "copy-message-text",
        label: strings.reader.copyMessageText,
        icon: "copy",
      },
      f.hasSubject && {
        id: "copy-subject",
        label: strings.reader.copySubject,
        icon: "copy",
      },
      f.hasSender && {
        id: "copy-sender-address",
        label: strings.reader.copySenderAddress,
        icon: "copy",
      },
      f.hasRecipients && {
        id: "copy-recipients",
        label: strings.reader.copyRecipients,
        icon: "copy",
      },
      f.conversation && {
        id: "copy-conversation-text",
        label: strings.reader.copyConversationText,
        icon: "copy",
      },
    ),
    folders("copy", strings.contextMenu.copyTo, f.moveFolders),
    f.conversation
      ? folders(
          "copy-conversation",
          strings.contextMenu.copyConversationTo,
          f.moveFolders,
        )
      : [],
  ]);
  const printOptions = defs(
    {
      id: "print",
      label: strings.reader.print,
      icon: "print",
      chord: formatChord("P"),
    },
    f.conversation && {
      id: "print-conversation",
      label: strings.reader.printConversation,
      icon: "print",
    },
  );
  const options = [
    ...submenu("reply-options", strings.contextMenu.replyOptions, replyOptions),
    ...submenu(
      "forward-options",
      strings.contextMenu.forwardOptions,
      forwardOptions,
    ),
    ...submenu("copy-options", strings.contextMenu.copyOptions, copyOptions),
    ...submenu("print-options", strings.contextMenu.printOptions, printOptions),
    ...defs({
      id: "save-eml",
      label: strings.reader.saveEml,
      icon: "download",
      dismiss: true,
    }),
  ];

  // Group 5: conversation and sender submenus, then reader-only extras.
  const conversationOptions = [
    ...defs(
      f.conversation &&
        f.conversationUnread && {
          id: "mark-conversation-read",
          label: strings.reader.markConversationRead,
          icon: "mark-all-read",
        },
      f.conversation &&
        f.conversationRead && {
          id: "mark-conversation-unread",
          label: strings.reader.markConversationUnread,
          icon: "mark-unread",
        },
      f.conversation &&
        (f.conversationHasUnstarred
          ? {
              id: "star-conversation",
              label: strings.reader.starConversation,
              icon: "star",
            }
          : {
              id: "unstar-conversation",
              label: strings.reader.unstarConversation,
              icon: "unstar",
            }),
      f.conversation &&
        (f.conversationHasUnpinned
          ? {
              id: "pin-conversation",
              label: strings.reader.pinConversation,
              icon: "pin",
            }
          : {
              id: "unpin-conversation",
              label: strings.reader.unpinConversation,
              icon: "unpin",
            }),
      f.conversation && {
        id: "select-conversation",
        label: strings.reader.selectConversation,
        icon: "select-all",
      },
      f.conversation && {
        id: "snooze-conversation",
        label: strings.reader.snoozeConversation,
        icon: "snooze",
        dismiss: true,
      },
      f.conversationNav && {
        id: "older-in-conversation",
        label: strings.reader.olderInConversation,
        icon: "older",
      },
      f.conversationNav && {
        id: "newer-in-conversation",
        label: strings.reader.newerInConversation,
        icon: "newer",
      },
      f.conversationNav && {
        id: "unread-in-conversation",
        label: strings.reader.unreadInConversation,
        icon: "mark-read",
      },
      f.conversation &&
        (isArchive
          ? {
              id: "move-conversation-inbox",
              label: strings.reader.moveConversationToInbox,
              icon: "inbox",
            }
          : {
              id: "archive-conversation",
              label: strings.reader.archiveConversation,
              icon: "archive",
            }),
      f.conversation &&
        (isJunk
          ? {
              id: "move-conversation-inbox",
              label: strings.reader.moveConversationToInbox,
              icon: "inbox",
            }
          : {
              id: "junk-conversation",
              label: strings.reader.junkConversation,
              icon: "junk",
            }),
      f.conversation &&
        (isTrash
          ? {
              id: "delete-conversation",
              label: strings.reader.deleteConversation,
              icon: "trash",
              danger: true,
            }
          : {
              id: "trash-conversation",
              label: strings.reader.trashConversation,
              icon: "trash",
            }),
      f.conversation &&
        f.conversationHasAttachments && {
          id: "save-conversation-files",
          label: strings.reader.saveConversationFiles,
          icon: "download",
        },
    ),
  ];
  const senderOptions = defs(
    f.selectFromSender && {
      id: "select-from-sender",
      label: strings.reader.selectFromSender,
      icon: "select-all",
    },
    f.openEarlier && {
      id: "open-earlier",
      label: strings.reader.openEarlier,
      icon: "open",
    },
    f.senderRule && {
      id: "create-rule",
      label: strings.reader.createRuleFromSender,
      icon: "filter",
      dismiss: true,
    },
    f.subjectRule && {
      id: "create-subject-rule",
      label: strings.reader.createRuleFromSubject,
      icon: "filter",
      dismiss: true,
    },
    f.senderSearch && {
      id: "messages-from-sender",
      label: strings.reader.messagesFromSender,
      icon: "find",
      dismiss: true,
    },
    f.subjectSearch && {
      id: "messages-with-subject",
      label: strings.reader.messagesWithSubject,
      icon: "find",
      dismiss: true,
    },
    f.blockSender === "unblock" && {
      id: "unblock-sender",
      label: strings.reader.unblockSender,
      icon: "not-junk",
      dismiss: true,
    },
    f.blockSender === "block" && {
      id: "block-sender",
      label: strings.reader.blockSender,
      icon: "junk",
      dismiss: true,
    },
    f.blockDomain === "unblock" && {
      id: "unblock-domain",
      label: strings.reader.unblockDomain,
      icon: "not-junk",
      dismiss: true,
    },
    f.blockDomain === "block" && {
      id: "block-domain",
      label: strings.reader.blockDomain,
      icon: "junk",
      dismiss: true,
    },
    f.unsubscribe && {
      id: "unsubscribe",
      label: strings.reader.unsubscribe,
      icon: "unsubscribe",
      dismiss: true,
    },
  );
  const tail = [
    ...submenu(
      "conversation",
      strings.contextMenu.conversationOptions,
      conversationOptions,
    ),
    ...submenu(
      "sender-options",
      strings.contextMenu.senderOptions,
      senderOptions,
    ),
    ...defs(
      f.plainToggle && {
        id: "view-plain",
        label:
          f.plainToggle === "formatted"
            ? strings.reader.viewFormatted
            : strings.reader.viewPlain,
        icon: "plain-text",
        dismiss: true,
      },
      f.showOriginal && {
        id: "show-original",
        label: strings.reader.showOriginal,
        icon: "source",
        dismiss: true,
      },
    ),
  ];

  const groups = [primary, state, move, options, tail].filter(
    (entries) => entries.length > 0,
  );
  return groups.flatMap((entries, index) =>
    index === 0 ? entries : [...kit.separator(), ...entries],
  );
}
