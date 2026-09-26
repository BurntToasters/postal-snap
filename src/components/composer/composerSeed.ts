import { strings } from "../../i18n";
import { sanitizeComposeHtml } from "../../security";
import type { ComposerSeed } from "../../store";

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
  if (seed.composeMode === "forward") return "";
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

export function seedSubject(seed?: ComposerSeed): string {
  const subject =
    seed?.draft?.subject ??
    seed?.prefill?.subject ??
    seed?.sourceMessage?.subject;
  if (!subject) return "";
  if (!seed?.composeMode) return subject;
  const prefix =
    seed.composeMode === "forward"
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
  const who =
    message.senderName || message.senderAddress || strings.composer.sender;
  const when = quoteDate(message.receivedAt);
  let intro: string;
  if (seed.composeMode === "forward") {
    const sender =
      message.senderName && message.senderAddress
        ? `${message.senderName} <${message.senderAddress}>`
        : who;
    const rows: Array<[string, string]> = [
      [strings.composer.forwardFrom, sender],
      [strings.composer.forwardDate, when],
      [strings.composer.forwardSubject, message.subject],
      [strings.composer.forwardTo, (message.to ?? []).join(", ")],
      [strings.composer.forwardCc, (message.cc ?? []).join(", ")],
    ];
    intro = `<p><strong>${escapeHtml(strings.composer.forwardedMessage)}</strong><br>${rows
      .filter(([, value]) => value)
      .map(([label, value]) => `${escapeHtml(label)}: ${escapeHtml(value)}`)
      .join("<br>")}</p>`;
  } else {
    intro = `<p><strong>${escapeHtml(strings.composer.wrote(when, who))}</strong></p>`;
  }
  return `<p></p><p><br></p><blockquote>${intro}${message.htmlBody ? sanitizeComposeHtml(message.htmlBody) : `<p>${escapeHtml(message.textBody).replace(/\n/g, "<br>")}</p>`}</blockquote>`;
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
  if (seed?.composeMode === "forward") return undefined;
  const parentId = seed?.sourceMessage?.messageId;
  if (!parentId) return seed?.draft?.references;
  const prior = seed?.sourceMessage?.references?.filter(Boolean) ?? [];
  return [...prior, parentId];
}

export function composerTitle(seed?: ComposerSeed): string {
  if (seed?.draft) return strings.composer.editDraft;
  if (seed?.composeMode === "reply" || seed?.composeMode === "replyAll")
    return strings.composer.reply;
  if (seed?.composeMode === "forward") return strings.composer.forward;
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
