import { api } from "../../api";
import {
  blockableDomain,
  canBlockSender,
  matchingBlockRules,
  matchingDomainRules,
  rememberBlockedSenders,
  senderDomain,
} from "../../blockedSenders";
import { senderRuleNeedle } from "../../contextMenu";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";

export function readerAccount(accountId: string) {
  return useAppStore
    .getState()
    .accounts.find((account) => account.id === accountId);
}

interface Options {
  setError: (error?: string) => void;
  setBlockRevision: (update: (revision: number) => number) => void;
  move: (role: "archive" | "trash" | "junk") => Promise<void>;
  moveToInbox: () => void;
}

export function useSenderRules({
  setError,
  setBlockRevision,
  move,
  moveToInbox,
}: Options) {
  async function blockSender() {
    const snapshot = useAppStore.getState();
    const message = snapshot.selectedMessage;
    if (!message) return;
    const contains = senderRuleNeedle(message.senderAddress);
    if (
      !contains ||
      !canBlockSender(message.senderAddress, readerAccount(message.accountId))
    )
      return;
    const alreadyJunk = snapshot.mailboxes.some(
      (box) => box.id === message.mailboxId && box.role === "junk",
    );
    const confirmed = await api.showNativeConfirm(
      strings.reader.blockSender,
      alreadyJunk
        ? strings.reader.blockSenderFuture
        : strings.reader.blockSenderQuestion,
    );
    if (!confirmed) return;
    if (!alreadyJunk) await move("junk");
    try {
      const rules = await api.listFilterRules(message.accountId);
      const blocked = rules.some(
        (rule) =>
          rule.enabled &&
          rule.field === "from" &&
          rule.action === "move_junk" &&
          rule.contains.trim().toLowerCase() === contains.toLowerCase(),
      );
      if (blocked) {
        rememberBlockedSenders(message.accountId, rules);
        setBlockRevision((revision) => revision + 1);
        return;
      }
      const created = await api.createFilterRule({
        id: "",
        accountId: message.accountId,
        name: strings.reader.blockSender,
        field: "from",
        contains,
        action: "move_junk",
        targetMailbox: null,
        enabled: true,
      });
      rememberBlockedSenders(message.accountId, [...rules, created]);
      setBlockRevision((revision) => revision + 1);
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function blockDomain() {
    const snapshot = useAppStore.getState();
    const message = snapshot.selectedMessage;
    if (!message) return;
    const domain = blockableDomain(
      message.senderAddress,
      readerAccount(message.accountId),
    );
    if (!domain) return;
    const alreadyJunk = snapshot.mailboxes.some(
      (box) => box.id === message.mailboxId && box.role === "junk",
    );
    const confirmed = await api.showNativeConfirm(
      strings.reader.blockDomain,
      alreadyJunk
        ? strings.reader.blockDomainFuture(domain)
        : strings.reader.blockDomainQuestion(domain),
    );
    if (!confirmed) return;
    if (!alreadyJunk) await move("junk");
    try {
      const rules = await api.listFilterRules(message.accountId);
      if (matchingDomainRules(rules, message.senderAddress).length > 0) {
        rememberBlockedSenders(message.accountId, rules);
        setBlockRevision((revision) => revision + 1);
        return;
      }
      const created = await api.createFilterRule({
        id: "",
        accountId: message.accountId,
        name: `Block ${domain}`.slice(0, 80),
        field: "domain",
        contains: domain,
        action: "move_junk",
        targetMailbox: null,
        enabled: true,
      });
      rememberBlockedSenders(message.accountId, [...rules, created]);
      setBlockRevision((revision) => revision + 1);
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function unblockDomain() {
    const snapshot = useAppStore.getState();
    const message = snapshot.selectedMessage;
    if (!message) return;
    const domain = senderDomain(message.senderAddress);
    if (!domain) return;
    const inJunk = snapshot.mailboxes.some(
      (box) => box.id === message.mailboxId && box.role === "junk",
    );
    const confirmed = await api.showNativeConfirm(
      strings.reader.unblockDomain,
      inJunk
        ? strings.reader.unblockDomainFromJunk(domain)
        : strings.reader.unblockDomainQuestion(domain),
    );
    if (!confirmed) return;
    if (useAppStore.getState().selectedMessage?.id !== message.id) return;
    try {
      const rules = await api.listFilterRules(message.accountId);
      const matches = matchingDomainRules(rules, message.senderAddress);
      for (const rule of matches) {
        await api.deleteFilterRule(message.accountId, rule.id);
      }
      rememberBlockedSenders(
        message.accountId,
        rules.filter((rule) => !matches.some((match) => match.id === rule.id)),
      );
      setBlockRevision((revision) => revision + 1);
    } catch (cause) {
      setError(String(cause));
      return;
    }
    if (useAppStore.getState().selectedMessage?.id !== message.id) return;
    if (inJunk) moveToInbox();
  }

  async function unblockSender() {
    const snapshot = useAppStore.getState();
    const message = snapshot.selectedMessage;
    if (!message) return;
    const contains = senderRuleNeedle(message.senderAddress);
    if (!contains) return;
    const inJunk = snapshot.mailboxes.some(
      (box) => box.id === message.mailboxId && box.role === "junk",
    );
    const confirmed = await api.showNativeConfirm(
      strings.reader.unblockSender,
      inJunk
        ? strings.reader.unblockSenderFromJunk
        : strings.reader.unblockSenderQuestion,
    );
    if (!confirmed) return;
    if (useAppStore.getState().selectedMessage?.id !== message.id) return;
    try {
      const rules = await api.listFilterRules(message.accountId);
      const matches = matchingBlockRules(rules, contains);
      for (const rule of matches) {
        await api.deleteFilterRule(message.accountId, rule.id);
      }
      rememberBlockedSenders(
        message.accountId,
        rules.filter((rule) => !matches.some((match) => match.id === rule.id)),
      );
      setBlockRevision((revision) => revision + 1);
    } catch (cause) {
      setError(String(cause));
      return;
    }
    if (useAppStore.getState().selectedMessage?.id !== message.id) return;
    if (inJunk) moveToInbox();
  }

  return { blockSender, blockDomain, unblockDomain, unblockSender };
}
