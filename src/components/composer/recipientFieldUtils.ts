import { isMailbox } from "./composerValidate";

/** Two or more pasted addresses, or undefined when the paste is ordinary text. */
export function pastedRecipients(text: string): string[] | undefined {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return undefined;
  const pieces = normalized
    .split(/[\n,;]+/)
    .map((piece) => piece.trim())
    .filter(Boolean);
  const addresses: string[] = [];
  for (const piece of pieces) {
    if (piece.includes("<")) {
      if (!isMailbox(piece)) return undefined;
      addresses.push(piece);
      continue;
    }
    const words = piece.split(/\s+/).filter(Boolean);
    if (words.length > 1) {
      if (!words.every((word) => isMailbox(word))) return undefined;
      addresses.push(...words);
      continue;
    }
    if (!isMailbox(piece)) return undefined;
    addresses.push(piece);
  }
  if (addresses.length < 2) return undefined;
  return addresses;
}

export function tokenAtCaret(
  value: string,
  caret: number,
): { token: string; start: number } {
  let start = caret;
  while (start > 0 && value[start - 1] !== "," && value[start - 1] !== ";") {
    start -= 1;
  }
  let end = caret;
  while (end < value.length && value[end] !== "," && value[end] !== ";") {
    end += 1;
  }
  return { token: value.slice(start, end).trim(), start };
}
