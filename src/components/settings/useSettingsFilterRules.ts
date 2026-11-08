import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../../api";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type {
  FilterRule,
  FlagColor,
  MailboxSummary,
  RuleAction,
  RuleCondition,
} from "../../types";
import { errorText } from "../../errors";

export const MAX_RULE_CONDITIONS = 10;
export const MAX_RULE_ACTIONS = 5;
export const MAX_RULE_VALUE_CHARS = 320;

export interface RuleSeed {
  accountId: string;
  contains: string;
  field?: "from" | "to" | "subject";
}

export interface RuleConditionDraft {
  field: string;
  value: string;
}

export interface RuleActionDraft {
  kind: string;
  target: string;
  flagColor: string;
}

export interface RuleDraft {
  name: string;
  matchMode: "all" | "any";
  conditions: RuleConditionDraft[];
  actions: RuleActionDraft[];
}

type BuiltRule = { rule: FilterRule } | { error: string };

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
      const seeded = seededDraft(initialRuleSeed);
      return initialRuleSeed && seeded
        ? { [initialRuleSeed.accountId]: seeded }
        : {};
    },
  );
  const [ruleErrors, setRuleErrors] = useState<Record<string, string>>({});
  const [ruleStatus, setRuleStatus] = useState<Record<string, string>>({});
  const [savingRuleAccounts, setSavingRuleAccounts] = useState<
    Record<string, boolean>
  >({});
  const pendingRuleAccounts = useRef(new Set<string>());

  const hasDirtyForms = Object.values(newRuleInputs).some(
    (draft) => !sameDraft(draft, emptyRuleDraft()),
  );

  const discardUnsavedForms = useCallback(() => {
    setNewRuleInputs({});
    setRuleErrors({});
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
    return newRuleInputs[accountId] ?? emptyRuleDraft();
  }

  function updateRuleDraft(
    accountId: string,
    change: (draft: RuleDraft) => RuleDraft,
  ) {
    setNewRuleInputs((prev) => ({
      ...prev,
      [accountId]: change(prev[accountId] ?? emptyRuleDraft()),
    }));
    setRuleErrors((prev) => withoutKey(prev, accountId));
  }

  function setRuleError(accountId: string, message: string) {
    setRuleErrors((prev) => ({ ...prev, [accountId]: message }));
  }

  async function handleAddRule(accountId: string) {
    if (pendingRuleAccounts.current.has(accountId)) return;
    const input = ruleInput(accountId);
    const name = input.name.trim() || firstValue(input);
    if (!name) {
      setRuleError(accountId, strings.settings.ruleNameRequired);
      return;
    }
    const built = buildRule(accountId, input, name);
    if ("error" in built) {
      setRuleError(accountId, built.error);
      return;
    }
    const submitted = input;
    pendingRuleAccounts.current.add(accountId);
    setSavingRuleAccounts((prev) => ({ ...prev, [accountId]: true }));
    try {
      const created = await api.createFilterRule(built.rule);
      setFilterRules((prev) => {
        const existing = prev[accountId] ?? [];
        if (existing.some((item) => item.id === created.id)) return prev;
        return { ...prev, [accountId]: [...existing, created] };
      });
      setNewRuleInputs((prev) => {
        const current = prev[accountId];
        return current && sameDraft(current, submitted)
          ? { ...prev, [accountId]: emptyRuleDraft() }
          : prev;
      });
      setRuleStatus((prev) => ({
        ...prev,
        [accountId]: strings.settings.ruleSaved,
      }));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      pendingRuleAccounts.current.delete(accountId);
      setSavingRuleAccounts((prev) => withoutKey(prev, accountId));
    }
  }

  async function handlePreviewRule(accountId: string) {
    const input = ruleInput(accountId);
    const built = buildRule(accountId, input, input.name.trim() || "Preview");
    if ("error" in built) {
      setRuleError(accountId, built.error);
      return;
    }
    try {
      const preview = await api.previewFilterRule(built.rule);
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
      setError(errorText(cause));
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
      setError(errorText(cause));
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
      setError(errorText(cause));
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
      setError(errorText(cause));
    }
  }

  return {
    accountMailboxes,
    filterRules,
    hasDirtyForms,
    discardUnsavedForms,
    newRuleInputs,
    ruleErrors,
    ruleInput,
    ruleStatus,
    savingRuleAccounts,
    setNewRuleInputs,
    updateRuleDraft,
    handleAddRule,
    handlePreviewRule,
    handleMoveRule,
    handleToggleRule,
    handleDeleteRule,
  };
}

/** Turns the draft into a v2 rule, or the first plain-text problem. */
function buildRule(
  accountId: string,
  draft: RuleDraft,
  name: string,
): BuiltRule {
  const conditions: RuleCondition[] = [];
  for (const condition of draft.conditions) {
    const value = condition.value.trim();
    if (!value) return { error: strings.settings.ruleMatchRequired };
    conditions.push({
      field: condition.field as RuleCondition["field"],
      value,
    });
  }
  const actions: RuleAction[] = [];
  for (const action of draft.actions) {
    if (action.kind === "move_mailbox" && !action.target) {
      return { error: strings.settings.ruleFolderRequired };
    }
    if (action.kind === "flag" && !/^[0-6]$/.test(action.flagColor)) {
      return { error: strings.settings.ruleFlagRequired };
    }
    actions.push({
      kind: action.kind as RuleAction["kind"],
      targetMailbox: action.kind === "move_mailbox" ? action.target : null,
      flagColor:
        action.kind === "flag" ? (Number(action.flagColor) as FlagColor) : null,
    });
  }
  const first = conditions[0];
  const move = actions.find((action) => action.kind.startsWith("move_"));
  const lead = move ?? actions[0];
  if (!first || !lead) return { error: strings.settings.ruleMatchRequired };
  return {
    rule: {
      id: "",
      accountId,
      name,
      // Legacy columns mirror the first condition and action for older readers.
      field: first.field,
      contains: first.value,
      action: lead.kind as FilterRule["action"],
      targetMailbox: move?.targetMailbox ?? null,
      enabled: true,
      matchMode: draft.matchMode,
      conditions,
      actions,
    },
  };
}

function firstValue(draft: RuleDraft): string {
  return draft.conditions[0]?.value.trim() ?? "";
}

function withoutKey<T>(record: Record<string, T>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}

function seedField(field: RuleSeed["field"]): "from" | "to" | "subject" {
  return field === "to" || field === "subject" ? field : "from";
}

function seededDraft(seed?: RuleSeed): RuleDraft | undefined {
  const contains = seed?.contains.trim() ?? "";
  if (!seed || !contains) return undefined;
  return {
    name: contains.slice(0, 80),
    matchMode: "all",
    conditions: [
      { field: seedField(seed.field), value: contains.slice(0, 200) },
    ],
    actions: [{ kind: "move_archive", target: "", flagColor: "0" }],
  };
}

export function emptyRuleDraft(): RuleDraft {
  return {
    name: "",
    matchMode: "all",
    conditions: [{ field: "from", value: "" }],
    actions: [{ kind: "mark_read", target: "", flagColor: "0" }],
  };
}

function sameDraft(left: RuleDraft, right: RuleDraft): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
