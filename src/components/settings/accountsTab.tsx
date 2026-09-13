import type { Dispatch, SetStateAction } from "react";
import { Mail } from "lucide-react";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type { FilterRule, MailboxSummary } from "../../types";
import { SettingsPanel, SettingsSection } from "./primitives";

function ruleActionLabel(
  rule: FilterRule,
  mailboxes: MailboxSummary[],
): string {
  switch (rule.action) {
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
          box.accountId === rule.accountId &&
          String(box.id) === (rule.targetMailbox ?? ""),
      );
      return target
        ? strings.settings.actionMoveToFolder(target.displayName || target.name)
        : strings.settings.actionFolder;
    }
    default:
      return rule.action;
  }
}

export interface AccountRuleDraft {
  name: string;
  field: string;
  contains: string;
  action: string;
  target: string;
}

interface AccountsTabProps {
  onClose: () => void;
  testingAccountId?: string;
  testedHealthy?: string;
  testAccount: (id: string) => Promise<void>;
  removeAccount: (id: string, name: string) => Promise<void>;
  passwordInputs: Record<string, string>;
  setPasswordInputs: Dispatch<SetStateAction<Record<string, string>>>;
  passwordStatus: Record<string, string>;
  updatingPasswordId?: string;
  handleUpdatePassword: (accountId: string) => Promise<void>;
  signatureInputs: Record<string, string>;
  setSignatureInputs: Dispatch<SetStateAction<Record<string, string>>>;
  signatureStatus: Record<string, string>;
  savingSignatureId?: string;
  handleSaveSignature: (accountId: string, fallback: string) => Promise<void>;
  filterRules: Record<string, FilterRule[]>;
  ruleInput: (accountId: string) => AccountRuleDraft;
  setRuleField: (accountId: string, patch: Record<string, string>) => void;
  handleAddRule: (accountId: string) => Promise<void>;
  handleToggleRule: (accountId: string, rule: FilterRule) => Promise<void>;
  handleDeleteRule: (accountId: string, rule: FilterRule) => Promise<void>;
  ruleStatus: Record<string, string>;
  detectingAliasesAccountId?: string;
  handleDetectAliases: (accountId: string) => Promise<void>;
  aliasStatus: Record<string, string>;
  newAliasInputs: Record<string, string>;
  setNewAliasInputs: Dispatch<SetStateAction<Record<string, string>>>;
  handleAddAlias: (accountId: string) => Promise<void>;
  handleRemoveAlias: (accountId: string, alias: string) => Promise<void>;
  eraseBusy: boolean;
  eraseStatus?: string;
  eraseAllData: () => Promise<void>;
}

export function AccountsTab({
  onClose,
  testingAccountId,
  testedHealthy,
  testAccount,
  removeAccount,
  passwordInputs,
  setPasswordInputs,
  passwordStatus,
  updatingPasswordId,
  handleUpdatePassword,
  signatureInputs,
  setSignatureInputs,
  signatureStatus,
  savingSignatureId,
  handleSaveSignature,
  filterRules,
  ruleInput,
  setRuleField,
  handleAddRule,
  handleToggleRule,
  handleDeleteRule,
  ruleStatus,
  detectingAliasesAccountId,
  handleDetectAliases,
  aliasStatus,
  newAliasInputs,
  setNewAliasInputs,
  handleAddAlias,
  handleRemoveAlias,
  eraseBusy,
  eraseStatus,
  eraseAllData,
}: AccountsTabProps) {
  const accounts = useAppStore((state) => state.accounts);
  const mailboxes = useAppStore((state) => state.mailboxes);

  return (
    <SettingsPanel id="accounts" title={strings.settings.accounts}>
      {accounts.length === 0 ? (
        <div className="settings-empty-state">
          <Mail />
          <p>{strings.settings.noAccounts}</p>
          <button type="button" className="secondary-button" onClick={onClose}>
            {strings.settings.returnToSetup}
          </button>
        </div>
      ) : null}
      <div className="account-settings-list">
        {accounts.map((account) => (
          <div key={account.id} className="account-settings-card">
            <div className="account-card-header">
              <Mail />
              <span className="account-card-info">
                <strong>{account.displayName || account.email}</strong>
                <small>
                  {account.provider === "icloud"
                    ? strings.setup.icloud
                    : strings.setup.other}
                  {" · "}
                  {account.email}
                </small>
                {testedHealthy === account.id ? (
                  <small style={{ color: "var(--success)" }}>
                    ✓ {strings.settings.connectionHealthy}
                  </small>
                ) : null}
              </span>
              <div className="account-card-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void testAccount(account.id)}
                  disabled={testingAccountId === account.id}
                >
                  {testingAccountId === account.id
                    ? strings.settings.testingConnection
                    : strings.settings.testConnection}
                </button>
                <button
                  type="button"
                  className="danger-button"
                  onClick={() =>
                    void removeAccount(
                      account.id,
                      account.displayName || account.email,
                    )
                  }
                >
                  {strings.common.remove}
                </button>
              </div>
            </div>

            {account.error ? (
              <p className="account-error" role="alert">
                {account.error}
              </p>
            ) : null}
            {(account.authMethod ?? "password") === "password" ? (
              <div className="account-password-section">
                <label htmlFor={`account-password-${account.id}`}>
                  {strings.settings.updatePassword}
                </label>
                <form
                  className="add-alias-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleUpdatePassword(account.id);
                  }}
                >
                  <input
                    id={`account-password-${account.id}`}
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    placeholder={
                      account.provider === "icloud"
                        ? (strings.setup.appPasswordPlaceholder ??
                          strings.settings.newPassword)
                        : strings.settings.newPassword
                    }
                    value={passwordInputs[account.id] ?? ""}
                    onChange={(event) =>
                      setPasswordInputs((prev) => ({
                        ...prev,
                        [account.id]: event.target.value,
                      }))
                    }
                  />
                  <button
                    type="submit"
                    className="secondary-button"
                    disabled={
                      updatingPasswordId === account.id ||
                      !(passwordInputs[account.id] ?? "").trim()
                    }
                  >
                    {updatingPasswordId === account.id
                      ? strings.settings.testingConnection
                      : strings.settings.updatePassword}
                  </button>
                </form>
              </div>
            ) : null}
            {passwordStatus[account.id] ? (
              <div
                className="alias-status-message"
                role="status"
                aria-live="polite"
              >
                {passwordStatus[account.id]}
              </div>
            ) : null}
            <div className="account-password-section">
              <label htmlFor={`account-signature-${account.id}`}>
                {strings.settings.signature}
              </label>
              <p className="settings-note">{strings.settings.signatureHelp}</p>
              <div className="add-alias-form signature-form">
                <textarea
                  id={`account-signature-${account.id}`}
                  rows={3}
                  maxLength={2000}
                  placeholder={strings.settings.signaturePlaceholder}
                  value={signatureInputs[account.id] ?? account.signature ?? ""}
                  onChange={(event) =>
                    setSignatureInputs((prev) => ({
                      ...prev,
                      [account.id]: event.target.value,
                    }))
                  }
                />
                <button
                  type="button"
                  className="secondary-button"
                  disabled={savingSignatureId === account.id}
                  onClick={() =>
                    void handleSaveSignature(
                      account.id,
                      account.signature ?? "",
                    )
                  }
                >
                  {strings.common.save}
                </button>
              </div>
              {signatureStatus[account.id] ? (
                <div
                  className="alias-status-message"
                  role="status"
                  aria-live="polite"
                >
                  {signatureStatus[account.id]}
                </div>
              ) : null}
            </div>

            <div className="account-rules-section">
              <div className="aliases-header">
                <div>
                  <strong>{strings.settings.rulesTitle}</strong>
                  <p className="settings-note">{strings.settings.rulesHelp}</p>
                </div>
              </div>
              {ruleStatus[account.id] ? (
                <div
                  className="alias-status-message"
                  role="status"
                  aria-live="polite"
                >
                  {ruleStatus[account.id]}
                </div>
              ) : null}
              {(filterRules[account.id] ?? []).length > 0 ? (
                <ul className="rule-list">
                  {(filterRules[account.id] ?? []).map((rule) => (
                    <li className="rule-item" key={rule.id}>
                      <div className="rule-item-text">
                        <strong>{rule.name}</strong>
                        <span>
                          {strings.settings.describeRule(
                            rule.field === "from"
                              ? strings.settings.matchFrom
                              : strings.settings.matchSubject,
                            rule.contains,
                            ruleActionLabel(rule, mailboxes),
                          )}
                        </span>
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
                  value={ruleInput(account.id).name}
                  placeholder={strings.settings.ruleNamePlaceholder}
                  onChange={(event) =>
                    setRuleField(account.id, {
                      name: event.target.value,
                    })
                  }
                />
                <label htmlFor={`rule-field-${account.id}`}>
                  {strings.settings.matchBy}
                </label>
                <select
                  id={`rule-field-${account.id}`}
                  value={ruleInput(account.id).field}
                  onChange={(event) =>
                    setRuleField(account.id, {
                      field: event.target.value,
                    })
                  }
                >
                  <option value="from">{strings.settings.matchFrom}</option>
                  <option value="subject">
                    {strings.settings.matchSubject}
                  </option>
                </select>
                <label htmlFor={`rule-contains-${account.id}`}>
                  {strings.settings.ruleContains}
                </label>
                <input
                  id={`rule-contains-${account.id}`}
                  value={ruleInput(account.id).contains}
                  placeholder={strings.settings.ruleMatchPlaceholder}
                  onChange={(event) =>
                    setRuleField(account.id, {
                      contains: event.target.value,
                    })
                  }
                />
                <label htmlFor={`rule-action-${account.id}`}>
                  {strings.settings.ruleAction}
                </label>
                <select
                  id={`rule-action-${account.id}`}
                  value={ruleInput(account.id).action}
                  onChange={(event) =>
                    setRuleField(account.id, {
                      action: event.target.value,
                    })
                  }
                >
                  <option value="mark_read">
                    {strings.settings.actionMarkRead}
                  </option>
                  <option value="move_archive">
                    {strings.settings.actionArchive}
                  </option>
                  <option value="move_trash">
                    {strings.settings.actionTrash}
                  </option>
                  <option value="move_junk">
                    {strings.settings.actionJunk}
                  </option>
                  <option value="move_mailbox">
                    {strings.settings.actionFolder}
                  </option>
                </select>
                {ruleInput(account.id).action === "move_mailbox" ? (
                  <>
                    <label htmlFor={`rule-target-${account.id}`}>
                      {strings.settings.actionFolder}
                    </label>
                    <select
                      id={`rule-target-${account.id}`}
                      value={ruleInput(account.id).target}
                      onChange={(event) =>
                        setRuleField(account.id, {
                          target: event.target.value,
                        })
                      }
                    >
                      <option value="">{strings.settings.chooseFolder}</option>
                      {mailboxes
                        .filter(
                          (box) =>
                            box.accountId === account.id &&
                            box.role !== "trash" &&
                            box.role !== "junk" &&
                            box.role !== "inbox",
                        )
                        .map((box) => (
                          <option key={box.id} value={box.id}>
                            {box.name}
                          </option>
                        ))}
                    </select>
                  </>
                ) : null}
                <button
                  type="button"
                  className="primary-button add-rule-button"
                  onClick={() => void handleAddRule(account.id)}
                >
                  {strings.settings.addRule}
                </button>
              </div>
            </div>

            <div className="account-aliases-section">
              <div className="aliases-header">
                <div>
                  <strong>{strings.settings.aliasesTitle}</strong>
                  <p className="settings-note">
                    {strings.settings.aliasesHelp}
                  </p>
                </div>
                {account.provider === "icloud" ? (
                  <button
                    type="button"
                    className="secondary-button detect-aliases-button"
                    onClick={() => void handleDetectAliases(account.id)}
                    disabled={detectingAliasesAccountId === account.id}
                  >
                    {detectingAliasesAccountId === account.id
                      ? strings.settings.detectingAliases
                      : strings.settings.detectIcloudAliases}
                  </button>
                ) : null}
              </div>

              {aliasStatus[account.id] ? (
                <div
                  className="alias-status-message"
                  role="status"
                  aria-live="polite"
                >
                  {aliasStatus[account.id]}
                </div>
              ) : null}

              <div className="aliases-list">
                <div className="alias-chip primary">
                  <span>{account.email}</span>
                  <span className="alias-badge">
                    {strings.settings.primaryAddress}
                  </span>
                </div>
                {(account.aliases ?? []).map((alias) => (
                  <div key={alias} className="alias-chip">
                    <span>{alias}</span>
                    <button
                      type="button"
                      onClick={() => void handleRemoveAlias(account.id, alias)}
                      aria-label={`${strings.common.remove} ${alias}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              {(account.aliases ?? []).length === 0 ? (
                <p className="settings-note">
                  {strings.settings.noAliasesConfigured}
                </p>
              ) : null}

              <div className="add-alias-form">
                <input
                  type="email"
                  placeholder={strings.settings.aliasPlaceholder}
                  aria-label={strings.settings.aliasPlaceholder}
                  value={newAliasInputs[account.id] ?? ""}
                  onChange={(e) =>
                    setNewAliasInputs((prev) => ({
                      ...prev,
                      [account.id]: e.target.value,
                    }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleAddAlias(account.id);
                    }
                  }}
                />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleAddAlias(account.id)}
                >
                  {strings.settings.addAlias}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <SettingsSection title={strings.settings.dangerZone}>
        <div className="settings-data-card danger-card">
          <div>
            <strong>{strings.settings.eraseTitle}</strong>
            <small>{strings.settings.eraseHelp}</small>
          </div>
          <div className="settings-actions">
            <button
              className="danger-button"
              type="button"
              onClick={() => void eraseAllData()}
              disabled={eraseBusy}
            >
              {eraseBusy
                ? strings.settings.saving
                : strings.settings.eraseButton}
            </button>
          </div>
          {eraseStatus ? (
            <small className="settings-data-status" role="status">
              {eraseStatus}
            </small>
          ) : null}
        </div>
      </SettingsSection>
    </SettingsPanel>
  );
}
