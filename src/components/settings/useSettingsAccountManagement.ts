import { useCallback, useState } from "react";

import { api } from "../../api";
import { mergeAccountFields } from "../../accountMerge";
import { strings } from "../../i18n";
import { htmlToPlainText } from "../../security";
import { useAppStore } from "../../store";
import { preparePassword } from "../setup/request";
import type { SettingsSaveUpdate } from "./useSettingsSave";

interface Options {
  onClose: () => void;
  onLastAccountRemoved?: () => void;
  update: SettingsSaveUpdate;
}

/** State and actions for account connection, identity, and alias settings. */
export function useSettingsAccountManagement({
  onClose,
  onLastAccountRemoved,
  update,
}: Options) {
  const accounts = useAppStore((state) => state.accounts);
  const setAccounts = useAppStore((state) => state.setAccounts);
  const setError = useAppStore((state) => state.setError);
  const [testingAccountId, setTestingAccountId] = useState<string>();
  const [testedHealthy, setTestedHealthy] = useState<string>();
  const [detectingAliasesAccountId, setDetectingAliasesAccountId] =
    useState<string>();
  const [newAliasInputs, setNewAliasInputs] = useState<Record<string, string>>(
    {},
  );
  const [aliasStatus, setAliasStatus] = useState<Record<string, string>>({});
  const [passwordInputs, setPasswordInputs] = useState<Record<string, string>>(
    {},
  );
  const [passwordStatus, setPasswordStatus] = useState<Record<string, string>>(
    {},
  );
  const [updatingPasswordId, setUpdatingPasswordId] = useState<string>();
  const [nameInputs, setNameInputs] = useState<Record<string, string>>({});
  const [nameStatus, setNameStatus] = useState<Record<string, string>>({});
  const [savingNameId, setSavingNameId] = useState<string>();
  const [replyToInputs, setReplyToInputs] = useState<Record<string, string>>(
    {},
  );
  const [replyToStatus, setReplyToStatus] = useState<Record<string, string>>(
    {},
  );
  const [savingReplyToId, setSavingReplyToId] = useState<string>();
  const [signatureInputs, setSignatureInputs] = useState<
    Record<string, string>
  >({});
  const [signatureHtmlInputs, setSignatureHtmlInputs] = useState<
    Record<string, string>
  >({});
  const [signatureStatus, setSignatureStatus] = useState<
    Record<string, string>
  >({});
  const [savingSignatureId, setSavingSignatureId] = useState<string>();

  const hasDirtyForms =
    Object.entries(nameInputs).some(
      ([id, value]) =>
        value !==
        (accounts.find((account) => account.id === id)?.displayName ?? ""),
    ) ||
    Object.entries(replyToInputs).some(
      ([id, value]) =>
        value !==
        (accounts.find((account) => account.id === id)?.replyTo ?? ""),
    ) ||
    Object.entries(signatureInputs).some(
      ([id, value]) =>
        value !==
        (accounts.find((account) => account.id === id)?.signature ?? ""),
    ) ||
    Object.entries(signatureHtmlInputs).some(
      ([id, value]) =>
        value !==
        (accounts.find((account) => account.id === id)?.signatureHtml ?? ""),
    );

  async function removeAccount(id: string, name: string) {
    try {
      const impact = await api.getAccountRemovalImpact(id);
      const hasLocalWork =
        impact.unsentMessages > 0 ||
        impact.unsyncedDrafts > 0 ||
        impact.queuedChanges > 0;
      const confirmed = await api.showNativeConfirm(
        strings.common.remove,
        hasLocalWork
          ? strings.settings.removeAccountWithImpact(
              name,
              impact.unsentMessages,
              impact.unsyncedDrafts,
              impact.queuedChanges,
            )
          : strings.settings.removeAccount(name),
      );
      if (!confirmed) return;
      const result = await api.removeAccount(id);
      // Rust prunes these too, but a later full save from this copy would
      // write them back, so drop them here through the same save queue.
      const latest = useAppStore.getState().settings;
      const keep = (entry: { accountId: string }) => entry.accountId !== id;
      const pruned = {
        lastFromAddresses: (latest.lastFromAddresses ?? []).filter(keep),
        mailboxViews: (latest.mailboxViews ?? []).filter(keep),
        pinnedMailboxes: (latest.pinnedMailboxes ?? []).filter(keep),
        hiddenMailboxes: (latest.hiddenMailboxes ?? []).filter(keep),
        collapsedMailboxes: (latest.collapsedMailboxes ?? []).filter(keep),
      };
      if (
        Object.entries(pruned).some(
          ([key, value]) =>
            value.length !==
            ((latest[key as keyof typeof pruned] as unknown[] | undefined)
              ?.length ?? 0),
        )
      ) {
        void update(pruned, undefined, { quiet: true });
      }
      const remaining = await api.listAccounts();
      setAccounts(remaining);
      if (result?.cleanupPending) {
        setError(strings.settings.accountCleanupWarning);
      } else if (result?.diskSpacePending) {
        setError(strings.settings.accountDiskSpacePending);
      }
      if (remaining.length === 0) {
        onLastAccountRemoved?.();
        onClose();
      }
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function testAccount(id: string) {
    if (testingAccountId) return;
    setTestingAccountId(id);
    setTestedHealthy(undefined);
    try {
      await api.testSavedAccount(id);
      setTestedHealthy(id);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setTestingAccountId(undefined);
    }
  }

  async function handleDetectAliases(accountId: string) {
    if (detectingAliasesAccountId) return;
    setDetectingAliasesAccountId(accountId);
    try {
      const updated = await api.discoverAccountAliases(accountId);
      mergeAccountFields(accountId, { aliases: updated.aliases });
      const count = updated.aliases?.length ?? 0;
      setAliasStatus((prev) => ({
        ...prev,
        [accountId]: strings.settings.aliasesFound(count),
      }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setDetectingAliasesAccountId(undefined);
    }
  }

  async function handleAddAlias(accountId: string) {
    const input = (newAliasInputs[accountId] ?? "").trim().toLowerCase();
    if (!input || !/^[^\s@<>]+@[^\s@<>]+$/.test(input)) {
      setError(strings.settings.aliasInvalid);
      return;
    }
    const account = useAppStore
      .getState()
      .accounts.find((item) => item.id === accountId);
    if (!account) return;
    const current = account.aliases ?? [];
    if (current.includes(input) || account.email.toLowerCase() === input) {
      setNewAliasInputs((prev) => ({ ...prev, [accountId]: "" }));
      return;
    }
    try {
      const updated = await api.updateAccountAliases(accountId, [
        ...current,
        input,
      ]);
      mergeAccountFields(accountId, { aliases: updated.aliases });
      setNewAliasInputs((prev) => ({ ...prev, [accountId]: "" }));
      setAliasStatus((prev) => ({
        ...prev,
        [accountId]: strings.settings.aliasAdded(input),
      }));
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function handleRemoveAlias(accountId: string, alias: string) {
    const confirmed = await api.showNativeConfirm(
      strings.settings.aliasesTitle,
      strings.settings.removeAliasConfirm(alias),
    );
    if (!confirmed) return;
    const account = useAppStore
      .getState()
      .accounts.find((item) => item.id === accountId);
    if (!account) return;
    const remainingAliases = (account.aliases ?? []).filter(
      (item) => item !== alias,
    );
    try {
      const updated = await api.updateAccountAliases(
        accountId,
        remainingAliases,
      );
      mergeAccountFields(accountId, { aliases: updated.aliases });
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function handleUpdatePassword(accountId: string) {
    if (updatingPasswordId) return;
    const rawPassword = passwordInputs[accountId] ?? "";
    if (!rawPassword) return;
    const account = accounts.find((item) => item.id === accountId);
    const password = preparePassword(
      account?.provider ?? "manual",
      rawPassword,
    );
    setUpdatingPasswordId(accountId);
    try {
      const updated = await api.updateAccountPassword(accountId, password);
      mergeAccountFields(accountId, {
        error: updated.error,
        syncState: updated.syncState,
      });
      setPasswordInputs((prev) => ({ ...prev, [accountId]: "" }));
      setPasswordStatus((prev) => ({
        ...prev,
        [accountId]: strings.settings.passwordUpdated,
      }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setUpdatingPasswordId(undefined);
    }
  }

  async function handleSaveName(accountId: string) {
    if (savingNameId) return;
    const account = accounts.find((item) => item.id === accountId);
    const fallback = account?.displayName ?? "";
    const value = (nameInputs[accountId] ?? fallback).trim();
    if (!value) {
      setError(strings.settings.accountNameHelp);
      return;
    }
    setSavingNameId(accountId);
    try {
      const updated = await api.updateAccountDisplayName(accountId, value);
      mergeAccountFields(accountId, { displayName: updated.displayName });
      setNameInputs((prev) =>
        (prev[accountId] ?? fallback) === value
          ? { ...prev, [accountId]: updated.displayName }
          : prev,
      );
      setNameStatus((prev) => ({
        ...prev,
        [accountId]: strings.settings.accountNameSaved,
      }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSavingNameId(undefined);
    }
  }

  async function handleSaveReplyTo(accountId: string) {
    if (savingReplyToId) return;
    const account = accounts.find((item) => item.id === accountId);
    const fallback = account?.replyTo ?? "";
    const value = (replyToInputs[accountId] ?? fallback).trim();
    if (value && !oneReplyAddress(value)) {
      setReplyToStatus((prev) => ({
        ...prev,
        [accountId]: strings.settings.replyToAddressInvalid,
      }));
      return;
    }
    setSavingReplyToId(accountId);
    try {
      const updated = await api.updateAccountReplyTo(accountId, value);
      mergeAccountFields(accountId, { replyTo: updated.replyTo });
      setReplyToInputs((prev) =>
        (prev[accountId] ?? fallback) === value
          ? { ...prev, [accountId]: updated.replyTo ?? "" }
          : prev,
      );
      setReplyToStatus((prev) => ({
        ...prev,
        [accountId]: strings.settings.replyToAddressSaved,
      }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSavingReplyToId(undefined);
    }
  }

  async function handleSaveSignature(
    accountId: string,
    fallback: string,
    fallbackHtml: string,
  ) {
    if (savingSignatureId) return;
    setSavingSignatureId(accountId);
    try {
      const value = signatureInputs[accountId] ?? fallback;
      const html = signatureHtmlInputs[accountId] ?? fallbackHtml;
      const hasRichContent =
        /<(?:a|b|blockquote|code|em|h[1-6]|i|li|ol|s|strike|strong|u|ul)\b/i.test(
          html,
        ) ||
        (Boolean(html.trim()) && htmlToPlainText(html) !== value.trim());
      const updated = hasRichContent
        ? await api.updateAccountSignature(accountId, value, html)
        : await api.updateAccountSignature(accountId, value);
      mergeAccountFields(accountId, {
        signature: updated.signature,
        signatureHtml: updated.signatureHtml,
      });
      const savedSignature = updated.signature ?? "";
      const savedSignatureHtml = updated.signatureHtml ?? "";
      setSignatureInputs((prev) =>
        (prev[accountId] ?? fallback) === value
          ? { ...prev, [accountId]: savedSignature }
          : prev,
      );
      setSignatureHtmlInputs((prev) =>
        (prev[accountId] ?? fallbackHtml) === html
          ? { ...prev, [accountId]: savedSignatureHtml }
          : prev,
      );
      setSignatureStatus((prev) => ({
        ...prev,
        [accountId]: strings.settings.signatureSaved,
      }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSavingSignatureId(undefined);
    }
  }

  const discardUnsavedForms = useCallback(() => {
    setNameInputs({});
    setReplyToInputs({});
    setSignatureInputs({});
    setSignatureHtmlInputs({});
    setNewAliasInputs({});
    setPasswordInputs({});
  }, []);

  return {
    hasDirtyForms,
    discardUnsavedForms,
    testingAccountId,
    testedHealthy,
    testAccount,
    removeAccount,
    passwordInputs,
    setPasswordInputs,
    passwordStatus,
    updatingPasswordId,
    handleUpdatePassword,
    nameInputs,
    setNameInputs,
    nameStatus,
    savingNameId,
    handleSaveName,
    replyToInputs,
    setReplyToInputs,
    replyToStatus,
    savingReplyToId,
    handleSaveReplyTo,
    signatureInputs,
    setSignatureInputs,
    signatureHtmlInputs,
    setSignatureHtmlInputs,
    signatureStatus,
    savingSignatureId,
    handleSaveSignature,
    detectingAliasesAccountId,
    handleDetectAliases,
    aliasStatus,
    newAliasInputs,
    setNewAliasInputs,
    handleAddAlias,
    handleRemoveAlias,
  };
}

/** One mailbox, or blank. A blank address means replies use From. */
function oneReplyAddress(value: string): boolean {
  if (
    value.length > 320 ||
    value.includes(",") ||
    Array.from(value).some((char) => {
      const code = char.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  ) {
    return false;
  }
  const address = "[^\\s@<>]+@[^\\s@<>]+";
  return (
    new RegExp(`^${address}$`).test(value) ||
    new RegExp(`^[^<>]+<${address}>$`).test(value)
  );
}
