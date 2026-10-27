import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../../api";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type { FilterRule, MailboxSummary } from "../../types";

export interface RuleSeed {
  accountId: string;
  contains: string;
  field?: "from" | "to" | "subject";
}

interface RuleDraft {
  name: string;
  field: string;
  contains: string;
  action: string;
  target: string;
}

interface Options {
  enabled: boolean;
  initialRuleSeed?: RuleSeed;
}

/** Keeps account filter rules and an in-progress rule draft together. */
export function useSettingsFilterRules({ enabled, initialRuleSeed }: Options) {
  const accounts = useAppStore((state) => state.accounts);
  const setError = useAppStore((state) => state.setError);
  const [filterRules, setFilterRules] = useState<Record<string, FilterRule[]>>(
    {},
  );
  const [accountMailboxes, setAccountMailboxes] = useState<MailboxSummary[]>(
    [],
  );
  const [newRuleInputs, setNewRuleInputs] = useState<Record<string, RuleDraft>>(
    () => {
      const contains = initialRuleSeed?.contains.trim() ?? "";
      if (!initialRuleSeed || !contains) return {};
      return {
        [initialRuleSeed.accountId]: {
          name: contains.slice(0, 80),
          field: seedField(initialRuleSeed.field),
          contains: contains.slice(0, 200),
          action: "move_archive",
          target: "",
        },
      };
    },
  );
  const [ruleStatus, setRuleStatus] = useState<Record<string, string>>({});
  const [savingRuleAccounts, setSavingRuleAccounts] = useState<
    Record<string, boolean>
  >({});
  const pendingRuleAccounts = useRef(new Set<string>());

  const hasDirtyForms = Object.values(newRuleInputs).some(
    (draft) =>
      draft.name !== "" ||
      draft.contains !== "" ||
      draft.field !== "from" ||
      draft.action !== "mark_read" ||
      draft.target !== "",
  );

  const discardUnsavedForms = useCallback(() => {
    setNewRuleInputs({});
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void api
      .listAllMailboxes()
      .then((mailboxes) => {
        if (active) setAccountMailboxes(mailboxes);
      })
      .catch(() => undefined);
    void (async () => {
      for (const account of accounts) {
        try {
          const rules = (await api.listFilterRules(account.id)) ?? [];
          if (active) {
            setFilterRules((prev) => {
              const existing = prev[account.id] ?? [];
              const merged = [...existing];
              for (const rule of rules) {
                if (!merged.some((item) => item.id === rule.id)) {
                  merged.push(rule);
                }
              }
              return { ...prev, [account.id]: merged };
            });
          }
        } catch {
          // Rules stay empty; the form below still works.
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [accounts, enabled]);

  function ruleInput(accountId: string): RuleDraft {
    return (
      newRuleInputs[accountId] ?? {
        name: "",
        field: "from",
        contains: "",
        action: "mark_read",
        target: "",
      }
    );
  }

  function setRuleField(accountId: string, patch: Record<string, string>) {
    setNewRuleInputs((prev) => ({
      ...prev,
      [accountId]: { ...ruleInput(accountId), ...patch },
    }));
  }

  async function handleAddRule(accountId: string) {
    if (pendingRuleAccounts.current.has(accountId)) return;
    const input = ruleInput(accountId);
    const name = input.name.trim() || input.contains.trim();
    if (!name) {
      setError(strings.settings.ruleNameRequired);
      return;
    }
    if (!input.contains.trim()) {
      setError(strings.settings.ruleMatchRequired);
      return;
    }
    const submitted = { ...input };
    pendingRuleAccounts.current.add(accountId);
    setSavingRuleAccounts((prev) => ({ ...prev, [accountId]: true }));
    try {
      const created = await api.createFilterRule({
        id: "",
        accountId,
        name,
        field: input.field as FilterRule["field"],
        contains: input.contains,
        action: input.action as FilterRule["action"],
        targetMailbox:
          input.action === "move_mailbox" ? (input.target ?? "") : null,
        enabled: true,
      });
      setFilterRules((prev) => {
        const existing = prev[accountId] ?? [];
        if (existing.some((item) => item.id === created.id)) return prev;
        return { ...prev, [accountId]: [...existing, created] };
      });
      setNewRuleInputs((prev) => {
        const current = prev[accountId];
        return current && ruleDraftEquals(current, submitted)
          ? { ...prev, [accountId]: emptyRuleDraft() }
          : prev;
      });
      setRuleStatus((prev) => ({
        ...prev,
        [accountId]: strings.settings.ruleSaved,
      }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      pendingRuleAccounts.current.delete(accountId);
      setSavingRuleAccounts((prev) => {
        const next = { ...prev };
        delete next[accountId];
        return next;
      });
    }
  }

  async function handlePreviewRule(accountId: string) {
    const input = ruleInput(accountId);
    if (!input.contains.trim()) {
      setError(strings.settings.ruleMatchRequired);
      return;
    }
    try {
      const preview = await api.previewFilterRule({
        id: "",
        accountId,
        name: input.name.trim() || "Preview",
        field: input.field as FilterRule["field"],
        contains: input.contains,
        action: input.action as FilterRule["action"],
        targetMailbox:
          input.action === "move_mailbox" ? (input.target ?? "") : null,
        enabled: true,
      });
      const summary = preview.capped
        ? strings.settings.ruleMatchesCapped
        : preview.matched === 0
          ? strings.settings.ruleMatchesNone
          : strings.settings.ruleMatchesSome(preview.matched);
      const examples = preview.subjects.filter(Boolean);
      setRuleStatus((prev) => ({
        ...prev,
        [accountId]:
          examples.length > 0
            ? `${summary} ${strings.settings.ruleMatchSample(examples.join(", "))}`
            : summary,
      }));
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function handleMoveRule(
    accountId: string,
    ruleId: string,
    direction: -1 | 1,
  ) {
    const rules = filterRules[accountId] ?? [];
    const index = rules.findIndex((rule) => rule.id === ruleId);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= rules.length) return;
    const ordered = [...rules];
    const [moved] = ordered.splice(index, 1);
    ordered.splice(next, 0, moved);
    try {
      const saved = await api.reorderFilterRules(
        accountId,
        ordered.map((rule) => rule.id),
      );
      setFilterRules((prev) => ({ ...prev, [accountId]: saved }));
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function handleToggleRule(accountId: string, rule: FilterRule) {
    try {
      const updated = await api.updateFilterRule({
        ...rule,
        enabled: !rule.enabled,
      });
      setFilterRules((prev) => ({
        ...prev,
        [accountId]: (prev[accountId] ?? []).map((item) =>
          item.id === rule.id ? updated : item,
        ),
      }));
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function handleDeleteRule(accountId: string, rule: FilterRule) {
    const confirmed = await api.showNativeConfirm(
      strings.settings.rulesTitle,
      strings.settings.removeRuleConfirm(rule.name),
    );
    if (!confirmed) return;
    try {
      await api.deleteFilterRule(accountId, rule.id);
      setFilterRules((prev) => ({
        ...prev,
        [accountId]: (prev[accountId] ?? []).filter(
          (item) => item.id !== rule.id,
        ),
      }));
      setRuleStatus((prev) => ({
        ...prev,
        [accountId]: strings.settings.ruleRemoved,
      }));
    } catch (cause) {
      setError(String(cause));
    }
  }

  return {
    accountMailboxes,
    filterRules,
    hasDirtyForms,
    discardUnsavedForms,
    newRuleInputs,
    ruleInput,
    ruleStatus,
    savingRuleAccounts,
    setNewRuleInputs,
    setRuleField,
    handleAddRule,
    handlePreviewRule,
    handleMoveRule,
    handleToggleRule,
    handleDeleteRule,
  };
}

function seedField(field: RuleSeed["field"]): "from" | "to" | "subject" {
  return field === "to" || field === "subject" ? field : "from";
}

function emptyRuleDraft(): RuleDraft {
  return {
    name: "",
    field: "from",
    contains: "",
    action: "mark_read",
    target: "",
  };
}

function ruleDraftEquals(left: RuleDraft, right: RuleDraft): boolean {
  return (
    left.name === right.name &&
    left.field === right.field &&
    left.contains === right.contains &&
    left.action === right.action &&
    left.target === right.target
  );
}
