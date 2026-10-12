const EMBEDDED_ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function mailbox(value: string): string {
  return value.trim().replace(/^<|>$/g, "").toLowerCase();
}

/** An email address written in the display name when it is not the sender. */
export function conflictingNameAddress(
  name: string,
  address: string,
): string | null {
  const actual = mailbox(address);
  if (!name.trim() || !actual) return null;
  for (const found of name.match(EMBEDDED_ADDRESS) ?? []) {
    if (mailbox(found) !== actual) return found;
  }
  return null;
}
