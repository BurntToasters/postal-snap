import { ruleActionsOf, ruleConditionsOf } from "../../blockedSenders";
import { strings } from "../../i18n";
import type {
  AccountSummary,
  FilterRule,
  MailboxSummary,
  RuleAction,
} from "../../types";
import {
  MAX_RULE_ACTIONS,
  MAX_RULE_CONDITIONS,
  MAX_RULE_VALUE_CHARS,
  type RuleDraft,
} from "./useSettingsFilterRules";

export type AccountRuleDraft = RuleDraft;

const FIELDS = ["from", "to", "subject", "domain"] as const;
const FLAG_KEYS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "gray",
] as const;
const MOVE_KINDS = ["move_archive", "move_trash", "move_junk", "move_mailbox"];
const ACTION_KINDS = ["mark_read", ...MOVE_KINDS, "flag", "pin", "notify"];

function isMove(kind: string): boolean {
  return MOVE_KINDS.includes(kind);
}

function fieldLabel(field: string): string {
  if (field === "subject") return strings.settings.matchSubject;
  if (field === "to") return strings.settings.matchTo;
  if (field === "domain") return strings.settings.matchDomain;
  return strings.settings.matchFrom;
}

/** Second and later rows get a position so their accessible names differ. */
function numbered(label: string, position: number): string {
  return position === 1 ? label : `${label} ${position}`;
}

function flagColorName(color: number | null | undefined): string {
  const key = typeof color === "number" ? FLAG_KEYS[color] : undefined;
  return key ? strings.mail.flagColors[key] : "";
}

function actionText(
  action: RuleAction,
  accountId: string,
  mailboxes: MailboxSummary[],
): string {
  switch (action.kind) {
    case "mark_read":
      return strings.settings.actionMarkRead;
    case "move_archive":
      return strings.settings.actionArchive;
    case "move_trash":
      return strings.settings.actionTrash;
    case "move_junk":
      return strings.settings.actionJunk;
    case "move_mailbox": {
      const target = mailboxes.find(
        (box) =>
          box.accountId === accountId &&
          String(box.id) === (action.targetMailbox ?? ""),
      );
      return target
        ? strings.settings.actionMoveToFolder(target.displayName || target.name)
        : strings.settings.actionFolder;
    }
    case "flag":
      return strings.settings.actionFlagWith(flagColorName(action.flagColor));
    case "pin":
      return strings.settings.actionPin;
    case "notify":
      return strings.settings.actionNotify;
    default:
      return action.kind;
  }
}

function kindLabel(kind: string): string {
  if (kind === "flag") return strings.settings.actionFlag;
  if (kind === "move_mailbox") return strings.settings.actionFolder;
  return actionText({ kind: kind as RuleAction["kind"] }, "", []);
}

function describeRule(
  rule: FilterRule,
  accountId: string,
  mailboxes: MailboxSummary[],
): string {
  const join =
    rule.matchMode === "any"
      ? strings.settings.ruleJoinAny
      : strings.settings.ruleJoinAll;
  const conditions = ruleConditionsOf(rule)
    .map((condition) => `${fieldLabel(condition.field)} “${condition.value}”`)
    .join(join);
  const actions = ruleActionsOf(rule)
    .map((action) => actionText(action, accountId, mailboxes))
    .join(strings.settings.ruleJoinAll);
  return strings.settings.describeRule(conditions, actions);
}

function patchAt<T extends object>(
  items: T[],
  index: number,
  patch: Partial<T>,
): T[] {
  return items.map((item, i) => (i === index ? { ...item, ...patch } : item));
}

export function RulesEditor({
  account,
  mailboxes,
  filterRules,
  ruleStatus,
  ruleErrors,
  ruleInput,
  updateRuleDraft,
  handleAddRule,
  savingRuleAccounts,
  handlePreviewRule,
  handleMoveRule,
  handleToggleRule,
  handleDeleteRule,
}: {
  account: AccountSummary;
  mailboxes: MailboxSummary[];
  filterRules: Record<string, FilterRule[]>;
  ruleStatus: Record<string, string>;
  ruleErrors: Record<string, string>;
  ruleInput: (accountId: string) => AccountRuleDraft;
  updateRuleDraft: (
    accountId: string,
    change: (draft: AccountRuleDraft) => AccountRuleDraft,
  ) => void;
  handleAddRule: (accountId: string) => Promise<void>;
  savingRuleAccounts: Record<string, boolean>;
  handlePreviewRule: (accountId: string) => Promise<void>;
  handleMoveRule: (
    accountId: string,
    ruleId: string,
    direction: -1 | 1,
  ) => Promise<void>;
  handleToggleRule: (accountId: string, rule: FilterRule) => Promise<void>;
  handleDeleteRule: (accountId: string, rule: FilterRule) => Promise<void>;
}) {
  const draft = ruleInput(account.id);
  const folders = mailboxes.filter(
    (box) =>
      box.accountId === account.id &&
      box.role !== "trash" &&
      box.role !== "junk" &&
      box.role !== "inbox",
  );
  const change = (next: (current: AccountRuleDraft) => AccountRuleDraft) =>
    updateRuleDraft(account.id, next);

  return (
    <div className="account-rules-section">
      <div className="aliases-header">
        <div>
          <strong>{strings.settings.rulesTitle}</strong>
          <p className="settings-note">{strings.settings.rulesHelp}</p>
        </div>
      </div>
      {ruleStatus[account.id] ? (
        <div className="alias-status-message" role="status" aria-live="polite">
          {ruleStatus[account.id]}
        </div>
      ) : null}
      {(filterRules[account.id] ?? []).length > 0 ? (
        <ul className="rule-list">
          {(filterRules[account.id] ?? []).map((rule, index, rules) => (
            <li className="rule-item" key={rule.id}>
              <div className="rule-item-text">
                <strong>{rule.name}</strong>
                <span>{describeRule(rule, account.id, mailboxes)}</span>
              </div>
              <div className="rule-order">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={index === 0}
                  aria-label={strings.settings.moveRuleEarlier(rule.name)}
                  onClick={() => void handleMoveRule(account.id, rule.id, -1)}
                >
                  {strings.settings.moveEarlier}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={index === rules.length - 1}
                  aria-label={strings.settings.moveRuleLater(rule.name)}
                  onClick={() => void handleMoveRule(account.id, rule.id, 1)}
                >
                  {strings.settings.moveLater}
                </button>
              </div>
              <button
                type="button"
                className="rule-toggle"
                aria-pressed={rule.enabled}
                aria-label={`${rule.name}: ${
                  rule.enabled ? strings.common.on : strings.common.off
                }`}
                onClick={() => void handleToggleRule(account.id, rule)}
              >
                {rule.enabled ? strings.common.on : strings.common.off}
              </button>
              <button
                type="button"
                className="secondary-button rule-delete"
                onClick={() => void handleDeleteRule(account.id, rule)}
              >
                {strings.common.remove}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="rule-form">
        <label htmlFor={`rule-name-${account.id}`}>
          {strings.settings.ruleName}
        </label>
        <input
          id={`rule-name-${account.id}`}
          value={draft.name}
          placeholder={strings.settings.ruleNamePlaceholder}
          onChange={(event) =>
            change((current) => ({ ...current, name: event.target.value }))
          }
        />
        <fieldset className="rule-group">
          <legend>{strings.settings.conditionsLegend}</legend>
          <fieldset className="rule-match-mode">
            <legend>{strings.settings.matchModeLegend}</legend>
            <label>
              <input
                type="radio"
                name={`rule-match-${account.id}`}
                value="all"
                checked={draft.matchMode === "all"}
                onChange={() =>
                  change((current) => ({ ...current, matchMode: "all" }))
                }
              />
              {strings.settings.matchAll}
            </label>
            <label>
              <input
                type="radio"
                name={`rule-match-${account.id}`}
                value="any"
                checked={draft.matchMode === "any"}
                onChange={() =>
                  change((current) => ({ ...current, matchMode: "any" }))
                }
              />
              {strings.settings.matchAny}
            </label>
          </fieldset>
          {draft.conditions.map((condition, index) => {
            const position = index + 1;
            return (
              <div className="rule-row rule-condition-row" key={index}>
                <label htmlFor={`rule-cond-field-${account.id}-${index}`}>
                  {numbered(strings.settings.matchBy, position)}
                </label>
                <select
                  id={`rule-cond-field-${account.id}-${index}`}
                  value={condition.field}
                  onChange={(event) =>
                    change((current) => ({
                      ...current,
                      conditions: patchAt(current.conditions, index, {
                        field: event.target.value,
                      }),
                    }))
                  }
                >
                  {FIELDS.map((field) => (
                    <option key={field} value={field}>
                      {fieldLabel(field)}
                    </option>
                  ))}
                </select>
                <label htmlFor={`rule-cond-value-${account.id}-${index}`}>
                  {numbered(strings.settings.ruleContains, position)}
                </label>
                <input
                  id={`rule-cond-value-${account.id}-${index}`}
                  value={condition.value}
                  maxLength={MAX_RULE_VALUE_CHARS}
                  placeholder={strings.settings.ruleMatchPlaceholder}
                  onChange={(event) =>
                    change((current) => ({
                      ...current,
                      conditions: patchAt(current.conditions, index, {
                        value: event.target.value,
                      }),
                    }))
                  }
                />
                <button
                  type="button"
                  className="secondary-button"
                  disabled={draft.conditions.length === 1}
                  aria-label={strings.settings.removeCondition(position)}
                  onClick={() =>
                    change((current) => ({
                      ...current,
                      conditions: current.conditions.filter(
                        (_, i) => i !== index,
                      ),
                    }))
                  }
                >
                  {strings.common.remove}
                </button>
              </div>
            );
          })}
          <div className="rule-form-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={draft.conditions.length >= MAX_RULE_CONDITIONS}
              onClick={() =>
                change((current) => ({
                  ...current,
                  conditions: [
                    ...current.conditions,
                    { field: "from", value: "" },
                  ],
                }))
              }
            >
              {strings.settings.addCondition}
            </button>
          </div>
        </fieldset>
        <fieldset className="rule-group">
          <legend>{strings.settings.actionsLegend}</legend>
          {draft.actions.map((action, index) => {
            const position = index + 1;
            const moveElsewhere = draft.actions.some(
              (item, i) => i !== index && isMove(item.kind),
            );
            return (
              <div className="rule-row" key={index}>
                <label htmlFor={`rule-action-kind-${account.id}-${index}`}>
                  {numbered(strings.settings.ruleAction, position)}
                </label>
                <select
                  id={`rule-action-kind-${account.id}-${index}`}
                  value={action.kind}
                  onChange={(event) =>
                    change((current) => ({
                      ...current,
                      actions: patchAt(current.actions, index, {
                        kind: event.target.value,
                      }),
                    }))
                  }
                >
                  {ACTION_KINDS.map((kind) => (
                    <option
                      key={kind}
                      value={kind}
                      disabled={moveElsewhere && isMove(kind)}
                    >
                      {kindLabel(kind)}
                    </option>
                  ))}
                </select>
                {action.kind === "move_mailbox" ? (
                  <>
                    <label
                      htmlFor={`rule-action-folder-${account.id}-${index}`}
                    >
                      {numbered(strings.settings.actionFolder, position)}
                    </label>
                    <select
                      id={`rule-action-folder-${account.id}-${index}`}
                      value={action.target}
                      onChange={(event) =>
                        change((current) => ({
                          ...current,
                          actions: patchAt(current.actions, index, {
                            target: event.target.value,
                          }),
                        }))
                      }
                    >
                      <option value="">{strings.settings.chooseFolder}</option>
                      {folders.map((box) => (
                        <option key={box.id} value={box.id}>
                          {box.name}
                        </option>
                      ))}
                    </select>
                  </>
                ) : null}
                {action.kind === "flag" ? (
                  <>
                    <label htmlFor={`rule-action-flag-${account.id}-${index}`}>
                      {numbered(strings.settings.ruleFlagColor, position)}
                    </label>
                    <select
                      id={`rule-action-flag-${account.id}-${index}`}
                      value={action.flagColor}
                      onChange={(event) =>
                        change((current) => ({
                          ...current,
                          actions: patchAt(current.actions, index, {
                            flagColor: event.target.value,
                          }),
                        }))
                      }
                    >
                      {FLAG_KEYS.map((key, color) => (
                        <option key={key} value={String(color)}>
                          {strings.mail.flagColors[key]}
                        </option>
                      ))}
                    </select>
                  </>
                ) : null}
                <button
                  type="button"
                  className="secondary-button"
                  disabled={draft.actions.length === 1}
                  aria-label={strings.settings.removeAction(position)}
                  onClick={() =>
                    change((current) => ({
                      ...current,
                      actions: current.actions.filter((_, i) => i !== index),
                    }))
                  }
                >
                  {strings.common.remove}
                </button>
              </div>
            );
          })}
          <div className="rule-form-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={draft.actions.length >= MAX_RULE_ACTIONS}
              onClick={() =>
                change((current) => ({
                  ...current,
                  actions: [
                    ...current.actions,
                    { kind: "mark_read", target: "", flagColor: "0" },
                  ],
                }))
              }
            >
              {strings.settings.addAction}
            </button>
          </div>
        </fieldset>
        {ruleErrors[account.id] ? (
          <p className="rule-error" role="alert">
            {ruleErrors[account.id]}
          </p>
        ) : null}
        <div className="rule-form-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => void handlePreviewRule(account.id)}
          >
            {strings.settings.checkRuleMatches}
          </button>
          <button
            type="button"
            className="primary-button add-rule-button"
            disabled={savingRuleAccounts[account.id]}
            onClick={() => void handleAddRule(account.id)}
          >
            {strings.settings.addRule}
          </button>
        </div>
      </div>
    </div>
  );
}
