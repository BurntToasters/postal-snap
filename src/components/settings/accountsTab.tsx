import {
  lazy,
  Suspense,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { api } from "../../api";
import { mergeAccountFields } from "../../accountMerge";
import { Mail } from "lucide-react";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type { AccountSummary, FilterRule, MailboxSummary } from "../../types";
import { SyncStatus } from "../mail/syncStatus";
import { AccountDownloadPanel } from "./accountDownload";
import { ConnectionPanel, FoldersPanel } from "./connectionPanel";
import { BodyFormatControl } from "./bodyFormatControl";
import { SettingsPanel, SettingsSection } from "./primitives";

const SignatureEditor = lazy(() =>
  import("./SignatureEditor").then((module) => ({
    default: module.SignatureEditor,
  })),
);

function ruleFieldLabel(field: string): string {
  if (field === "subject") return strings.settings.matchSubject;
  if (field === "to") return strings.settings.matchTo;
  if (field === "domain") return strings.settings.matchDomain;
  return strings.settings.matchFrom;
}

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

// Identity saves run through IPC; a button repeats only a real edit.
function nameChanged(
  account: AccountSummary,
  nameInputs: Record<string, string>,
): boolean {
  return (
    (nameInputs[account.id] ?? account.displayName).trim() !==
    account.displayName
  );
}

function replyToChanged(
  account: AccountSummary,
  replyToInputs: Record<string, string>,
): boolean {
  return (
    (replyToInputs[account.id] ?? account.replyTo ?? "").trim() !==
    (account.replyTo ?? "")
  );
}

// An auto-populated plain fallback counts as an edit of its own.
function signatureChanged(
  account: AccountSummary,
  signatureInputs: Record<string, string>,
  signatureHtmlInputs: Record<string, string>,
): boolean {
  return (
    (signatureInputs[account.id] ?? account.signature ?? "") !==
      (account.signature ?? "") ||
    (signatureHtmlInputs[account.id] ?? account.signatureHtml ?? "") !==
      (account.signatureHtml ?? "")
  );
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
  selectedAccountId?: string;
  initialPage?: "connection" | "folders" | "identity" | "rules";
  onSelectAccount: (id?: string) => void;
  onOpenOutbox: (accountId: string) => void;
  beforeNavigate: () => Promise<boolean>;
  onConnectionDirty: (dirty: boolean) => void;
  mailboxes: MailboxSummary[];
  testingAccountId?: string;
  testedHealthy?: string;
  testAccount: (id: string) => Promise<void>;
  removeAccount: (id: string, name: string) => Promise<void>;
  passwordInputs: Record<string, string>;
  setPasswordInputs: Dispatch<SetStateAction<Record<string, string>>>;
  passwordStatus: Record<string, string>;
  updatingPasswordId?: string;
  handleUpdatePassword: (accountId: string) => Promise<void>;
  nameInputs: Record<string, string>;
  setNameInputs: Dispatch<SetStateAction<Record<string, string>>>;
  nameStatus: Record<string, string>;
  savingNameId?: string;
  handleSaveName: (accountId: string) => Promise<void>;
  replyToInputs: Record<string, string>;
  setReplyToInputs: Dispatch<SetStateAction<Record<string, string>>>;
  replyToStatus: Record<string, string>;
  savingReplyToId?: string;
  handleSaveReplyTo: (accountId: string) => Promise<void>;
  signatureInputs: Record<string, string>;
  setSignatureInputs: Dispatch<SetStateAction<Record<string, string>>>;
  signatureHtmlInputs: Record<string, string>;
  setSignatureHtmlInputs: Dispatch<SetStateAction<Record<string, string>>>;
  signatureStatus: Record<string, string>;
  savingSignatureId?: string;
  handleSaveSignature: (
    accountId: string,
    fallback: string,
    fallbackHtml: string,
  ) => Promise<void>;
  filterRules: Record<string, FilterRule[]>;
  ruleInput: (accountId: string) => AccountRuleDraft;
  setRuleField: (accountId: string, patch: Record<string, string>) => void;
  handleAddRule: (accountId: string) => Promise<void>;
  handlePreviewRule: (accountId: string) => Promise<void>;
  handleMoveRule: (
    accountId: string,
    ruleId: string,
    direction: -1 | 1,
  ) => Promise<void>;
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
  selectedAccountId,
  initialPage = "connection",
  onSelectAccount,
  onOpenOutbox,
  beforeNavigate,
  onConnectionDirty,
  mailboxes,
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
  filterRules,
  ruleInput,
  setRuleField,
  handleAddRule,
  handlePreviewRule,
  handleMoveRule,
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
  const setAccounts = useAppStore((state) => state.setAccounts);
  const [movingId, setMovingId] = useState<string>();
  const [orderError, setOrderError] = useState("");
  const [colorError, setColorError] = useState("");
  const [page, setPage] = useState<
    "connection" | "folders" | "identity" | "rules"
  >(initialPage);
  async function navigate(next: typeof page) {
    if (next !== page && (await beforeNavigate())) setPage(next);
  }
  async function moveAccount(id: string, direction: -1 | 1) {
    const ids = accounts.map((item) => item.id);
    const index = ids.indexOf(id);
    const target = index + direction;
    if (movingId || index < 0 || target < 0 || target >= ids.length) return;
    const ordered = ids.slice();
    const [moved] = ordered.splice(index, 1);
    ordered.splice(target, 0, moved!);
    setMovingId(id);
    setOrderError("");
    try {
      setAccounts(await api.reorderAccounts(ordered));
    } catch {
      setOrderError(strings.settings.accountOrderFailed);
    } finally {
      setMovingId(undefined);
    }
  }
  async function chooseColor(accountId: string, color: string) {
    const current = accounts.find((item) => item.id === accountId);
    if (!current || current.color === color) return;
    setColorError("");
    try {
      const updated = await api.updateAccountColor(accountId, color);
      mergeAccountFields(accountId, { color: updated.color });
    } catch {
      setColorError(strings.settings.accountColorFailed);
    }
  }

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
      {!selectedAccountId ? (
        accounts.length > 0 ? (
          <div className="account-overview">
            {orderError ? (
              <p className="settings-error-message" role="alert">
                {orderError}
              </p>
            ) : null}
            {accounts.map((account, index) => {
              const name = account.displayName || account.email;
              return (
                <div key={account.id} className="account-overview-item">
                  <button
                    type="button"
                    className="account-overview-row"
                    aria-label={strings.settings.manageAccount(name)}
                    onClick={() => {
                      setPage("connection");
                      onSelectAccount(account.id);
                    }}
                  >
                    <Mail aria-hidden="true" />
                    <span>
                      <strong>{name}</strong>
                      <small>{account.email}</small>
                      {account.error ? (
                        <small role="alert">{account.error}</small>
                      ) : null}
                    </span>
                    <SyncStatus account={account} sync={undefined} />
                  </button>
                  {accounts.length > 1 ? (
                    <div className="account-overview-order">
                      <button
                        type="button"
                        className="secondary-button"
                        aria-label={strings.settings.moveAccountUp(name)}
                        disabled={Boolean(movingId) || index === 0}
                        onClick={() => void moveAccount(account.id, -1)}
                      >
                        {strings.settings.moveUp}
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        aria-label={strings.settings.moveAccountDown(name)}
                        disabled={
                          Boolean(movingId) || index === accounts.length - 1
                        }
                        onClick={() => void moveAccount(account.id, 1)}
                      >
                        {strings.settings.moveDown}
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null
      ) : (
        <>
          <button
            className="text-button"
            type="button"
            onClick={() => {
              void beforeNavigate().then((leave) => {
                if (leave) onSelectAccount(undefined);
              });
            }}
          >
            {strings.settings.backAccounts}
          </button>
          <nav
            className="account-detail-nav"
            aria-label={strings.settings.accounts}
          >
            {(["connection", "folders", "identity", "rules"] as const).map(
              (id) => (
                <button
                  key={id}
                  type="button"
                  className={page === id ? "active" : ""}
                  aria-pressed={page === id}
                  onClick={() => void navigate(id)}
                >
                  {id === "connection"
                    ? strings.settings.connection
                    : id === "folders"
                      ? strings.settings.folders
                      : id === "identity"
                        ? strings.settings.identity
                        : strings.settings.rulesSection}
                </button>
              ),
            )}
          </nav>
        </>
      )}
      {selectedAccountId ? (
        <div className="account-settings-list">
          {accounts
            .filter((account) => account.id === selectedAccountId)
            .map((account) => (
              <div key={account.id} className="account-settings-card">
                <div className="account-card-header">
                  <Mail />
                  <span className="account-card-info">
                    <strong>{account.displayName || account.email}</strong>
                    <small>
                      {account.provider === "icloud"
                        ? strings.setup.icloud
                        : account.provider === "protonBridge"
                          ? strings.setup.bridge
                          : account.provider === "gmail"
                            ? strings.setup.gmail
                            : account.provider === "outlook"
                              ? strings.setup.outlook
                              : strings.setup.other}
                      {" · "}
                      {account.email}
                    </small>
                    {testedHealthy === account.id ? (
                      <small className="account-connection-healthy">
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
                {page === "connection" ? (
                  <>
                    <ConnectionPanel
                      account={account}
                      onDirty={onConnectionDirty}
                      onOpenOutbox={onOpenOutbox}
                    />
                    <AccountDownloadPanel
                      key={account.id}
                      accountId={account.id}
                    />
                  </>
                ) : null}
                {page === "folders" ? (
                  <FoldersPanel accountId={account.id} mailboxes={mailboxes} />
                ) : null}
                {page === "connection" &&
                (account.authMethod ?? "password") === "password" ? (
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
                    {passwordStatus[account.id] ? (
                      <div
                        className="alias-status-message"
                        role="status"
                        aria-live="polite"
                      >
                        {passwordStatus[account.id]}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {page === "identity" ? (
                  <>
                    <div className="account-password-section">
                      <span
                        className="account-section-title"
                        id={`account-color-${account.id}`}
                      >
                        {strings.settings.accountColor}
                      </span>
                      <p className="settings-note">
                        {strings.settings.accountColorHelp}
                      </p>
                      <div
                        className="account-color-picker"
                        role="radiogroup"
                        aria-labelledby={`account-color-${account.id}`}
                      >
                        {(
                          Object.keys(strings.settings.accountColors) as Array<
                            keyof typeof strings.settings.accountColors
                          >
                        ).map((color) => (
                          <button
                            key={color}
                            type="button"
                            role="radio"
                            className="account-color-swatch"
                            data-color={color}
                            aria-label={strings.settings.accountColors[color]}
                            aria-checked={account.color === color}
                            onClick={() => void chooseColor(account.id, color)}
                          />
                        ))}
                      </div>
                      {colorError ? (
                        <p className="settings-error-message" role="alert">
                          {colorError}
                        </p>
                      ) : null}
                    </div>
                    <div className="account-password-section">
                      <label htmlFor={`account-name-${account.id}`}>
                        {strings.settings.accountName}
                      </label>
                      <p className="settings-note">
                        {strings.settings.accountNameHelp}
                      </p>
                      <div className="add-alias-form">
                        <input
                          id={`account-name-${account.id}`}
                          maxLength={120}
                          value={nameInputs[account.id] ?? account.displayName}
                          onChange={(event) =>
                            setNameInputs((prev) => ({
                              ...prev,
                              [account.id]: event.target.value,
                            }))
                          }
                        />
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={
                            savingNameId === account.id ||
                            !nameChanged(account, nameInputs)
                          }
                          onClick={() => void handleSaveName(account.id)}
                        >
                          {strings.settings.saveAccountName}
                        </button>
                      </div>
                      {nameStatus[account.id] ? (
                        <div
                          className="alias-status-message"
                          role="status"
                          aria-live="polite"
                        >
                          {nameStatus[account.id]}
                        </div>
                      ) : null}
                    </div>
                    <div className="account-password-section">
                      <label htmlFor={`account-reply-to-${account.id}`}>
                        {strings.settings.replyToAddress}
                      </label>
                      <p className="settings-note">
                        {strings.settings.replyToAddressHelp}
                      </p>
                      <div className="add-alias-form">
                        <input
                          id={`account-reply-to-${account.id}`}
                          maxLength={320}
                          autoComplete="off"
                          spellCheck={false}
                          value={
                            replyToInputs[account.id] ?? account.replyTo ?? ""
                          }
                          onChange={(event) =>
                            setReplyToInputs((prev) => ({
                              ...prev,
                              [account.id]: event.target.value,
                            }))
                          }
                        />
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={
                            savingReplyToId === account.id ||
                            !replyToChanged(account, replyToInputs)
                          }
                          onClick={() => void handleSaveReplyTo(account.id)}
                        >
                          {strings.settings.saveReplyTo}
                        </button>
                      </div>
                      {replyToStatus[account.id] ? (
                        <div
                          className={
                            replyToStatus[account.id] ===
                            strings.settings.replyToAddressInvalid
                              ? "settings-error-message"
                              : "alias-status-message"
                          }
                          role={
                            replyToStatus[account.id] ===
                            strings.settings.replyToAddressInvalid
                              ? "alert"
                              : "status"
                          }
                          aria-live="polite"
                        >
                          {replyToStatus[account.id]}
                        </div>
                      ) : null}
                    </div>
                    <div className="account-password-section">
                      <Suspense
                        fallback={
                          <p className="signature-rich-help">
                            {strings.settings.signatureEditorHelp}
                          </p>
                        }
                      >
                        <SignatureEditor
                          key={account.id}
                          accountId={account.id}
                          plainText={
                            signatureInputs[account.id] ??
                            account.signature ??
                            ""
                          }
                          html={
                            signatureHtmlInputs[account.id] ??
                            account.signatureHtml ??
                            ""
                          }
                          onPlainTextChange={(value) =>
                            setSignatureInputs((prev) => ({
                              ...prev,
                              [account.id]: value,
                            }))
                          }
                          onHtmlChange={(plainText, value) => {
                            setSignatureInputs((prev) => ({
                              ...prev,
                              [account.id]: plainText,
                            }));
                            setSignatureHtmlInputs((prev) => ({
                              ...prev,
                              [account.id]: value,
                            }));
                          }}
                        />
                      </Suspense>
                      <div className="add-alias-form signature-form">
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={
                            savingSignatureId === account.id ||
                            !signatureChanged(
                              account,
                              signatureInputs,
                              signatureHtmlInputs,
                            )
                          }
                          onClick={() =>
                            void handleSaveSignature(
                              account.id,
                              account.signature ?? "",
                              account.signatureHtml ?? "",
                            )
                          }
                        >
                          {strings.common.save}
                        </button>
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
                    </div>

                    <BodyFormatControl account={account} />
                  </>
                ) : null}

                {page === "rules" ? (
                  <div className="account-rules-section">
                    <div className="aliases-header">
                      <div>
                        <strong>{strings.settings.rulesTitle}</strong>
                        <p className="settings-note">
                          {strings.settings.rulesHelp}
                        </p>
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
                        {(filterRules[account.id] ?? []).map(
                          (rule, index, rules) => (
                            <li className="rule-item" key={rule.id}>
                              <div className="rule-item-text">
                                <strong>{rule.name}</strong>
                                <span>
                                  {strings.settings.describeRule(
                                    ruleFieldLabel(rule.field),
                                    rule.contains,
                                    ruleActionLabel(rule, mailboxes),
                                  )}
                                </span>
                              </div>
                              <div className="rule-order">
                                <button
                                  type="button"
                                  className="secondary-button"
                                  disabled={index === 0}
                                  aria-label={strings.settings.moveRuleEarlier(
                                    rule.name,
                                  )}
                                  onClick={() =>
                                    void handleMoveRule(account.id, rule.id, -1)
                                  }
                                >
                                  {strings.settings.moveEarlier}
                                </button>
                                <button
                                  type="button"
                                  className="secondary-button"
                                  disabled={index === rules.length - 1}
                                  aria-label={strings.settings.moveRuleLater(
                                    rule.name,
                                  )}
                                  onClick={() =>
                                    void handleMoveRule(account.id, rule.id, 1)
                                  }
                                >
                                  {strings.settings.moveLater}
                                </button>
                              </div>
                              <button
                                type="button"
                                className="rule-toggle"
                                aria-pressed={rule.enabled}
                                aria-label={`${rule.name}: ${
                                  rule.enabled
                                    ? strings.common.on
                                    : strings.common.off
                                }`}
                                onClick={() =>
                                  void handleToggleRule(account.id, rule)
                                }
                              >
                                {rule.enabled
                                  ? strings.common.on
                                  : strings.common.off}
                              </button>
                              <button
                                type="button"
                                className="secondary-button rule-delete"
                                onClick={() =>
                                  void handleDeleteRule(account.id, rule)
                                }
                              >
                                {strings.common.remove}
                              </button>
                            </li>
                          ),
                        )}
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
                        <option value="from">
                          {strings.settings.matchFrom}
                        </option>
                        <option value="to">{strings.settings.matchTo}</option>
                        <option value="subject">
                          {strings.settings.matchSubject}
                        </option>
                        <option value="domain">
                          {strings.settings.matchDomain}
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
                            <option value="">
                              {strings.settings.chooseFolder}
                            </option>
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
                          onClick={() => void handleAddRule(account.id)}
                        >
                          {strings.settings.addRule}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}

                {page === "identity" ? (
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
                            onClick={() =>
                              void handleRemoveAlias(account.id, alias)
                            }
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
                ) : null}
              </div>
            ))}
        </div>
      ) : null}
      {!selectedAccountId ? (
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
      ) : null}
    </SettingsPanel>
  );
}
