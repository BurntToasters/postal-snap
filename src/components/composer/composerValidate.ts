import { strings } from "../../i18n";
import type { ComposeDraft } from "../../types";

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
