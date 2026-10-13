import type { Page } from "@playwright/test";
import type { MockMessageSummary, MockShared, MockState } from "./context";

// Message listing, fetching, flagging, moving, bulk actions, and sync.
// The init script below is stringified into the page, so keep it
// self-contained: type-only imports, locals, and browser globals only.
export async function registerMockMessages(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as MockShared;
    const state = window.__POSTAL_SNAP_TEST__ as MockState;
    const { mailboxes, summary, olderSummary, secondSummary, params } = mock;
    let paginatedCursorConsumed = false;
    const threadGapItems = () => [
      {
        ...summary,
        threadRoot: "<weekend@example.com>",
        toMe: true,
        isRead: params.has("threadRead")
          ? true
          : params.has("threadUnread")
            ? true
            : summary.isRead,
      },
      {
        ...summary,
        id: 30,
        uid: 50,
        messageId: "<solo@example.com>",
        subject: "Library hours",
        receivedAt: "2026-08-17T18:00:00Z",
        hasCalendar: false,
        threadRoot: null,
        pinned: params.has("pinned"),
        isRead: params.has("mixedRead") || summary.isRead,
      },
      {
        ...olderSummary,
        senderName: params.has("threadPeople")
          ? "Lee"
          : olderSummary.senderName,
        senderAddress: params.has("threadPeople")
          ? "lee@example.com"
          : olderSummary.senderAddress,
        threadRoot: "<weekend@example.com>",
        isRead: params.has("threadRead")
          ? true
          : params.has("threadUnread")
            ? false
            : olderSummary.isRead,
      },
    ];
    const trashThreadItems = () => [
      {
        ...summary,
        id: 41,
        uid: 41,
        mailboxId: 3,
        messageId: "<receipt-new@example.com>",
        threadRoot: "<receipt@example.com>",
        subject: "Old receipt",
        isRead: false,
      },
      {
        ...olderSummary,
        id: 42,
        uid: 42,
        mailboxId: 3,
        messageId: "<receipt-old@example.com>",
        threadRoot: "<receipt@example.com>",
        subject: "Older receipt",
        isRead: true,
      },
      {
        ...summary,
        id: 43,
        uid: 43,
        mailboxId: 3,
        messageId: "<keep@example.com>",
        threadRoot: null,
        subject: "Keep this",
        receivedAt: "2026-08-16T12:00:00Z",
        isRead: true,
      },
    ];
    Object.assign(mock.handlers, {
      save_chosen_attachments() {
        return 1;
      },
      list_messages(args: Record<string, unknown>) {
        let page: {
          items: MockMessageSummary[];
          nextCursor: unknown;
          hasMore: boolean;
        };
        if (state.moved || params.has("empty")) {
          page = { items: [], nextCursor: null, hasMore: false };
        } else if (params.has("earlier") && Number(args.mailboxId) === 3) {
          page = {
            items: [
              {
                ...olderSummary,
                id: 91,
                mailboxId: 3,
                messageId: "<older@example.com>",
                subject: "Earlier note",
                isRead: true,
              },
            ],
            nextCursor: null,
            hasMore: false,
          };
        } else if (params.has("threadGap")) {
          // `?threadGap=1`: a solo message between two replies of one thread.
          page = { items: threadGapItems(), nextCursor: null, hasMore: false };
        } else if (params.has("trashThread") && Number(args.mailboxId) === 3) {
          page = {
            items: trashThreadItems(),
            nextCursor: null,
            hasMore: false,
          };
        } else if (params.has("hugeList")) {
          const count = Number(params.get("hugeList")) || 1500;
          page = {
            items: Array.from({ length: count }, (_, index) => ({
              ...summary,
              id: 5000 + index,
              uid: 5000 + index,
              messageId: `<huge-${index}@example.com>`,
              subject: `Archive note ${index + 1}`,
              receivedAt: new Date(
                Date.parse("2026-08-01T12:00:00Z") - index * 600_000,
              ).toISOString(),
              isRead: true,
              threadRoot: null,
            })),
            nextCursor: null,
            hasMore: false,
          };
        } else if (params.has("longList")) {
          const older = Array.from({ length: 24 }, (_, index) => ({
            ...summary,
            id: 200 + index,
            uid: 200 + index,
            messageId: `<older-${index}@example.com>`,
            subject: `Older note ${index + 1}`,
            receivedAt: new Date(
              Date.parse("2026-08-01T12:00:00Z") - index * 3_600_000,
            ).toISOString(),
            isRead: true,
            threadRoot: null,
          }));
          page = {
            items: [...(mock.arrivedMessages ?? []), ...older],
            nextCursor: null,
            hasMore: false,
          };
        } else if (location.search.includes("pagination")) {
          if (!args.cursor) {
            page = {
              items: [summary],
              nextCursor: {
                receivedAt: summary.receivedAt,
                uid: summary.uid,
              },
              hasMore: true,
            };
          } else {
            const cursor = args.cursor as {
              receivedAt?: unknown;
              uid?: unknown;
            };
            if (paginatedCursorConsumed) {
              throw new Error(
                "The message list reused a spent pagination cursor.",
              );
            }
            if (
              cursor.receivedAt !== summary.receivedAt ||
              cursor.uid !== summary.uid
            ) {
              throw new Error(
                "The message list sent a cursor that did not round-trip from the previous page.",
              );
            }
            paginatedCursorConsumed = true;
            page = { items: [olderSummary], nextCursor: null, hasMore: false };
          }
        } else if (params.has("folderViews") && Number(args.mailboxId) === 2) {
          page = {
            items: [
              {
                ...summary,
                id: 12,
                uid: 12,
                mailboxId: 2,
                messageId: "<filed@example.com>",
                subject: "Filed note",
                isRead: true,
                threadRoot: null,
              },
            ],
            nextCursor: null,
            hasMore: false,
          };
        } else if (params.has("folderViews")) {
          page = {
            items: [
              summary,
              {
                ...summary,
                id: 11,
                uid: 11,
                messageId: "<read-note@example.com>",
                subject: "Read note",
                receivedAt: "2026-08-17T12:00:00Z",
                isRead: true,
                threadRoot: null,
              },
            ],
            nextCursor: null,
            hasMore: false,
          };
        } else {
          page = {
            items: [
              args.accountId === secondSummary.accountId
                ? secondSummary
                : summary,
            ],
            nextCursor: null,
            hasMore: false,
          };
        }
        if (typeof args.sort === "string" && args.sort !== "date") {
          const sort = args.sort;
          const field = (item: { id: number }, name: string) =>
            name in item
              ? String((item as Record<string, unknown>)[name] ?? "")
              : "";
          page = {
            ...page,
            items: [...page.items].sort((left, right) => {
              if (sort === "dateOldest") {
                const leftAt = field(left, "receivedAt");
                const rightAt = field(right, "receivedAt");
                return leftAt < rightAt ? -1 : leftAt > rightAt ? 1 : 0;
              }
              if (sort === "size" || sort === "sizeAsc") {
                const leftSize = Number(field(left, "size")) || 0;
                const rightSize = Number(field(right, "size")) || 0;
                const delta = leftSize - rightSize;
                return sort === "size" ? -delta : delta;
              }
              const name = sort.startsWith("sender") ? "senderName" : "subject";
              const compared = field(left, name).localeCompare(
                field(right, name),
                undefined,
                { sensitivity: "base" },
              );
              const descending =
                sort === "senderDesc" || sort === "subjectDesc";
              return descending ? -compared : compared;
            }),
          };
        }
        if (params.has("folderViews") && args.filter === "unread") {
          page = {
            ...page,
            items: page.items.filter(
              (item) =>
                "isRead" in item &&
                (item as { isRead?: boolean }).isRead !== true,
            ),
          };
        }
        if (args.filter === "invitations") {
          page = {
            ...page,
            items: page.items.filter(
              (item) =>
                "hasCalendar" in item &&
                (item as { hasCalendar?: boolean }).hasCalendar === true,
            ),
          };
        }
        if (args.filter === "pinned") {
          page = {
            ...page,
            items: page.items.filter(
              (item) =>
                "pinned" in item &&
                (item as { pinned?: boolean }).pinned === true,
            ),
          };
        }
        const hidden = state.snoozedIds ?? [];
        if (hidden.length === 0) return page;
        return {
          ...page,
          items: page.items.filter((item) => !hidden.includes(item.id)),
        };
      },
      find_cached_message() {
        if (!params.has("earlier")) return null;
        return {
          ...olderSummary,
          id: 91,
          mailboxId: 3,
          messageId: "<older@example.com>",
          subject: "Earlier note",
          isRead: true,
        };
      },
      get_message(args: Record<string, unknown>) {
        if (params.has("oversize")) {
          throw {
            code: "limitExceeded",
            message: "That item exceeds Postal Snap's safety limit.",
            retryable: false,
          };
        }
        const earlierHit =
          args.messageId === 91
            ? {
                ...olderSummary,
                id: 91,
                mailboxId: 3,
                messageId: "<older@example.com>",
                subject: "Earlier note",
                isRead: true,
              }
            : undefined;
        const trashHit = params.has("trashThread")
          ? trashThreadItems().find((item) => item.id === args.messageId)
          : undefined;
        const selected = earlierHit
          ? earlierHit
          : trashHit
            ? trashHit
            : params.has("threadGap")
              ? (threadGapItems().find((item) => item.id === args.messageId) ??
                summary)
              : args.accountId === secondSummary.accountId
                ? secondSummary
                : summary;
        if (params.has("bodyOffline")) {
          return {
            ...selected,
            to: [selected.recipients],
            cc: [],
            replyTo: null,
            textBody: "",
            htmlBody: null,
            remoteImagesBlocked: false,
            references: [],
            attachments: [],
            bodyStatus: "offline",
          };
        }
        if (params.has("blankHtml")) {
          return {
            ...selected,
            to: [selected.recipients],
            cc: [],
            replyTo: null,
            textBody: "Plain part is still readable.",
            htmlBody: "\n  <div> </div>\n",
            remoteImagesBlocked: false,
            references: [],
            attachments: [],
          };
        }
        // Two bodies whose raw size is far past the forward limit.
        if (params.has("hugeThread")) {
          return {
            ...selected,
            to: [selected.recipients],
            cc: [],
            bcc: [],
            replyTo: null,
            textBody: "",
            htmlBody: `<p>${"Long line. ".repeat(55_000)}</p>`,
            remoteImagesBlocked: false,
            dispositionTo: "",
            listPost: null,
            receiptChoice: "",
            references: [],
            attachments: [],
          };
        }
        const fromSelf = params.has("fromSelf");
        return {
          ...selected,
          to: params.has("manyTo")
            ? [
                "jane@example.com",
                "lee@example.com",
                "pat@example.com",
                "sam@icloud.com",
              ]
            : params.get("addressed") === "alias"
              ? ["Work <work@example.com>"]
              : params.get("addressed") === "cc" ||
                  params.get("addressed") === "none"
                ? ["lee@example.com"]
                : params.has("groupReply")
                  ? ["sam@icloud.com", "lee@example.com"]
                  : [selected.recipients],
          cc:
            params.get("addressed") === "cc"
              ? ["work@example.com"]
              : fromSelf
                ? ["lee@example.com", "sam@icloud.com"]
                : params.has("groupReply")
                  ? ["pat@example.com"]
                  : [],
          bcc: params.has("bcc") ? ["hidden@example.com"] : [],
          arrivedAt: params.has("arrived")
            ? "2026-08-18T18:00:00Z"
            : selected.receivedAt,
          // IMAP ENVELOPE fills Reply-To from From when it is absent.
          replyTo: params.has("replyTo")
            ? "replies@example.com"
            : fromSelf
              ? "sam@icloud.com"
              : null,
          textBody: "Are we still meeting on Saturday?",
          htmlBody: location.search.includes("mismatchLink")
            ? '<p><a href="https://phish.example.test/login">https://bank.example/login</a></p>'
            : location.search.includes("threatLink")
              ? '<p><a href="https://phish.example.test/login">Open site</a></p>'
              : location.search.includes("webLink")
                ? '<p><a href="https://library.example.test/hours">Open site</a></p>'
                : location.search.includes("credentialLink")
                  ? '<p><a href="https://trusted.example@phish.example.test/login">Open site</a></p>'
                  : params.has("wideHtml")
                    ? // Fixed-width newsletter layout, like Apple's welcome mail.
                      `<table width="${params.get("wideHtml")}" style="width:${params.get("wideHtml")}px"><tr><td><h1 style="font-size:40px">Welcome to iCloud Mail.</h1><p>Your email address is someone@icloud.com. You can access your inbox on any iPhone, iPad, or Mac.</p></td></tr></table>`
                    : location.search.includes("remote")
                      ? '<p>Are we still meeting?</p><img src="https://images.example.test/pixel.png">'
                      : location.search.includes("inline")
                        ? '<p>Photo:</p><img src="cid:family-photo@example.test">'
                        : location.search.includes("plainOnly")
                          ? null
                          : location.search.includes("styledMail")
                            ? '<table bgcolor="#ffffff"><tr><td style="color: #333333">Designed newsletter</td></tr></table>'
                            : params.has("findTwice")
                              ? "<p>Saturday morning</p><p>Saturday evening</p>"
                              : params.has("longLetter") &&
                                  selected.id === summary.id
                                ? Array.from(
                                    { length: 40 },
                                    (_, index) =>
                                      `<p>Line ${index + 1} of the long letter.</p>`,
                                  ).join("")
                                : "<p>Are we still meeting on Saturday?</p>",
          remoteImagesBlocked: false,
          dispositionTo: params.has("readReceipt") ? "jane@example.com" : "",
          listPost: params.has("listMail") ? "list@example.test" : null,
          receiptChoice: "",
          references:
            params.has("earlier") || params.has("earlierMissing")
              ? ["<older@example.com>"]
              : [],
          attachments: location.search.includes("inline")
            ? [
                {
                  id: "inline-1",
                  filename: "family.png",
                  contentType: "image/png",
                  size: 128,
                  contentId: "<family-photo@example.test>",
                  inline: true,
                },
              ]
            : location.search.includes("previewable")
              ? [
                  {
                    id: "attach-1",
                    filename: "family.png",
                    contentType: "image/png",
                    size: 128,
                    contentId: null,
                    inline: false,
                  },
                  ...(params.has("filePair")
                    ? [
                        {
                          id: "attach-2",
                          filename: "notes.txt",
                          contentType: "text/plain",
                          size: 64,
                          contentId: null,
                          inline: false,
                        },
                      ]
                    : []),
                ]
              : [],
        };
      },
      send_read_receipt() {
        return "sent";
      },
      decline_read_receipt() {
        return "declined";
      },
      set_messages_pinned(args: Record<string, unknown>) {
        const ids = args.messageIds;
        return Array.isArray(ids) ? ids.length : 0;
      },
      set_message_flags(args: Record<string, unknown>) {
        if (typeof args.isRead === "boolean") {
          const wasRead = summary.isRead;
          summary.isRead = args.isRead;
          if (wasRead !== summary.isRead)
            mailboxes[0].unreadCount = Math.max(
              0,
              mailboxes[0].unreadCount + (summary.isRead ? -1 : 1),
            );
        }
        if (typeof args.isStarred === "boolean")
          summary.isStarred = args.isStarred;
        return undefined;
      },
      mute_conversation(args: Record<string, unknown>) {
        state.muted = {
          accountId: String(args.accountId),
          messageId: Number(args.messageId),
        };
        mailboxes[0].totalCount = 0;
        mailboxes[0].unreadCount = 0;
        return [summary.id];
      },
      unmute_conversation(args: Record<string, unknown>) {
        state.unmuted = Number(args.messageId);
        return undefined;
      },
      move_message_to_mailbox() {
        return undefined;
      },
      move_message() {
        state.moved = true;
        mailboxes[0].totalCount = 0;
        mailboxes[0].unreadCount = 0;
        mailboxes[1].totalCount = 1;
        mailboxes[1].unreadCount = summary.isRead ? 0 : 1;
        return summary.id + 1000;
      },
      set_messages_flags(args: Record<string, unknown>) {
        const ids = (args.messageIds ?? []) as number[];
        if (args.isRead === true) summary.isRead = true;
        return { updated: ids.length, queued: 0, failed: 0 };
      },
      copy_messages_to_mailbox(args: Record<string, unknown>) {
        return {
          updated: ((args.messageIds ?? []) as number[]).length,
          queued: 0,
          failed: 0,
        };
      },
      move_messages_to_mailbox(args: Record<string, unknown>) {
        state.moved = true;
        return {
          updated: ((args.messageIds ?? []) as number[]).length,
          queued: 0,
          failed: 0,
        };
      },
      mark_mailbox_read(args: Record<string, unknown>) {
        const mailbox = mailboxes.find(
          (item) => item.id === Number(args.mailboxId),
        );
        if (mailbox) mailbox.unreadCount = 0;
        if (!mailbox || mailbox.role === "inbox") {
          summary.isRead = true;
          if (mailboxes[0]) mailboxes[0].unreadCount = 0;
        }
        return { updated: 1, queued: 0, failed: 0 };
      },
      sync_account() {
        return undefined;
      },
      sync_all_accounts() {
        // ?syncAddsMail: new unread arrives on the second account.
        if (params.has("syncAddsMail")) {
          const inbox = mock.mailboxes.find((item) => item.id === 21);
          if (inbox) inbox.unreadCount += 2;
        }
        // ?syncAllPartial: only the first account refreshes.
        return mock.accounts
          .filter((_, index) => !params.has("syncAllPartial") || index === 0)
          .map((account) => account.id);
      },
      release_compose_attachments() {
        return undefined;
      },
    });
  });
}
