import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  Bell,
  Database,
  DownloadCloud,
  Eye,
  Info,
  Keyboard,
  Monitor,
  ShieldAlert,
  UserRound,
  X,
} from "lucide-react";
import { api } from "../api";
import { strings } from "../i18n";
import { applySettings } from "../settings";
import { useAppStore } from "../store";
import { supportsWorkspaceWindowFx } from "../window-fx";
import type { CacheUsage, DistributionChannel, FilterRule } from "../types";
import {
  addUpdateFoundListener,
  checkUpdateInteractive,
  removeUpdateFoundListener,
  type UpdateFoundListener,
} from "../update";
import { useDialogFocus } from "./useDialogFocus";
import type { SettingsTab } from "./settings/primitives";
import { useSettingsSave } from "./settings/useSettingsSave";
import { GeneralTab } from "./settings/generalTab";
import { ReadingTab } from "./settings/readingTab";
import { NotificationsTab } from "./settings/notificationsTab";
import { StorageTab } from "./settings/storageTab";
import { AccountsTab } from "./settings/accountsTab";
import { ShortcutsTab } from "./settings/shortcutsTab";
import { UpdatesTab } from "./settings/updatesTab";
import { AdvancedTab } from "./settings/advancedTab";
import { AboutTab } from "./settings/aboutTab";

export type { SettingsTab } from "./settings/primitives";

interface Props {
  onClose: () => void;
  initialTab?: SettingsTab;
}

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
  { id: "advanced", label: strings.settings.advanced, icon: ShieldAlert },
  { id: "about", label: strings.settings.about, icon: Info },
];

export function SettingsDialog({ onClose, initialTab = "general" }: Props) {
  const accounts = useAppStore((state) => state.accounts);
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
  const { saving, update } = useSettingsSave();
  const [dataBusy, setDataBusy] = useState(false);
  const [dataStatus, setDataStatus] = useState<string>();
  const [eraseBusy, setEraseBusy] = useState(false);
  const [eraseStatus, setEraseStatus] = useState<string>();
  const [checkingUpdate, setCheckingUpdate] = useState(false);
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
  const [signatureInputs, setSignatureInputs] = useState<
    Record<string, string>
  >({});
  const [signatureStatus, setSignatureStatus] = useState<
    Record<string, string>
  >({});
  const [savingSignatureId, setSavingSignatureId] = useState<string>();
  const [confirmThreatOff, setConfirmThreatOff] = useState(false);
  const [horizontalTabs, setHorizontalTabs] = useState(() =>
    typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 760px)").matches
      : false,
  );
  const [confirmToken, setConfirmToken] = useState("");
  const confirmInputRef = useRef<HTMLInputElement>(null);
  const settingsContentRef = useRef<HTMLDivElement>(null);
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
  const requestClose = useCallback(() => {
    if (confirmThreatOff) {
      setConfirmThreatOff(false);
      setConfirmToken("");
      return;
    }
    onClose();
  }, [confirmThreatOff, onClose]);
  const dialogRef = useDialogFocus(requestClose);

  const handleUpdateFound = useCallback<UpdateFoundListener>((version) => {
    setUpdateStatus(strings.settings.installing(version ?? ""));
  }, []);

  useEffect(() => {
    addUpdateFoundListener(handleUpdateFound);
    return () => removeUpdateFoundListener(handleUpdateFound);
  }, [handleUpdateFound]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 760px)");
    const updateOrientation = () => setHorizontalTabs(media.matches);
    updateOrientation();
    media.addEventListener("change", updateOrientation);
    return () => media.removeEventListener("change", updateOrientation);
  }, []);

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

  useEffect(() => {
    if (!confirmThreatOff) return;
    const timer = window.setTimeout(() => confirmInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [confirmThreatOff]);

  useEffect(() => {
    if (settingsContentRef.current) settingsContentRef.current.scrollTop = 0;
  }, [tab]);

  function cancelThreatOff() {
    setConfirmThreatOff(false);
    setConfirmToken("");
  }

  async function setAdvertisingBlocking(enabled: boolean) {
    if (!enabled) {
      const confirmed = await api.showNativeConfirm(
        strings.settings.disableAdblockTitle,
        strings.settings.disableAdblockQuestion,
      );
      if (!confirmed) return;
    }
    await update({ blockAdvertisingAndTracking: enabled });
  }

  async function setThreatBlocking(enabled: boolean) {
    if (!enabled) {
      setConfirmToken("");
      setConfirmThreatOff(true);
      return;
    }
    await update({ blockReportedThreats: true });
  }

  async function confirmDisableThreats() {
    if (confirmToken !== strings.settings.threatDisableToken) return;
    cancelThreatOff();
    await update(
      { blockReportedThreats: false },
      strings.settings.threatDisableToken,
    );
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

  async function eraseAllData() {
    if (eraseBusy) return;
    const confirmed = await api.showNativeConfirm(
      strings.settings.eraseTitle,
      strings.settings.eraseQuestion,
    );
    if (!confirmed) return;
    setEraseBusy(true);
    setEraseStatus(undefined);
    try {
      await api.eraseAllData();
      await api.relaunch();
    } catch (cause) {
      setEraseStatus(strings.settings.eraseFailed);
      setError(String(cause));
    } finally {
      setEraseBusy(false);
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
    const directionKeys = horizontalTabs
      ? ["ArrowLeft", "ArrowRight"]
      : ["ArrowUp", "ArrowDown"];
    if (![...directionKeys, "Home", "End"].includes(event.key)) return;
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
    window.setTimeout(() => {
      const element = document.getElementById(`settings-tab-${next}`);
      element?.focus();
      element?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }, 0);
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
        onClick={requestClose}
      />
      <section className="settings-window" ref={dialogRef}>
        <header
          inert={confirmThreatOff || undefined}
          data-tauri-drag-region="deep"
        >
          <span>
            <h1 id="settings-title">{strings.settings.title}</h1>
            <small>
              {saving ? strings.settings.saving : strings.settings.autosave}
            </small>
          </span>
          <button
            className="icon-button"
            type="button"
            onClick={requestClose}
            aria-label={strings.settings.close}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="settings-layout" inert={confirmThreatOff || undefined}>
          <nav
            className="settings-nav"
            aria-label={strings.settings.sections}
            role="tablist"
            aria-orientation={horizontalTabs ? "horizontal" : "vertical"}
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
                onClick={(event) => {
                  setTab(id);
                  event.currentTarget.scrollIntoView?.({
                    block: "nearest",
                    inline: "nearest",
                  });
                }}
                onKeyDown={(event) => moveTab(event, index)}
              >
                <Icon aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </nav>
          <div className="settings-content" ref={settingsContentRef}>
            {tab === "general" ? (
              <GeneralTab
                update={update}
                windowFxSupported={windowFxSupported}
                dataBusy={dataBusy}
                dataStatus={dataStatus}
                setTab={setTab}
                exportSettings={exportSettings}
                importSettings={importSettings}
              />
            ) : null}
            {tab === "reading" ? <ReadingTab update={update} /> : null}
            {tab === "notifications" ? (
              <NotificationsTab update={update} />
            ) : null}
            {tab === "storage" ? (
              <StorageTab
                usage={usage}
                update={update}
                clearCache={clearCache}
              />
            ) : null}
            {tab === "accounts" ? (
              <AccountsTab
                onClose={onClose}
                testingAccountId={testingAccountId}
                testedHealthy={testedHealthy}
                testAccount={testAccount}
                removeAccount={removeAccount}
                passwordInputs={passwordInputs}
                setPasswordInputs={setPasswordInputs}
                passwordStatus={passwordStatus}
                updatingPasswordId={updatingPasswordId}
                handleUpdatePassword={handleUpdatePassword}
                signatureInputs={signatureInputs}
                setSignatureInputs={setSignatureInputs}
                signatureStatus={signatureStatus}
                savingSignatureId={savingSignatureId}
                handleSaveSignature={handleSaveSignature}
                filterRules={filterRules}
                ruleInput={ruleInput}
                setRuleField={setRuleField}
                handleAddRule={handleAddRule}
                handleToggleRule={handleToggleRule}
                handleDeleteRule={handleDeleteRule}
                ruleStatus={ruleStatus}
                detectingAliasesAccountId={detectingAliasesAccountId}
                handleDetectAliases={handleDetectAliases}
                aliasStatus={aliasStatus}
                newAliasInputs={newAliasInputs}
                setNewAliasInputs={setNewAliasInputs}
                handleAddAlias={handleAddAlias}
                handleRemoveAlias={handleRemoveAlias}
                eraseBusy={eraseBusy}
                eraseStatus={eraseStatus}
                eraseAllData={eraseAllData}
              />
            ) : null}
            {tab === "shortcuts" ? <ShortcutsTab /> : null}
            {tab === "updates" ? (
              <UpdatesTab
                distribution={distribution}
                updateStatus={updateStatus}
                checkingUpdate={checkingUpdate}
                checkForUpdates={checkForUpdates}
              />
            ) : null}
            {tab === "advanced" ? (
              <AdvancedTab
                setAdvertisingBlocking={setAdvertisingBlocking}
                setThreatBlocking={setThreatBlocking}
              />
            ) : null}
            {tab === "about" ? <AboutTab /> : null}
          </div>
        </div>
        {confirmThreatOff ? (
          <div
            className="settings-confirm-overlay"
            onClick={(event) => {
              if (event.target === event.currentTarget) cancelThreatOff();
            }}
          >
            <form
              className="settings-confirm-card"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="settings-threat-off-title"
              aria-describedby="settings-threat-off-lead"
              onClick={(event) => event.stopPropagation()}
              onSubmit={(event) => {
                event.preventDefault();
                void confirmDisableThreats();
              }}
            >
              <h2 id="settings-threat-off-title">
                {strings.settings.threatDisableTitle}
              </h2>
              <p id="settings-threat-off-lead">
                {strings.settings.threatDisableLead}
              </p>
              <label className="settings-confirm-field">
                <span>{strings.settings.threatDisableHelp}</span>
                <input
                  ref={confirmInputRef}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={strings.settings.threatDisableInput}
                  value={confirmToken}
                  onChange={(event) => setConfirmToken(event.target.value)}
                />
              </label>
              <div className="settings-confirm-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={cancelThreatOff}
                >
                  {strings.settings.threatDisableCancel}
                </button>
                <button
                  className="danger-button"
                  type="submit"
                  disabled={
                    confirmToken !== strings.settings.threatDisableToken
                  }
                >
                  {strings.settings.threatDisableConfirm}
                </button>
              </div>
            </form>
          </div>
        ) : null}
      </section>
    </div>
  );
}
