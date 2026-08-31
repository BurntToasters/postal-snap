import {
  useCallback,
  useEffect,
  useRef,
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
import type { AppSettings, CacheUsage, DistributionChannel } from "../types";
import {
  removeUpdateFoundListener,
  runUpdateSingleFlight,
  type UpdateFoundListener,
} from "../update";
import { useDialogFocus } from "./useDialogFocus";

interface Props {
  onClose: () => void;
  initialTab?: SettingsTab;
  checkUpdatesRequest?: number;
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

export function SettingsDialog({
  onClose,
  initialTab = "general",
  checkUpdatesRequest,
}: Props) {
  const settings = useAppStore((state) => state.settings);
  const accounts = useAppStore((state) => state.accounts);
  const setAccounts = useAppStore((state) => state.setAccounts);
  const setSettings = useAppStore((state) => state.setSettings);
  const setError = useAppStore((state) => state.setError);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [usage, setUsage] = useState<CacheUsage>();
  const [distribution, setDistribution] = useState<DistributionChannel>();
  const [updateStatus, setUpdateStatus] = useState<string>(
    strings.settings.checkUpdates,
  );
  const [saving, setSaving] = useState(false);
  const [dataBusy, setDataBusy] = useState(false);
  const [dataStatus, setDataStatus] = useState<string>();
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const handledCheckRequest = useRef<number | undefined>(undefined);
  const [testingAccountId, setTestingAccountId] = useState<string>();
  const [testedHealthy, setTestedHealthy] = useState<string>();
  const dialogRef = useDialogFocus(onClose);

  const handleUpdateFound = useCallback<UpdateFoundListener>((version) => {
    setUpdateStatus(strings.settings.installing(version ?? ""));
  }, []);

  useEffect(
    () => () => removeUpdateFoundListener(handleUpdateFound),
    [handleUpdateFound],
  );

  useEffect(() => {
    void api
      .cacheUsage()
      .then(setUsage)
      .catch(() => undefined);
    void api
      .distribution()
      .then(setDistribution)
      .catch(() => undefined);
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
    if (!window.confirm(strings.settings.clearMailQuestion)) return;
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
    if (dataBusy || !window.confirm(strings.settings.importQuestion)) return;
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
    if (dataBusy || !window.confirm(strings.settings.resetQuestion)) return;
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
      const result = await runUpdateSingleFlight(handleUpdateFound);
      if (!result.available) {
        setUpdateStatus(strings.settings.upToDate);
      }
    } catch (cause) {
      setUpdateStatus(strings.settings.checkUpdates);
      setError(String(cause));
    } finally {
      setCheckingUpdate(false);
    }
  }, [checkingUpdate, distribution, handleUpdateFound, setError]);

  useEffect(() => {
    if (
      !checkUpdatesRequest ||
      handledCheckRequest.current === checkUpdatesRequest ||
      !distribution
    )
      return;
    handledCheckRequest.current = checkUpdatesRequest;
    void checkForUpdates();
  }, [checkForUpdates, checkUpdatesRequest, distribution]);

  async function removeAccount(id: string, name: string) {
    if (!window.confirm(strings.settings.removeAccount(name))) return;
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
        onClick={onClose}
        aria-label={strings.settings.close}
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
            <X />
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
                <Icon />
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
                      <Upload /> {strings.settings.exportSettings}
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void importSettings()}
                      disabled={dataBusy}
                    >
                      <DownloadCloud /> {strings.settings.importSettings}
                    </button>
                    <button
                      className="danger-button"
                      type="button"
                      onClick={() => void resetSettings()}
                      disabled={dataBusy}
                    >
                      <RotateCcw /> {strings.settings.resetSettings}
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
                      {strings.settings.storageSummary(
                        usage?.messageCount ?? 0,
                        settings.cachePolicy.days,
                        formatBytes(settings.cachePolicy.maxBytes),
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
                    onChange={(event) =>
                      void update({
                        cachePolicy: {
                          ...settings.cachePolicy,
                          mode: event.target.value as "recent" | "full",
                        },
                      })
                    }
                  >
                    <option value="recent">
                      {strings.settings.cacheRecent}
                    </option>
                    <option value="full">{strings.settings.cacheFull}</option>
                  </select>
                </SettingRow>
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
                <SettingRow
                  title={strings.settings.cacheLimit}
                  help={strings.settings.cachePolicyHelp}
                >
                  <select
                    aria-label={strings.settings.cacheLimit}
                    value={settings.cachePolicy.maxBytes}
                    onChange={(event) =>
                      void update({
                        cachePolicy: {
                          ...settings.cachePolicy,
                          maxBytes: Number(event.target.value),
                        },
                      })
                    }
                  >
                    <option value={524_288_000}>500 MB</option>
                    <option value={1_073_741_824}>1 GB</option>
                    <option value={2_147_483_648}>2 GB</option>
                    <option value={5_368_709_120}>5 GB</option>
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
                    <div key={account.id}>
                      <Mail />
                      <span>
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
                <div className="storage-card">
                  <DownloadCloud />
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
