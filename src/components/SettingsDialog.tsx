import {
  useCallback,
  useEffect,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  Bell,
  Database,
  DownloadCloud,
  Eye,
  Keyboard,
  Mail,
  Monitor,
  RotateCcw,
  ShieldCheck,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { api } from "../api";
import { strings } from "../i18n";
import { shortcutMod, shortcutShiftMod } from "../format";
import { applySettings } from "../settings";
import { useAppStore } from "../store";
import { supportsWorkspaceWindowFx } from "../window-fx";
import type {
  AppSettings,
  CacheUsage,
  DistributionChannel,
  FilterRule,
} from "../types";
import {
  checkUpdateInteractive,
  removeUpdateFoundListener,
  type UpdateFoundListener,
} from "../update";
import { useDialogFocus } from "./useDialogFocus";

interface Props {
  onClose: () => void;
  initialTab?: SettingsTab;
}

export type SettingsTab =
  | "general"
  | "reading"
  | "notifications"
  | "storage"
  | "accounts"
  | "shortcuts"
  | "updates";

const tabs: Array<{
  id: SettingsTab;
  label: string;
  icon: typeof Monitor;
}> = [
  { id: "general", label: strings.settings.general, icon: Monitor },
  { id: "reading", label: strings.settings.reading, icon: Eye },
  { id: "notifications", label: strings.settings.notifications, icon: Bell },
  { id: "storage", label: strings.settings.storage, icon: Database },
  { id: "accounts", label: strings.settings.accounts, icon: UserRound },
  { id: "shortcuts", label: strings.settings.shortcuts, icon: Keyboard },
  { id: "updates", label: strings.settings.updates, icon: DownloadCloud },
];

export function SettingsDialog({ onClose, initialTab = "general" }: Props) {
  const settings = useAppStore((state) => state.settings);
  const accounts = useAppStore((state) => state.accounts);
  const mailboxes = useAppStore((state) => state.mailboxes);
  const setAccounts = useAppStore((state) => state.setAccounts);
  const setSettings = useAppStore((state) => state.setSettings);
  const setError = useAppStore((state) => state.setError);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [usage, setUsage] = useState<CacheUsage>();
  const [distribution, setDistribution] = useState<DistributionChannel>();
  const [windowFxSupported, setWindowFxSupported] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<string>(
    strings.settings.checkUpdates,
  );
  const [saving, setSaving] = useState(false);
  const [dataBusy, setDataBusy] = useState(false);
  const [dataStatus, setDataStatus] = useState<string>();
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [testingAccountId, setTestingAccountId] = useState<string>();
  const [testedHealthy, setTestedHealthy] = useState<string>();
  const updateReady = useAppStore((state) => state.updateReady);
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
  const [signatureInputs, setSignatureInputs] = useState<
    Record<string, string>
  >({});
  const [signatureStatus, setSignatureStatus] = useState<
    Record<string, string>
  >({});
  const [savingSignatureId, setSavingSignatureId] = useState<string>();
  const [filterRules, setFilterRules] = useState<Record<string, FilterRule[]>>(
    {},
  );
  const [newRuleInputs, setNewRuleInputs] = useState<
    Record<
      string,
      {
        name: string;
        field: string;
        contains: string;
        action: string;
        target: string;
      }
    >
  >({});
  const [ruleStatus, setRuleStatus] = useState<Record<string, string>>({});
  const dialogRef = useDialogFocus(onClose);

  const handleUpdateFound = useCallback<UpdateFoundListener>((version) => {
    setUpdateStatus(strings.settings.installing(version ?? ""));
  }, []);

  useEffect(
    () => () => removeUpdateFoundListener(handleUpdateFound),
    [handleUpdateFound],
  );

  useEffect(() => {
    if (tab !== "accounts") return;
    let active = true;
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
  }, [tab, accounts]);
  useEffect(() => {
    let active = true;
    void api
      .cacheUsage()
      .then((u) => {
        if (active) setUsage(u);
      })
      .catch(() => undefined);
    void api
      .distribution()
      .then((d) => {
        if (active) setDistribution(d);
      })
      .catch(() => undefined);
    void supportsWorkspaceWindowFx().then((supported) => {
      if (active) setWindowFxSupported(supported);
    });
    return () => {
      active = false;
    };
  }, []);

  async function update(patch: Partial<AppSettings>) {
    if (saving) return;
    const previous = settings;
    const next = { ...settings, ...patch };
    setSaving(true);
    setSettings(next);
    applySettings(next);
    try {
      const saved = await api.saveSettings(next);
      setSettings(saved);
      applySettings(saved);
    } catch (cause) {
      setSettings(previous);
      applySettings(previous);
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  }

  async function clearCache() {
    const confirmed = await api.showNativeConfirm(
      strings.settings.clearMail,
      strings.settings.clearMailQuestion,
    );
    if (!confirmed) return;
    try {
      await api.clearCache();
      setUsage(await api.cacheUsage());
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function exportSettings() {
    if (dataBusy) return;
    setDataBusy(true);
    setDataStatus(undefined);
    try {
      if (await api.exportSettings())
        setDataStatus(strings.settings.exportSaved);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setDataBusy(false);
    }
  }

  async function importSettings() {
    if (dataBusy) return;
    const confirmed = await api.showNativeConfirm(
      strings.settings.importSettings,
      strings.settings.importQuestion,
    );
    if (!confirmed) return;
    setDataBusy(true);
    setDataStatus(undefined);
    try {
      const imported = await api.importSettings();
      if (imported) {
        setSettings(imported);
        applySettings(imported);
        setDataStatus(strings.settings.importApplied);
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setDataBusy(false);
    }
  }

  async function resetSettings() {
    if (dataBusy) return;
    const confirmed = await api.showNativeConfirm(
      strings.settings.resetSettings,
      strings.settings.resetQuestion,
    );
    if (!confirmed) return;
    setDataBusy(true);
    setDataStatus(undefined);
    try {
      const reset = await api.resetSettings();
      setSettings(reset);
      applySettings(reset);
      setDataStatus(strings.settings.resetApplied);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setDataBusy(false);
    }
  }

  const checkForUpdates = useCallback(async () => {
    if (checkingUpdate || distribution?.updatesManagedBy !== "postalSnap")
      return;
    setCheckingUpdate(true);
    setUpdateStatus(strings.settings.checking);
    try {
      await checkUpdateInteractive();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setCheckingUpdate(false);
      setUpdateStatus(strings.settings.checkUpdates);
    }
  }, [checkingUpdate, distribution, setError]);

  async function removeAccount(id: string, name: string) {
    const confirmed = await api.showNativeConfirm(
      strings.common.remove,
      strings.settings.removeAccount(name),
    );
    if (!confirmed) return;
    try {
      const result = await api.removeAccount(id);
      const remaining = await api.listAccounts();
      setAccounts(remaining);
      if (result?.cleanupPending) {
        setError(strings.settings.accountCleanupWarning);
      }
      if (remaining.length === 0) onClose();
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function testAccount(id: string) {
    if (testingAccountId) return;
    setTestingAccountId(id);
    setTestedHealthy(undefined);
    try {
      await api.syncAccount(id);
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
      const remaining = await api.listAccounts();
      setAccounts(remaining);
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
    const acc = accounts.find((a) => a.id === accountId);
    if (!acc) return;
    const current = acc.aliases ?? [];
    if (current.includes(input) || acc.email.toLowerCase() === input) {
      setNewAliasInputs((prev) => ({ ...prev, [accountId]: "" }));
      return;
    }
    try {
      await api.updateAccountAliases(accountId, [...current, input]);
      const remaining = await api.listAccounts();
      setAccounts(remaining);
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
    const acc = accounts.find((a) => a.id === accountId);
    if (!acc) return;
    const remainingAliases = (acc.aliases ?? []).filter((a) => a !== alias);
    try {
      await api.updateAccountAliases(accountId, remainingAliases);
      const remaining = await api.listAccounts();
      setAccounts(remaining);
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function handleUpdatePassword(accountId: string) {
    if (updatingPasswordId) return;
    const password = passwordInputs[accountId] ?? "";
    if (!password) return;
    setUpdatingPasswordId(accountId);
    try {
      await api.updateAccountPassword(accountId, password);
      const remaining = await api.listAccounts();
      setAccounts(remaining);
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

  async function handleSaveSignature(accountId: string, fallback: string) {
    if (savingSignatureId) return;
    setSavingSignatureId(accountId);
    try {
      const value = signatureInputs[accountId] ?? fallback;
      const updated = await api.updateAccountSignature(accountId, value);
      setAccounts(
        accounts.map((item) => (item.id === accountId ? updated : item)),
      );
      setSignatureInputs((prev) => ({
        ...prev,
        [accountId]: updated.signature ?? "",
      }));
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

  function ruleInput(accountId: string): {
    name: string;
    field: string;
    contains: string;
    action: string;
    target: string;
  } {
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
      setNewRuleInputs((prev) => ({
        ...prev,
        [accountId]: {
          name: "",
          field: "from",
          contains: "",
          action: "mark_read",
          target: "",
        },
      }));
      setRuleStatus((prev) => ({
        ...prev,
        [accountId]: strings.settings.ruleSaved,
      }));
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

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (
      ![
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
      ].includes(event.key)
    )
      return;
    event.preventDefault();
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (index +
              (event.key === "ArrowRight" || event.key === "ArrowDown"
                ? 1
                : -1) +
              tabs.length) %
            tabs.length;
    const next = tabs[nextIndex].id;
    setTab(next);
    window.setTimeout(
      () => document.getElementById(`settings-tab-${next}`)?.focus(),
      0,
    );
  }

  return (
    <div
      className="modal-layer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
    >
      <button
        className="modal-backdrop"
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClose}
      />
      <section className="settings-window" ref={dialogRef}>
        <header>
          <span>
            <h1 id="settings-title">{strings.settings.title}</h1>
            <small>
              {saving ? strings.settings.saving : strings.settings.autosave}
            </small>
          </span>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label={strings.common.close}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="settings-layout">
          <nav
            className="settings-nav"
            aria-label={strings.settings.sections}
            role="tablist"
          >
            {tabs.map(({ id, label, icon: Icon }, index) => (
              <button
                key={id}
                id={`settings-tab-${id}`}
                type="button"
                role="tab"
                aria-label={label}
                aria-selected={tab === id}
                aria-controls={`settings-${id}`}
                tabIndex={tab === id ? 0 : -1}
                className={tab === id ? "active" : ""}
                onClick={() => setTab(id)}
                onKeyDown={(event) => moveTab(event, index)}
              >
                <Icon aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </nav>
          <div className="settings-content">
            {tab === "general" ? (
              <SettingsPanel id="general" title={strings.settings.general}>
                <SettingRow
                  title={strings.settings.appearance}
                  help={strings.settings.appearanceHelp}
                >
                  <select
                    aria-label={strings.settings.appearance}
                    value={settings.theme}
                    onChange={(event) =>
                      void update({
                        theme: event.target.value as AppSettings["theme"],
                      })
                    }
                  >
                    <option value="system">
                      {strings.settings.followSystem}
                    </option>
                    <option value="light">{strings.settings.light}</option>
                    <option value="dark">{strings.settings.dark}</option>
                  </select>
                </SettingRow>
                <SettingRow
                  title={strings.settings.spacing}
                  help={strings.settings.spacingHelp}
                >
                  <select
                    aria-label={strings.settings.spacing}
                    value={settings.density}
                    onChange={(event) =>
                      void update({
                        density: event.target.value as AppSettings["density"],
                      })
                    }
                  >
                    <option value="comfortable">
                      {strings.settings.comfortable}
                    </option>
                    <option value="compact">{strings.settings.compact}</option>
                  </select>
                </SettingRow>
                {windowFxSupported ? (
                  <label className="switch-row">
                    <span>
                      <strong>{strings.settings.windowEffects}</strong>
                      <small>{strings.settings.windowEffectsHelp}</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={settings.windowEffects}
                      onChange={(event) =>
                        void update({ windowEffects: event.target.checked })
                      }
                    />
                  </label>
                ) : null}
                <SettingRow
                  title={strings.mail.undoSendWindow}
                  help={strings.mail.undoSendHelp}
                >
                  <select
                    aria-label={strings.mail.undoSendWindow}
                    value={settings.undoSendSeconds ?? 10}
                    onChange={(event) =>
                      void update({
                        undoSendSeconds: Number(event.target.value),
                      })
                    }
                  >
                    <option value={0}>{strings.mail.undoSendOff}</option>
                    {[5, 10, 20, 30].map((seconds) => (
                      <option key={seconds} value={seconds}>
                        {strings.mail.undoSendSeconds(seconds)}
                      </option>
                    ))}
                  </select>
                </SettingRow>
                <div className="security-summary">
                  <ShieldCheck />
                  <span>
                    <strong>{strings.settings.vaultTitle}</strong>
                    <small>{strings.settings.vaultHelp}</small>
                  </span>
                </div>
                <div className="settings-data-card">
                  <div>
                    <strong>{strings.settings.settingsData}</strong>
                    <small>{strings.settings.settingsDataHelp}</small>
                  </div>
                  <div className="settings-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void exportSettings()}
                      disabled={dataBusy}
                    >
                      <Upload aria-hidden="true" />{" "}
                      {strings.settings.exportSettings}
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void importSettings()}
                      disabled={dataBusy}
                    >
                      <DownloadCloud aria-hidden="true" />{" "}
                      {strings.settings.importSettings}
                    </button>
                    <button
                      className="danger-button"
                      type="button"
                      onClick={() => void resetSettings()}
                      disabled={dataBusy}
                    >
                      <RotateCcw aria-hidden="true" />{" "}
                      {strings.settings.resetSettings}
                    </button>
                  </div>
                  {dataStatus ? (
                    <small className="settings-data-status" role="status">
                      {dataStatus}
                    </small>
                  ) : null}
                </div>
              </SettingsPanel>
            ) : null}
            {tab === "reading" ? (
              <SettingsPanel id="reading" title={strings.settings.reading}>
                <SettingRow
                  title={strings.settings.readingPane}
                  help={strings.settings.readingPaneHelp}
                >
                  <select
                    aria-label={strings.settings.readingPane}
                    value={settings.readingPane}
                    onChange={(event) =>
                      void update({
                        readingPane: event.target
                          .value as AppSettings["readingPane"],
                      })
                    }
                  >
                    <option value="right">{strings.settings.paneRight}</option>
                    <option value="bottom">
                      {strings.settings.paneBottom}
                    </option>
                    <option value="hidden">
                      {strings.settings.paneHidden}
                    </option>
                  </select>
                </SettingRow>
                <SettingRow
                  title={strings.settings.textSize}
                  help={strings.settings.textSizeHelp}
                >
                  <select
                    aria-label={strings.settings.textSize}
                    value={settings.textScale}
                    onChange={(event) =>
                      void update({ textScale: Number(event.target.value) })
                    }
                  >
                    <option value={0.85}>{strings.settings.small}</option>
                    <option value={1}>{strings.settings.normal}</option>
                    <option value={1.15}>{strings.settings.large}</option>
                    <option value={1.3}>{strings.settings.extraLarge}</option>
                    <option value={1.5}>{strings.settings.veryLarge}</option>
                    <option value={2}>{strings.settings.largest}</option>
                  </select>
                </SettingRow>
              </SettingsPanel>
            ) : null}
            {tab === "notifications" ? (
              <SettingsPanel
                id="notifications"
                title={strings.settings.notifications}
              >
                <label className="switch-row">
                  <span>
                    <strong>{strings.settings.privateNotifications}</strong>
                    <small>{strings.settings.privateNotificationsHelp}</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.privateNotifications}
                    onChange={(event) =>
                      void update({
                        privateNotifications: event.target.checked,
                      })
                    }
                  />
                </label>
              </SettingsPanel>
            ) : null}
            {tab === "storage" ? (
              <SettingsPanel id="storage" title={strings.settings.storage}>
                <div className="storage-card">
                  <Database />
                  <span>
                    <strong>
                      {usage
                        ? formatBytes(usage.bytes)
                        : strings.settings.calculating}{" "}
                      {strings.settings.used}
                    </strong>
                    <small>
                      {settings.cachePolicy.mode === "full"
                        ? strings.settings.storageSummaryFull(
                            usage?.messageCount ?? 0,
                          )
                        : strings.settings.storageSummary(
                            usage?.messageCount ?? 0,
                            settings.cachePolicy.days,
                            settings.cachePolicy.maxBytes === 0
                              ? strings.settings.cacheUnlimited
                              : formatBytes(settings.cachePolicy.maxBytes),
                          )}
                    </small>
                  </span>
                </div>
                <SettingRow
                  title={strings.settings.cacheMode}
                  help={strings.settings.cachePolicyHelp}
                >
                  <select
                    aria-label={strings.settings.cacheMode}
                    value={settings.cachePolicy.mode}
                    onChange={(event) => {
                      const mode = event.target.value as "recent" | "full";
                      if (mode === "full") {
                        void update({
                          cachePolicy: {
                            mode: "full",
                            days: 0,
                            maxBytes: 0,
                          },
                        });
                      } else {
                        void update({
                          cachePolicy: {
                            mode: "recent",
                            days: 90,
                            maxBytes: 1_073_741_824,
                          },
                        });
                      }
                    }}
                  >
                    <option value="recent">
                      {strings.settings.cacheRecent}
                    </option>
                    <option value="full">{strings.settings.cacheFull}</option>
                  </select>
                </SettingRow>
                {settings.cachePolicy.mode === "recent" ? (
                  <SettingRow
                    title={strings.settings.cacheDays}
                    help={strings.settings.cachePolicyHelp}
                  >
                    <select
                      aria-label={strings.settings.cacheDays}
                      value={settings.cachePolicy.days}
                      onChange={(event) =>
                        void update({
                          cachePolicy: {
                            ...settings.cachePolicy,
                            days: Number(event.target.value),
                          },
                        })
                      }
                    >
                      <option value={30}>
                        {strings.settings.cacheDaysOption(30)}
                      </option>
                      <option value={90}>
                        {strings.settings.cacheDaysOption(90)}
                      </option>
                      <option value={180}>
                        {strings.settings.cacheDaysOption(180)}
                      </option>
                      <option value={365}>
                        {strings.settings.cacheDaysOption(365)}
                      </option>
                    </select>
                  </SettingRow>
                ) : null}
                <SettingRow
                  title={strings.settings.cacheLimit}
                  help={strings.settings.cachePolicyHelp}
                >
                  <select
                    aria-label={strings.settings.cacheLimit}
                    value={settings.cachePolicy.maxBytes}
                    disabled={settings.cachePolicy.mode === "full"}
                    onChange={(event) =>
                      void update({
                        cachePolicy: {
                          ...settings.cachePolicy,
                          maxBytes: Number(event.target.value),
                        },
                      })
                    }
                  >
                    {settings.cachePolicy.mode === "full" ? (
                      <option value={0}>
                        {strings.settings.cacheUnlimited}
                      </option>
                    ) : (
                      <>
                        <option value={524_288_000}>500 MB</option>
                        <option value={1_073_741_824}>1 GB</option>
                        <option value={2_147_483_648}>2 GB</option>
                        <option value={5_368_709_120}>5 GB</option>
                        <option value={0}>
                          {strings.settings.cacheUnlimited}
                        </option>
                      </>
                    )}
                  </select>
                </SettingRow>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void clearCache()}
                >
                  {strings.settings.clearMail}
                </button>
                <p className="settings-note">
                  {strings.settings.clearMailHelp}
                </p>
              </SettingsPanel>
            ) : null}
            {tab === "accounts" ? (
              <SettingsPanel id="accounts" title={strings.settings.accounts}>
                {accounts.length === 0 ? (
                  <div className="settings-empty-state">
                    <Mail />
                    <p>{strings.settings.noAccounts}</p>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={onClose}
                    >
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
                          <strong>
                            {account.displayName || account.email}
                          </strong>
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
                        <p className="settings-note">
                          {strings.settings.signatureHelp}
                        </p>
                        <div className="add-alias-form signature-form">
                          <textarea
                            id={`account-signature-${account.id}`}
                            rows={3}
                            maxLength={2000}
                            placeholder={strings.settings.signaturePlaceholder}
                            value={
                              signatureInputs[account.id] ??
                              account.signature ??
                              ""
                            }
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
                                      rule.action,
                                    )}
                                  </span>
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
                            <option value="from">
                              {strings.settings.matchFrom}
                            </option>
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
                              onClick={() =>
                                void handleDetectAliases(account.id)
                              }
                              disabled={
                                detectingAliasesAccountId === account.id
                              }
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
                    </div>
                  ))}
                </div>
              </SettingsPanel>
            ) : null}
            {tab === "shortcuts" ? (
              <SettingsPanel
                id="shortcuts"
                title={strings.settings.shortcutsTitle}
              >
                <div className="shortcuts-list">
                  <div className="shortcut-row">
                    <span>{strings.composer.newMessage}</span>
                    <kbd>{`${shortcutMod()} N`}</kbd>
                  </div>
                  <div className="shortcut-row">
                    <span>{strings.mail.getMail}</span>
                    <kbd>{`${shortcutShiftMod()} M`}</kbd>
                  </div>
                  <div className="shortcut-row">
                    <span>{strings.reader.reply}</span>
                    <kbd>{`${shortcutMod()} R`}</kbd>
                  </div>
                  <div className="shortcut-row">
                    <span>{strings.reader.replyAll}</span>
                    <kbd>{`${shortcutShiftMod()} R`}</kbd>
                  </div>
                  <div className="shortcut-row">
                    <span>{strings.reader.forward}</span>
                    <kbd>{`${shortcutShiftMod()} F`}</kbd>
                  </div>
                  <div className="shortcut-row">
                    <span>{strings.reader.archive}</span>
                    <kbd>{`${shortcutMod()} E`}</kbd>
                  </div>
                  <div className="shortcut-row">
                    <span>{strings.reader.trash}</span>
                    <kbd>{`${shortcutMod()} ⌫`}</kbd>
                  </div>
                  <div className="shortcut-row">
                    <span>{strings.mail.search}</span>
                    <kbd>{`${shortcutMod()} F / /`}</kbd>
                  </div>
                  <div className="shortcut-row">
                    <span>{strings.composer.send}</span>
                    <kbd>{`${shortcutMod()} ↵`}</kbd>
                  </div>
                  <div className="shortcut-row">
                    <span>{strings.composer.saveDraft}</span>
                    <kbd>{`${shortcutMod()} S`}</kbd>
                  </div>
                  <div className="shortcut-row">
                    <span>{strings.settings.textSize}</span>
                    <kbd>{`${shortcutMod()} + / ${shortcutMod()} -`}</kbd>
                  </div>
                  <div className="shortcut-row">
                    <span>{strings.mail.settings}</span>
                    <kbd>{`${shortcutMod()} ,`}</kbd>
                  </div>
                </div>
              </SettingsPanel>
            ) : null}
            {tab === "updates" ? (
              <SettingsPanel id="updates" title={strings.settings.updates}>
                {updateReady ? (
                  <div className="update-ready-card">
                    <div className="update-ready-icon">
                      <DownloadCloud aria-hidden="true" />
                    </div>
                    <div className="update-ready-body">
                      <strong>{strings.settings.updateReadyCardTitle}</strong>
                      <p>{strings.settings.updateReadyCardHelp(updateReady)}</p>
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => void api.relaunch()}
                      >
                        {strings.settings.restartNow}
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className="storage-card">
                  <DownloadCloud aria-hidden="true" />
                  <span>
                    <strong>
                      {distribution?.updatesManagedBy === "store"
                        ? strings.settings.storeUpdateTitle
                        : strings.settings.directUpdateTitle}
                    </strong>
                    <small>
                      {distribution
                        ? editionName(distribution.kind)
                        : strings.settings.checkingEdition}
                    </small>
                  </span>
                </div>
                {distribution?.updatesManagedBy === "postalSnap" ? (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void checkForUpdates()}
                    disabled={checkingUpdate}
                  >
                    {updateStatus}
                  </button>
                ) : null}
              </SettingsPanel>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

function SettingsPanel({
  id,
  title,
  children,
}: {
  id: SettingsTab;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      id={`settings-${id}`}
      className="settings-panel"
      role="tabpanel"
      aria-labelledby={`settings-tab-${id}`}
    >
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function SettingRow({
  title,
  help,
  children,
}: {
  title: string;
  help: string;
  children: ReactNode;
}) {
  return (
    <label className="settings-row">
      <span>
        <strong>{title}</strong>
        <small>{help}</small>
      </span>
      {children}
    </label>
  );
}

function editionName(kind: DistributionChannel["kind"]): string {
  return {
    direct: strings.settings.directEdition,
    macAppStore: strings.settings.macStoreEdition,
    microsoftStore: strings.settings.microsoftStoreEdition,
    flatpak: strings.settings.flatpakEdition,
  }[kind];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
