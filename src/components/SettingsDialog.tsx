import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Bell,
  Database,
  DownloadCloud,
  Eye,
  Mail,
  Monitor,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import { api } from "../api";
import { strings } from "../i18n";
import { applySettings } from "../settings";
import { useAppStore } from "../store";
import type { AppSettings, CacheUsage, DistributionChannel } from "../types";
import { useDialogFocus } from "./useDialogFocus";

interface Props {
  onClose: () => void;
}

type SettingsTab =
  "general" | "reading" | "notifications" | "storage" | "accounts" | "updates";

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
  { id: "updates", label: strings.settings.updates, icon: DownloadCloud },
];

export function SettingsDialog({ onClose }: Props) {
  const settings = useAppStore((state) => state.settings);
  const accounts = useAppStore((state) => state.accounts);
  const setAccounts = useAppStore((state) => state.setAccounts);
  const setSettings = useAppStore((state) => state.setSettings);
  const setError = useAppStore((state) => state.setError);
  const [tab, setTab] = useState<SettingsTab>("general");
  const [usage, setUsage] = useState<CacheUsage>();
  const [distribution, setDistribution] = useState<DistributionChannel>();
  const [updateStatus, setUpdateStatus] = useState<string>(
    strings.settings.checkUpdates,
  );
  const [saving, setSaving] = useState(false);
  const dialogRef = useDialogFocus(onClose);

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

  async function checkForUpdates() {
    if (distribution?.updatesManagedBy === "store") return;
    setUpdateStatus(strings.settings.checking);
    try {
      const [{ check }, { relaunch }] = await Promise.all([
        import("@tauri-apps/plugin-updater"),
        import("@tauri-apps/plugin-process"),
      ]);
      const update = await check();
      if (!update) {
        setUpdateStatus(strings.settings.upToDate);
        return;
      }
      setUpdateStatus(strings.settings.installing(update.version));
      await update.downloadAndInstall();
      await relaunch();
    } catch (cause) {
      setUpdateStatus(strings.settings.checkUpdates);
      setError(String(cause));
    }
  }

  async function removeAccount(id: string, name: string) {
    if (!window.confirm(strings.settings.removeAccount(name))) return;
    try {
      await api.removeAccount(id);
      setAccounts(await api.listAccounts());
      if (accounts.length === 1) onClose();
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
                <div className="account-settings-list">
                  {accounts.map((account) => (
                    <div key={account.id}>
                      <Mail />
                      <span>
                        <strong>{account.displayName || account.email}</strong>
                        <small>{account.email}</small>
                      </span>
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
