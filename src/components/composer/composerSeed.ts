import { addressMailbox } from "../../contextMenu";
import { strings } from "../../i18n";
import { sanitizeComposeHtml } from "../../security";
import type { ComposerSeed } from "../../store";
import type { DraftSourceKind, MessageDetail } from "../../types";

/** Address a Reply to list action may use. Empty when the header is unusable. */
export function listPostAddress(
  value: string | null | undefined,
): string | undefined {
  const address = value?.trim() ?? "";
  if (!address || address.length > 200 || !address.includes("@"))
    return undefined;
  if (
    address.includes(" ") ||
    [...address].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    return undefined;
  }
  return address;
}

export function seedRecipients(
  seed: ComposerSeed | undefined,
  field: "to" | "cc",
  accountEmail: string,
  aliases: string[] = [],
): string {
  if (!seed) return "";
  if (seed.draft) return seed.draft[field].join(", ");
  if (seed.prefill?.[field]) return seed.prefill[field]?.join(", ") ?? "";
  const message = seed.sourceMessage;
  if (!message) return "";
  if (
    seed.composeMode === "forward" ||
    seed.composeMode === "forwardAttachment"
  )
    return "";
  if (seed.composeMode === "editAsNew") {
    if (field === "to") return (message.to ?? []).join(", ");
    return (message.cc ?? []).join(", ");
  }
  if (seed.composeMode === "replyList") {
    if (field !== "to") return "";
    return listPostAddress(message.listPost) ?? "";
  }
  const ownAddresses = [accountEmail, ...aliases].map((a) => a.toLowerCase());
  const isOwn = (address?: string | null) =>
    Boolean(address && ownAddresses.includes(address.toLowerCase()));
  const unique = (addresses: string[], excluded: Array<string | null>) => {
    const seen = new Set(excluded.filter(Boolean).map((a) => a!.toLowerCase()));
    return addresses.filter((address) => {
      const key = address.toLowerCase();
      if (isOwn(address) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  // A message the user sent: answer its recipients, like other clients.
  const othersInTo = unique(message.to, []);
  // A note to yourself falls through and replies to you.
  if (isOwn(message.senderAddress) && othersInTo.length > 0) {
    if (field === "to") return othersInTo.join(", ");
    if (seed.composeMode !== "replyAll") return "";
    return unique(message.cc, message.to).join(", ");
  }
  const replyAddress = message.replyTo ?? message.senderAddress;
  if (field === "to") return replyAddress ?? message.to.join(", ");
  if (seed.composeMode !== "replyAll") return "";
  return unique(
    [...message.to, ...message.cc],
    [message.senderAddress, replyAddress ?? null],
  ).join(", ");
}

/** True when Reply all would address someone Reply would leave off. */
export function replyAllAddsRecipients(
  message: MessageDetail,
  accountEmail: string,
  aliases: string[] = [],
): boolean {
  const reply = { sourceMessage: message, composeMode: "reply" as const };
  const everyone = { sourceMessage: message, composeMode: "replyAll" as const };
  const line = (seed: ComposerSeed) =>
    `${seedRecipients(seed, "to", accountEmail, aliases)}\n${seedRecipients(seed, "cc", accountEmail, aliases)}`;
  return line(everyone) !== line(reply);
}

/** People a short reply will address, using the sender's name when it is them. */
export function quickReplyAudience(
  message: MessageDetail,
  replyToAll: boolean,
  accountEmail: string,
  aliases: string[] = [],
): string {
  const mode = preferredReplyMode(message, replyToAll, accountEmail, aliases);
  const seed = { sourceMessage: message, composeMode: mode };
  return [
    seedRecipients(seed, "to", accountEmail, aliases),
    seedRecipients(seed, "cc", accountEmail, aliases),
  ]
    .flatMap((line) =>
      line
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    )
    .map((address) => {
      const mailbox = addressMailbox(address)?.toLowerCase();
      if (
        mailbox &&
        mailbox === message.senderAddress.trim().toLowerCase() &&
        message.senderName.trim()
      ) {
        return message.senderName.trim();
      }
      return addressMailbox(address) ?? address;
    })
    .join(", ");
}

/** Reply includes everyone when that preference is on and a reply would leave people out. */
export function preferredReplyMode(
  message: MessageDetail,
  replyToAll: boolean,
  accountEmail: string,
  aliases: string[] = [],
): "reply" | "replyAll" {
  if (!replyToAll) return "reply";
  return replyAllAddsRecipients(message, accountEmail, aliases)
    ? "replyAll"
    : "reply";
}

/** Adds this account on Bcc when that preference is on and the address is not already listed. */
export function bccSelfLine(
  to: string,
  cc: string,
  bcc: string,
  accountEmail: string,
  enabled: boolean,
): string {
  if (!enabled) return bcc;
  const self = addressMailbox(accountEmail)?.toLowerCase();
  if (!self?.includes("@")) return bcc;
  const listed = [to, cc, bcc].some((field) =>
    field
      .split(",")
      .some((part) => addressMailbox(part)?.toLowerCase() === self),
  );
  if (listed) return bcc;
  const current = bcc.trim();
  const address = accountEmail.trim();
  return current ? `${current}, ${address}` : address;
}

export function seedSubject(seed?: ComposerSeed): string {
  const subject =
    seed?.draft?.subject ??
    seed?.prefill?.subject ??
    seed?.sourceMessage?.subject;
  if (!subject) return "";
  if (
    !seed?.composeMode ||
    seed.composeMode === "editAsNew" ||
    seed.composeMode === "redirect"
  )
    return subject;
  const prefix =
    seed.composeMode === "forward" || seed.composeMode === "forwardAttachment"
      ? strings.composer.forwardPrefix
      : strings.composer.replyPrefix;
  return new RegExp(`^(${prefix}|re|fwd):`, "i").test(subject)
    ? subject
    : `${prefix} ${subject}`;
}

export function seedBody(seed?: ComposerSeed): string {
  const draftHtml = seed?.draft?.htmlBody ?? seed?.prefill?.htmlBody;
  const draftText = seed?.draft?.textBody ?? seed?.prefill?.textBody;
  if (!seed?.sourceMessage) {
    if (!draftHtml && !draftText) return "<p></p>";
    return draftHtml
      ? sanitizeComposeHtml(draftHtml)
      : `<p>${escapeHtml(draftText ?? "").replace(/\n/g, "<br>")}</p>`;
  }
  const message = seed.sourceMessage;
  if (
    seed.omitQuote &&
    (seed.composeMode === "reply" ||
      seed.composeMode === "replyAll" ||
      seed.composeMode === "replyList")
  ) {
    return replyNoteHtml(seed.replyNote) ?? "<p></p>";
  }
  if (seed.composeMode === "editAsNew") {
    return message.htmlBody
      ? sanitizeComposeHtml(message.htmlBody)
      : `<p>${escapeHtml(message.textBody).replace(/\n/g, "<br>")}</p>`;
  }
  if (
    seed.composeMode === "forwardAttachment" ||
    seed.composeMode === "redirect"
  )
    return "<p></p>";
  if (
    seed.composeMode === "forward" &&
    (seed.forwardMessages?.length ?? 0) > 1
  ) {
    return forwardConversationBody(seed.forwardMessages ?? []) ?? "<p></p>";
  }
  const who =
    message.senderName || message.senderAddress || strings.composer.sender;
  const when = quoteDate(message.receivedAt);
  if (seed.composeMode === "forward") {
    return `<p></p><p><br></p><blockquote>${forwardedMessageHtml(message)}</blockquote>`;
  }
  const intro = `<p><strong>${escapeHtml(strings.composer.wrote(when, who))}</strong></p>`;
  const excerpt = quoteExcerpt(seed.quoteExcerpt);
  const quoted = excerpt
    ? `<p>${escapeHtml(excerpt).replace(/\n/g, "<br>")}</p>`
    : message.htmlBody
      ? sanitizeComposeHtml(message.htmlBody)
      : `<p>${escapeHtml(message.textBody).replace(/\n/g, "<br>")}</p>`;
  const note = replyNoteHtml(seed.replyNote);
  const lead = note ? `${note}<p><br></p>` : "<p></p><p><br></p>";
  return `${lead}<blockquote>${intro}${quoted}</blockquote>`;
}

function replyNoteHtml(value: string | undefined): string | undefined {
  const text = value?.split("\u0000").join("").trim() ?? "";
  if (!text) return undefined;
  return `<p>${escapeHtml(text.slice(0, 20_000)).replace(/\n/g, "<br>")}</p>`;
}

const FORWARD_CONVERSATION_LIMIT = 500_000;

function messageQuoteHtml(message: MessageDetail): string {
  if (message.htmlBody) return sanitizeComposeHtml(message.htmlBody);
  return `<p>${escapeHtml(message.textBody).replace(/\n/g, "<br>")}</p>`;
}

/** One forwarded-message block, without the blank lines above it. */
export function forwardedMessageHtml(message: MessageDetail): string {
  const who =
    message.senderName || message.senderAddress || strings.composer.sender;
  const sender =
    message.senderName && message.senderAddress
      ? `${message.senderName} <${message.senderAddress}>`
      : who;
  const rows: Array<[string, string]> = [
    [strings.composer.forwardFrom, sender],
    [strings.composer.forwardDate, quoteDate(message.receivedAt)],
    [strings.composer.forwardSubject, message.subject],
    [strings.composer.forwardTo, (message.to ?? []).join(", ")],
    [strings.composer.forwardCc, (message.cc ?? []).join(", ")],
  ];
  const intro = `<p><strong>${escapeHtml(strings.composer.forwardedMessage)}</strong><br>${rows
    .filter(([, value]) => value)
    .map(([label, value]) => `${escapeHtml(label)}: ${escapeHtml(value)}`)
    .join("<br>")}</p>`;
  return `${intro}${messageQuoteHtml(message)}`;
}

/**
 * Quotes every message, oldest first. Undefined when the letter would be
 * too large to open.
 */
export function forwardConversationBody(
  messages: MessageDetail[],
): string | undefined {
  if (messages.length < 2) return undefined;
  // Cheap precheck on raw body sizes before building any HTML.
  const rawSize = messages.reduce(
    (sum, message) =>
      sum + (message.htmlBody?.length ?? 0) + (message.textBody?.length ?? 0),
    0,
  );
  if (rawSize > FORWARD_CONVERSATION_LIMIT * 2) return undefined;
  const ordered = [...messages].sort((left, right) =>
    left.receivedAt < right.receivedAt
      ? -1
      : left.receivedAt > right.receivedAt
        ? 1
        : left.id - right.id,
  );
  const parts = ["<p></p><p><br></p>"];
  let length = parts[0].length;
  for (const [index, message] of ordered.entries()) {
    const block = `${index > 0 ? "<p><br></p>" : ""}<blockquote>${forwardedMessageHtml(message)}</blockquote>`;
    length += block.length;
    if (length > FORWARD_CONVERSATION_LIMIT) return undefined;
    parts.push(block);
  }
  return parts.join("");
}

/** Selection inside the open message, when it is short enough to quote. */
export function messageSelectionQuote(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const frame = document.querySelector<HTMLIFrameElement>(
    ".message-body iframe",
  );
  const frameText = frame?.contentDocument?.getSelection()?.toString() ?? "";
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;
  const parentText = element?.closest(".message-body")
    ? (selection?.toString() ?? "")
    : "";
  return quoteExcerpt(frameText || parentText);
}

function quoteExcerpt(value: string | undefined): string | undefined {
  const text = value?.split("\u0000").join("").trim() ?? "";
  if (!text || text.length > 20_000) return undefined;
  return text;
}

/** Readable local date for reply and forward headers. */
export function quoteDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function seedReferences(seed?: ComposerSeed): string[] | undefined {
  if (seed?.draft?.references?.length) return seed.draft.references;
  // RFC 5322 3.6.4: a forward is a new message, not a reply, so it must not
  // set In-Reply-To/References.
  if (
    seed?.composeMode === "forward" ||
    seed?.composeMode === "forwardAttachment" ||
    seed?.composeMode === "editAsNew" ||
    seed?.composeMode === "redirect"
  )
    return undefined;
  const parentId = seed?.sourceMessage?.messageId;
  if (!parentId) return seed?.draft?.references;
  const prior = seed?.sourceMessage?.references?.filter(Boolean) ?? [];
  return [...prior, parentId];
}

/** Message this draft answers; Rust marks it only after a confirmed send. */
export function seedSource(seed?: ComposerSeed): {
  sourceMessageId?: number | null;
  sourceKind?: DraftSourceKind | null;
} {
  if (seed?.draft?.sourceMessageId != null && seed.draft.sourceKind)
    return {
      sourceMessageId: seed.draft.sourceMessageId,
      sourceKind: seed.draft.sourceKind,
    };
  if (
    !seed?.sourceMessage ||
    !seed.composeMode ||
    seed.composeMode === "editAsNew"
  )
    return {};
  return {
    sourceMessageId: seed.sourceMessage.id,
    sourceKind:
      seed.composeMode === "replyAll"
        ? "reply_all"
        : seed.composeMode === "forward" ||
            seed.composeMode === "forwardAttachment"
          ? "forward"
          : seed.composeMode === "redirect"
            ? "redirect"
            : "reply",
  };
}

export function isRedirectSeed(seed?: ComposerSeed): boolean {
  return (
    seed?.composeMode === "redirect" || seed?.draft?.sourceKind === "redirect"
  );
}

export function composerTitle(seed?: ComposerSeed): string {
  if (isRedirectSeed(seed)) return strings.reader.redirect;
  if (seed?.draft) return strings.composer.editDraft;
  if (seed?.composeMode === "reply" || seed?.composeMode === "replyAll")
    return strings.composer.reply;
  if (seed?.composeMode === "forward") return strings.composer.forward;
  if (seed?.composeMode === "forwardAttachment")
    return strings.reader.forwardAsAttachment;
  if (seed?.composeMode === "editAsNew") return strings.reader.editAsNew;
  if (seed?.composeMode === "replyList") return strings.reader.replyToList;
  return strings.composer.newMessage;
}

export function highlightColor(): string {
  if (typeof document === "undefined") return "#fff1a8";
  const theme = document.documentElement.dataset.theme;
  const dark =
    theme === "dark" ||
    (theme !== "light" &&
      window.matchMedia?.("(prefers-color-scheme: dark)")?.matches);
  return dark ? "#7a6200" : "#fff1a8";
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

export function announceLocalMailChanged(accountId: string) {
  window.dispatchEvent(
    new CustomEvent("postal:local-mail-changed", { detail: accountId }),
  );
}
