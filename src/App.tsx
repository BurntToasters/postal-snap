import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { api, inTauri } from "./api";
import { strings } from "./i18n";
import { parseMailto } from "./mailto";
import { SetupWizard } from "./components/SetupWizard";
import { MailShell } from "./components/MailShell";
import { SettingsDialog } from "./components/SettingsDialog";
import { defaultSettings, useAppStore } from "./store";
import { applySettings } from "./settings";

const Composer = lazy(() =>
  import("./components/Composer").then((module) => ({
    default: module.Composer,
  })),
);

export default function App() {
  const accounts = useAppStore((state) => state.accounts);
  const setAccounts = useAppStore((state) => state.setAccounts);
  const setSettings = useAppStore((state) => state.setSettings);
  const setSync = useAppStore((state) => state.setSync);
  const setError = useAppStore((state) => state.setError);
  const error = useAppStore((state) => state.error);
  const composerOpen = useAppStore((state) => state.composerOpen);
  const composerAccountId = useAppStore((state) => state.composerAccountId);
  const composeSeed = useAppStore((state) => state.composeSeed);
  const openComposer = useAppStore((state) => state.openComposer);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ready, setReady] = useState(!inTauri());

  const loadAccounts = useCallback(async () => {
    try {
      const [loadedAccounts, loadedSettings] = await Promise.all([
        api.listAccounts(),
        api.getSettings().catch(() => defaultSettings),
      ]);
      setSettings(loadedSettings);
      setAccounts(loadedAccounts);
      applySettings(loadedSettings);
      void api
        .getStartupNotice()
        .then((notice) => {
          if (notice) setError(notice);
        })
        .catch(() => undefined);
      if (loadedAccounts.length > 0) {
        void isPermissionGranted()
          .then((granted) => (granted ? undefined : requestPermission()))
          .catch(() => undefined);
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setReady(true);
    }
  }, [setAccounts, setError, setSettings]);

  useEffect(() => {
    if (!inTauri()) return;
    void loadAccounts();
    const unsubscribers: Array<() => void> = [];
    void api.onSyncState(setSync).then((fn) => unsubscribers.push(fn));
    void api
      .onMenuAction((action) => {
        window.dispatchEvent(
          new CustomEvent("postal:menu-action", { detail: action }),
        );
      })
      .then((fn) => unsubscribers.push(fn));
    const handleUrls = (urls: string[]) =>
      urls
        .filter((url) => /^mailto:/i.test(url))
        .forEach((url) => openComposer({ prefill: parseMailto(url) }));
    void getCurrent()
      .then((urls) => {
        if (urls) handleUrls(urls);
      })
      .catch(() => undefined);
    void onOpenUrl(handleUrls).then((fn) => unsubscribers.push(fn));
    return () => unsubscribers.forEach((fn) => fn());
  }, [loadAccounts, openComposer, setSync]);

  useEffect(() => {
    document.documentElement.dataset.platform = /Mac/i.test(navigator.userAgent)
      ? "macos"
      : /Windows/i.test(navigator.userAgent)
        ? "windows"
        : "linux";
  }, []);

  if (!ready)
    return (
      <div className="splash" role="status">
        {strings.app.starting}
      </div>
    );

  if (!inTauri()) {
    return (
      <main className="preview-notice">
        <div className="brand-mark" aria-hidden="true">
          ✉
        </div>
        <h1>{strings.appName}</h1>
        <p>{strings.app.preview}</p>
      </main>
    );
  }

  return (
    <>
      {accounts.length === 0 ? (
        <main className="setup-host">
          <SetupWizard onComplete={loadAccounts} />
        </main>
      ) : (
        <MailShell onOpenSettings={() => setSettingsOpen(true)} />
      )}
      {composerOpen && composerAccountId ? (
        <Suspense
          fallback={
            <div className="splash overlay-splash" role="status">
              {strings.app.openingEditor}
            </div>
          }
        >
          <Composer
            key={`${composerAccountId}:${composeSeed?.draft?.id ?? composeSeed?.sourceMessage?.id ?? "new"}`}
            accountId={composerAccountId}
          />
        </Suspense>
      ) : null}
      {settingsOpen ? (
        <SettingsDialog onClose={() => setSettingsOpen(false)} />
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
    </>
  );
}
