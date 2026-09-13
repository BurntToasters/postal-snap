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
  const replyAddress = message.replyTo ?? message.senderAddress;
  if (field === "to") return replyAddress ?? message.to.join(", ");
  const ownAddresses = [accountEmail, ...aliases];
  if (seed.composeMode !== "replyAll") return "";
  const seen = new Set<string>();
  return [...message.to, ...message.cc]
    .filter(
      (address) =>
        ![...ownAddresses, message.senderAddress, replyAddress].some(
          (excluded) => excluded?.toLowerCase() === address.toLowerCase(),
        ),
    )
    .filter((address) => {
      const key = address.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(", ");
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
  const intro =
    seed.composeMode === "forward"
      ? strings.composer.forwardedMessage
      : strings.composer.wrote(
          message.receivedAt,
          message.senderName ||
            message.senderAddress ||
            strings.composer.sender,
        );
  return `<p></p><p><br></p><blockquote><p><strong>${escapeHtml(intro)}</strong></p>${message.htmlBody ? sanitizeComposeHtml(message.htmlBody) : `<p>${escapeHtml(message.textBody).replace(/\n/g, "<br>")}</p>`}</blockquote>`;
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
