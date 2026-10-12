export const LAST_FROM_LIMIT = 40;

export interface LastFromAddress {
  accountId: string;
  address: string;
}

function mailboxAddress(value: string): string {
  const trimmed = value.trim();
  const wrapped = trimmed.match(/<([^<>]+)>$/)?.[1] ?? trimmed;
  return wrapped.trim().toLowerCase();
}

/**
 * The account address a reply should use: To, then Cc, then Bcc.
 * The account address wins over an alias in the same field.
 * `recipients` is used only when those fields are empty.
 */
export function addressedFrom(
  fields: {
    to?: string[];
    cc?: string[];
    bcc?: string[];
    recipients?: string;
  },
  accountEmail: string,
  aliases: string[],
): string | undefined {
  const own = [accountEmail, ...aliases]
    .map((item) => item.trim())
    .filter((item) => item.includes("@"));
  const structured = [fields.to ?? [], fields.cc ?? [], fields.bcc ?? []];
  const groups = structured.some((group) => group.length > 0)
    ? structured
    : [
        (fields.recipients ?? "")
          .split(/[;,]/)
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      ];
  for (const group of groups) {
    for (const candidate of own) {
      const needle = candidate.toLowerCase();
      if (group.some((item) => mailboxAddress(item) === needle)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** The address this account last sent from, when it is still allowed. */
export function rememberedFromAddress(
  current: LastFromAddress[],
  accountId: string,
  allowed: string[],
): string | undefined {
  const saved = current.find((item) => item.accountId === accountId)?.address;
  if (!saved) return undefined;
  return allowed.find((item) => item.toLowerCase() === saved.toLowerCase());
}

/** Replace this account's remembered From address. Unchanged and unknown addresses stay put. */
export function rememberFromAddress(
  current: LastFromAddress[],
  accountId: string,
  address: string,
  allowed: string[],
): LastFromAddress[] | undefined {
  const nextAddress = address.trim();
  if (
    !accountId ||
    !allowed.some((item) => item.toLowerCase() === nextAddress.toLowerCase())
  ) {
    return undefined;
  }
  const existing = current.find((item) => item.accountId === accountId);
  if (existing?.address.toLowerCase() === nextAddress.toLowerCase()) {
    return undefined;
  }
  const without = current.filter((item) => item.accountId !== accountId);
  if (without.length >= LAST_FROM_LIMIT) return undefined;
  return [...without, { accountId, address: nextAddress }];
}
