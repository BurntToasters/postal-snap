import type { FilterRule } from "./types";

const needlesByAccount = new Map<string, string[]>();
const domainsByAccount = new Map<string, string[]>();

const DOMAIN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Host of an email address, when it is a domain with a dot. */
export function senderDomain(address: string): string | undefined {
  const trimmed = address.trim().toLowerCase();
  const open = trimmed.lastIndexOf("<");
  const close = trimmed.lastIndexOf(">");
  const mailbox =
    open >= 0 && close > open ? trimmed.slice(open + 1, close).trim() : trimmed;
  const at = mailbox.lastIndexOf("@");
  if (at < 0) return undefined;
  const domain = mailbox.slice(at + 1).trim();
  return DOMAIN.test(domain) ? domain : undefined;
}

// Blocking one of these would junk mail from everyone who uses that provider.
const SHARED_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "yandex.com",
  "zoho.com",
  "fastmail.com",
]);

interface OwnAccount {
  email: string;
  aliases?: string[];
}

function ownAddresses(account: OwnAccount | undefined): string[] {
  if (!account) return [];
  return [account.email, ...(account.aliases ?? [])]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function bareAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  const open = trimmed.lastIndexOf("<");
  const close = trimmed.lastIndexOf(">");
  return open >= 0 && close > open
    ? trimmed.slice(open + 1, close).trim()
    : trimmed;
}

/** Whether Block sender makes sense: never for this account's own addresses. */
export function canBlockSender(
  address: string,
  account: OwnAccount | undefined,
): boolean {
  const sender = bareAddress(address);
  return Boolean(sender) && !ownAddresses(account).includes(sender);
}

/** The domain Block domain would use, or undefined for own and shared domains. */
export function blockableDomain(
  address: string,
  account: OwnAccount | undefined,
): string | undefined {
  const domain = senderDomain(address);
  if (!domain || SHARED_MAIL_DOMAINS.has(domain)) return undefined;
  const own = ownAddresses(account)
    .map((value) => senderDomain(value))
    .filter((value): value is string => Boolean(value));
  if (own.some((item) => domain === item || domain.endsWith(`.${item}`)))
    return undefined;
  return domain;
}

function needleOf(value: string): string {
  return value.trim().toLowerCase();
}

/** Enabled Junk rules that match a sender address. */
export function matchingBlockRules(
  rules: FilterRule[],
  needle: string,
): FilterRule[] {
  const wanted = needleOf(needle);
  if (!wanted) return [];
  return rules.filter(
    (rule) =>
      rule.enabled &&
      rule.field === "from" &&
      rule.action === "move_junk" &&
      needleOf(rule.contains) === wanted,
  );
}

export function matchingDomainRules(
  rules: FilterRule[],
  address: string,
): FilterRule[] {
  const domain = senderDomain(address);
  if (!domain) return [];
  return rules.filter((rule) => {
    if (!rule.enabled || rule.field !== "domain" || rule.action !== "move_junk")
      return false;
    const blocked = senderDomain(`blocked@${needleOf(rule.contains)}`);
    return (
      blocked !== undefined &&
      (domain === blocked || domain.endsWith(`.${blocked}`))
    );
  });
}

export function rememberBlockedSenders(
  accountId: string,
  rules: FilterRule[],
): void {
  const needles: string[] = [];
  const domains: string[] = [];
  for (const rule of rules) {
    if (!rule.enabled || rule.action !== "move_junk") continue;
    const needle = needleOf(rule.contains);
    if (!needle) continue;
    if (rule.field === "from" && !needles.includes(needle))
      needles.push(needle);
    if (rule.field === "domain") {
      const domain = senderDomain(`blocked@${needle}`);
      if (domain && !domains.includes(domain)) domains.push(domain);
    }
  }
  needlesByAccount.set(accountId, needles);
  domainsByAccount.set(accountId, domains);
}

export function senderIsBlocked(accountId: string, address: string): boolean {
  const needle = needleOf(address);
  if (!needle) return false;
  return (needlesByAccount.get(accountId) ?? []).includes(needle);
}

export function domainIsBlocked(accountId: string, address: string): boolean {
  const domain = senderDomain(address);
  if (!domain) return false;
  return (domainsByAccount.get(accountId) ?? []).some(
    (blocked) => domain === blocked || domain.endsWith(`.${blocked}`),
  );
}

export function clearBlockedSenders(): void {
  needlesByAccount.clear();
  domainsByAccount.clear();
}
