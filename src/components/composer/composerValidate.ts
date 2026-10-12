import { strings } from "../../i18n";
import { htmlToPlainText } from "../../security";
import type { BodyFormat, ComposeDraft } from "../../types";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const attachmentWords = new RegExp(
  `\\b(?:${strings.composer.attachmentKeywords.map(escapeRegExp).join("|")})s?\\b`,
  "i",
);

/** Text the sender wrote: no quoted reply or forward, no signature. */
export function authoredText(
  body: string,
  format: BodyFormat,
  signature = "",
): string {
  let text: string;
  if (format === "plain") {
    text = body
      .split(/\r?\n/)
      .filter((line) => !/^\s*>/.test(line))
      .join("\n");
  } else {
    const doc = new DOMParser().parseFromString(body, "text/html");
    for (const quote of doc.querySelectorAll("blockquote")) quote.remove();
    text = htmlToPlainText(doc.body.innerHTML);
  }
  const marker = text.search(/^-- ?$/m);
  if (marker >= 0) text = text.slice(0, marker);
  const own = signature.trim();
  return own ? text.split(own).join("") : text;
}

/** True when the message talks about an attachment the sender wrote. */
export function mentionsAttachment(
  body: string,
  format: BodyFormat,
  signature = "",
): boolean {
  return attachmentWords.test(authoredText(body, format, signature));
}

/** Reply-all and wide copies are easy to send by mistake at this size. */
export const LARGE_RECIPIENT_COUNT = 10;

function mailboxAddress(value: string): string {
  const bracketed = value.match(/<([^<>]+)>$/)?.[1];
  return (bracketed ?? value).trim().toLowerCase();
}

const noreplyLocalPart = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply)$/i;

/** The first To, Cc, or Bcc address that looks automated. */
export function firstNoreplyRecipient(
  to: string,
  cc: string,
  bcc: string,
): string | undefined {
  for (const field of [to, cc, bcc]) {
    for (const entry of splitAddresses(field)) {
      const address = mailboxAddress(entry);
      const local = address.split("@")[0] ?? "";
      if (address.includes("@") && noreplyLocalPart.test(local)) return address;
    }
  }
  return undefined;
}

/** An address listed more than once across To, Cc, and Bcc. */
export function repeatedRecipient(
  to: string,
  cc: string,
  bcc: string,
): string | undefined {
  const seen = new Set<string>();
  for (const field of [to, cc, bcc]) {
    for (const entry of splitAddresses(field)) {
      const address = mailboxAddress(entry);
      if (!address.includes("@")) continue;
      if (seen.has(address)) return address;
      seen.add(address);
    }
  }
  return undefined;
}

/** Distinct To, Cc, and Bcc addresses. Display names and case do not add people. */
export function uniqueRecipientCount(
  to: string,
  cc: string,
  bcc: string,
): number {
  const seen = new Set<string>();
  for (const field of [to, cc, bcc]) {
    for (const entry of splitAddresses(field)) {
      const address = mailboxAddress(entry);
      if (address) seen.add(address);
    }
  }
  return seen.size;
}

export function splitAddresses(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '"' && (i === 0 || value[i - 1] !== "\\")) {
      inQuotes = !inQuotes;
      current += char;
    } else if ((char === "," || char === ";") && !inQuotes) {
      const trimmed = current.trim();
      if (trimmed) result.push(trimmed);
      current = "";
    } else {
      current += char;
    }
  }
  const last = current.trim();
  if (last) result.push(last);
  return result;
}

export function validateRecipientFields(
  to: string,
  cc: string,
  bcc: string,
): string | undefined {
  const addresses = [to, cc, bcc].flatMap(splitAddresses);
  if (addresses.length === 0) return strings.composer.recipientRequired;
  if (addresses.some(hasControlCharacter))
    return strings.composer.invalidHeader;
  if (addresses.some((value) => !isMailbox(value)))
    return strings.composer.invalidRecipient;
  return undefined;
}

export function isMailbox(value: string): boolean {
  if (hasControlCharacter(value)) return false;
  const bracketed = value.match(/<([^<>]+)>$/)?.[1];
  const address = (bracketed ?? value).trim();
  return /^[^\s@<>]+@[^\s@<>]+$/.test(address) && address.length <= 320;
}

export function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

export function validateSubject(value: string): string | undefined {
  return hasControlCharacter(value)
    ? strings.composer.invalidSubject
    : undefined;
}

export function hasDraftContent(
  draft: ComposeDraft,
  editorText: string,
): boolean {
  return Boolean(
    draft.to.length ||
    draft.cc.length ||
    draft.bcc.length ||
    draft.subject ||
    editorText.trim() ||
    draft.attachments.length,
  );
}
