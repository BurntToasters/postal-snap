import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { AppMark } from "./components/AppMark";
import { ContextMenuHost } from "./components/ContextMenu";
import { WindowChrome } from "./components/WindowChrome";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { api, inTauri } from "./api";
import { CONTEXT_DISMISS_EVENT } from "./contextMenu";
import { strings } from "./i18n";
import { parseMailto } from "./mailto";
import { SetupWizard } from "./components/SetupWizard";
import { SetupFlow } from "./components/SetupFlow";
import { MailShell } from "./components/MailShell";
import { SettingsDialog, type SettingsTab } from "./components/SettingsDialog";
import { useAppStore } from "./store";
import { useSettingsSave } from "./components/settings/useSettingsSave";
import { applySettings } from "./settings";
import {
  checkUpdateInteractive,
  checksUpdatesOnStartup,
  runUpdateSingleFlight,
  startDeferredUpdateOnQuit,
  startPeriodicUpdateCheck,
  quitOrApplyPendingUpdate,
} from "./update";

type SetupScreen = "flow" | "wizard";

const Composer = lazy(() =>
  import("./components/Composer").then((module) => ({
    default: module.Composer,
  })),
);

export default function App() {
  const accounts = useAppStore((state) => state.accounts);
  const settings = useAppStore((state) => state.settings);
  const setAccounts = useAppStore((state) => state.setAccounts);
  const setSettings = useAppStore((state) => state.setSettings);
  const setSync = useAppStore((state) => state.setSync);
  const setError = useAppStore((state) => state.setError);
  const error = useAppStore((state) => state.error);
  const composerOpen = useAppStore((state) => state.composerOpen);
  const composerAccountId = useAppStore((state) => state.composerAccountId);
  const composeSeed = useAppStore((state) => state.composeSeed);
  const composeNonce = useAppStore((state) => state.composeNonce);
  const openComposer = useAppStore((state) => state.openComposer);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [settingsRouteRequest, setSettingsRouteRequest] = useState(0);
  const [startupError, setStartupError] = useState<string>();
  const [startupNotice, setStartupNotice] = useState<string | null>(null);
  const [ready, setReady] = useState(!inTauri());
  const loadRequest = useRef(0);
  // Own setup route until user opens the mailbox. Sync events can list an
  // account before add_account returns to its setup component.
  const [setupSession, setSetupSession] = useState<SetupScreen | null>(null);
  const setupScreen: SetupScreen | null =
    setupSession ??
    (accounts.length > 0 ? null : settings.setupCompleted ? "wizard" : "flow");

  const claimAccountlessSetup = useCallback(() => {
    const setupCompleted = useAppStore.getState().settings.setupCompleted;
    setSetupSession(
      (current) => current ?? (setupCompleted ? "wizard" : "flow"),
    );
  }, []);

  // Best-effort: routing already trusts the accounts, so ignore failures.
  const { update: repairSettings } = useSettingsSave();

  const openSettings = useCallback((tab: SettingsTab = "general") => {
    setSettingsTab(tab);
    setSettingsRouteRequest((value) => value + 1);
    setSettingsOpen(true);
  }, []);

  const loadAccounts = useCallback(async () => {
    const request = ++loadRequest.current;
    try {
      const [
        loadedAccounts,
        loadedSettings,
        startupNotice,
        nativeStartupError,
      ] = await Promise.all([
        api.listAccounts(),
        api.getSettings(),
        api.getStartupNotice(),
        api.getStartupError(),
      ]);
      if (request !== loadRequest.current) return;
      if (nativeStartupError) {
        setStartupError(nativeStartupError);
        return;
      }
      setSettings(loadedSettings);
      setAccounts(loadedAccounts);
      applySettings(loadedSettings);
      if (loadedAccounts.length === 0) {
        setSetupSession(
          (current) =>
            current ?? (loadedSettings.setupCompleted ? "wizard" : "flow"),
        );
      }
      if (loadedAccounts.length > 0 && !loadedSettings.setupCompleted) {
        // Accounts prove setup finished; repair a lost or reset flag. A
        // queued patch merges onto the latest settings, never a stale copy.
        void repairSettings(
          { setupCompleted: true, setupStep: null },
          undefined,
          { quiet: true },
        );
      }
      setStartupNotice(startupNotice);
      if (startupNotice) setError(startupNotice);
      if (loadedAccounts.length > 0) {
        void isPermissionGranted()
          .then((granted) => (granted ? undefined : requestPermission()))
          .catch(() => undefined);
      }
    } catch {
      if (request === loadRequest.current) {
        setStartupError(strings.app.startupRecoveryHelp);
      }
    } finally {
      setReady(true);
    }
  }, [repairSettings, setAccounts, setError, setSettings]);

  const finishSetup = useCallback(async () => {
    await loadAccounts();
    setSetupSession(null);
  }, [loadAccounts]);

  useEffect(() => {
    if (!inTauri()) return;
    void Promise.resolve()
      .then(() => loadAccounts())
      .then(() => {
        if (
          checksUpdatesOnStartup(
            useAppStore.getState().settings.updateCheckInterval,
          )
        ) {
          void runUpdateSingleFlight().catch(() => undefined);
        }
      });
    const cancelQuitUpdate = startDeferredUpdateOnQuit();
    let active = true;
    const unsubscribers: Array<() => void> = [];
    void api
      .onSyncState((syncState) => {
        setSync(syncState);
        if (syncState.phase === "authFailed" || syncState.phase === "offline") {
          void api
            .listAccounts()
            .then((loadedAccounts) => {
              if (active) {
                setAccounts(loadedAccounts);
                if (loadedAccounts.length === 0) claimAccountlessSetup();
              }
            })
            .catch(() => undefined);
        }
      })
      .then((fn) => {
        if (active) unsubscribers.push(fn);
        else fn();
      });
    void api.onAppWarning(setError).then((fn) => {
      if (active) unsubscribers.push(fn);
      else fn();
    });
    void api
      .onMenuAction((action) => {
        if (action === "settings") {
          openSettings();
          return;
        }
        if (action === "check-for-updates") {
          void checkUpdateInteractive().catch(() => undefined);
          return;
        }
        window.dispatchEvent(
          new CustomEvent("postal:menu-action", { detail: action }),
        );
      })
      .then((fn) => {
        if (active) unsubscribers.push(fn);
        else fn();
      });
    void api
      .onTrayQuit(() => {
        void quitOrApplyPendingUpdate().catch(() => undefined);
      })
      .then((fn) => {
        if (active) unsubscribers.push(fn);
        else fn();
      });
    const handleUrls = (urls: string[]) =>
      urls
        .filter((url) => /^mailto:/i.test(url))
        .forEach((url) => openComposer({ prefill: parseMailto(url) }));
    void getCurrent()
      .then((urls) => {
        if (urls) handleUrls(urls);
      })
      .catch(() => undefined);
    void onOpenUrl(handleUrls).then((fn) => {
      if (active) unsubscribers.push(fn);
      else fn();
    });
    return () => {
      active = false;
      cancelQuitUpdate();
      unsubscribers.forEach((fn) => fn());
    };
  }, [
    loadAccounts,
    claimAccountlessSetup,
    openComposer,
    openSettings,
    setAccounts,
    setError,
    setSync,
  ]);

  useEffect(() => {
    if (!inTauri()) return;
    return startPeriodicUpdateCheck(settings.updateCheckInterval);
  }, [settings.updateCheckInterval]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey) {
        if (event.key === ",") {
          event.preventDefault();
          openSettings();
        } else if (event.key === "=" || event.key === "+") {
          event.preventDefault();
          window.dispatchEvent(
            new CustomEvent("postal:menu-action", { detail: "text-larger" }),
          );
        } else if (event.key === "-") {
          event.preventDefault();
          window.dispatchEvent(
            new CustomEvent("postal:menu-action", { detail: "text-smaller" }),
          );
        } else if (event.key.toLowerCase() === "p") {
          if (
            document.querySelector(
              ".composer-layer, .settings-window, .modal-layer",
            )
          )
            return;
          event.preventDefault();
          window.dispatchEvent(new Event("postal:print-message"));
        }
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [openSettings]);

  useEffect(() => {
    const syncGuard = () => {
      const target = document.activeElement as HTMLElement | null;
      const guarded = Boolean(
        document.querySelector(
          ".composer-layer, .settings-window, .modal-layer",
        ) || target?.closest("[contenteditable='true']"),
      );
      void api.setMailShortcutGuard(guarded).catch(() => undefined);
    };
    document.addEventListener("focusin", syncGuard);
    document.addEventListener("focusout", syncGuard);
    syncGuard();
    return () => {
      document.removeEventListener("focusin", syncGuard);
      document.removeEventListener("focusout", syncGuard);
      void api.setMailShortcutGuard(false).catch(() => undefined);
    };
  }, [composerOpen, settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    window.dispatchEvent(new Event(CONTEXT_DISMISS_EVENT));
  }, [settingsOpen]);

  if (!ready)
    return (
      <>
        <ContextMenuHost />
        <WindowChrome />
        <div className="splash" role="status">
          {strings.app.starting}
        </div>
      </>
    );

  if (!inTauri()) {
    return (
      <>
        <ContextMenuHost />
        <main className="preview-notice">
          <AppMark size={64} className="brand-mark" />
          <h1>{strings.appName}</h1>
          <p>{strings.app.preview}</p>
        </main>
      </>
    );
  }

  const mainContent = startupError ? (
    <main className="startup-recovery" role="alert">
      <AppMark size={64} className="brand-mark" />
      <h1>{strings.app.startupRecoveryTitle}</h1>
      <p>{startupError}</p>
      <button
        type="button"
        className="primary-button"
        onClick={() => openSettings()}
      >
        {strings.mail.settings}
      </button>
    </main>
  ) : setupScreen === "flow" ? (
    <main className="setup-host">
      <SetupFlow
        startupNotice={startupNotice}
        onComplete={finishSetup}
        onOpenSettings={() => openSettings()}
      />
    </main>
  ) : setupScreen === "wizard" ? (
    <main className="setup-host">
      <SetupWizard
        onComplete={finishSetup}
        onOpenSettings={() => openSettings()}
      />
    </main>
  ) : (
    <MailShell
      onOpenSettings={(tab) =>
        openSettings(tab === "accounts" ? "accounts" : "general")
      }
    />
  );

  return (
    <>
      <ContextMenuHost />
      <div className="app-viewport" inert={settingsOpen || undefined}>
        {mainContent}
        {composerOpen && composerAccountId ? (
          <Suspense
            fallback={
              <div className="splash overlay-splash" role="status">
                {strings.app.openingEditor}
              </div>
            }
          >
            <Composer
              key={`${composerAccountId}:${composeSeed?.draft?.id ?? composeSeed?.sourceMessage?.id ?? "new"}:${composeSeed?.composeMode ?? ""}:${composeNonce}`}
              accountId={composerAccountId}
            />
          </Suspense>
        ) : null}
      </div>
      {settingsOpen ? (
        <SettingsDialog
          key={`${settingsTab}:${settingsRouteRequest}`}
          initialTab={settingsTab}
          onClose={() => setSettingsOpen(false)}
          onLastAccountRemoved={claimAccountlessSetup}
        />
      ) : null}
      {error ? (
        <div className="toast error-toast" role="alert">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(undefined)}
            aria-label={strings.app.dismissError}
          >
            ×
          </button>
        </div>
      ) : null}
      <WindowChrome />
    </>
  );
}
