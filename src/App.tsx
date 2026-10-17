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
import { ErrorBoundary } from "./components/ErrorBoundary";
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
import { NoticeRegion } from "./components/NoticeRegion";
import {
  SettingsDialog,
  type RuleSeed,
  type SettingsTab,
} from "./components/SettingsDialog";
import { useAppStore } from "./store";
import { useSettingsSave } from "./components/settings/useSettingsSave";
import { applySettings } from "./settings";
import { mailboxWindowTitle } from "./windowTitle";
import { useUnreadBadge } from "./hooks/useUnreadBadge";
import {
  checkUpdateInteractive,
  checksUpdatesOnStartup,
  runUpdateSingleFlight,
  startBackgroundUpdateWhileHidden,
  startDeferredUpdateOnQuit,
  startPeriodicUpdateCheck,
  quitOrApplyPendingUpdate,
} from "./update";

type SetupScreen = "flow" | "wizard";

interface SavedComposerDraft {
  accountId: string;
  composeNonce: number;
  draftId: string;
}

const Composer = lazy(() =>
  import("./components/Composer").then((module) => ({
    default: module.Composer,
  })),
);

const TEXT_ENTRY_SELECTOR =
  "textarea, select, input:not([type]), input[type='text'], input[type='search'], input[type='email'], input[type='url'], input[type='tel'], input[type='password'], input[type='number']";
export default function App() {
  const accounts = useAppStore((state) => state.accounts);
  const activeAccountId = useAppStore((state) => state.activeAccountId);
  const mailboxes = useAppStore((state) => state.mailboxes);
  const settings = useAppStore((state) => state.settings);
  const setAccounts = useAppStore((state) => state.setAccounts);
  const setSettings = useAppStore((state) => state.setSettings);
  const setSync = useAppStore((state) => state.setSync);
  const setError = useAppStore((state) => state.setError);
  const composerOpen = useAppStore((state) => state.composerOpen);
  const composerAccountId = useAppStore((state) => state.composerAccountId);
  const composeSeed = useAppStore((state) => state.composeSeed);
  const composeNonce = useAppStore((state) => state.composeNonce);
  const openComposer = useAppStore((state) => state.openComposer);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsAccountId, setSettingsAccountId] = useState<string>();
  const [settingsRuleSeed, setSettingsRuleSeed] = useState<RuleSeed>();
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
  const savedComposerDraft = useRef<SavedComposerDraft | undefined>(undefined);

  useUnreadBadge();

  const onComposerDraftSaved = useCallback(
    (draftId: string) => {
      const current = useAppStore.getState();
      if (
        !composerAccountId ||
        !current.composerOpen ||
        current.composerAccountId !== composerAccountId ||
        current.composeNonce !== composeNonce
      )
        return;
      savedComposerDraft.current = {
        accountId: composerAccountId,
        composeNonce,
        draftId,
      };
    },
    [composerAccountId, composeNonce],
  );

  const retryComposer = useCallback(async () => {
    const accountId = composerAccountId;
    const current = useAppStore.getState();
    if (
      !accountId ||
      !current.composerOpen ||
      current.composerAccountId !== accountId ||
      current.composeNonce !== composeNonce
    )
      return;

    const identity = savedComposerDraft.current;
    const seed = current.composeSeed;
    const draftId =
      identity?.accountId === accountId &&
      identity.composeNonce === composeNonce
        ? identity.draftId
        : (seed?.draft?.id ?? seed?.draftSummary?.id);
    if (!draftId) return;

    const [summaries, draft] = await Promise.all([
      api.listDrafts(accountId),
      api.getDraft(draftId, accountId),
    ]);
    const summary = summaries.find(
      (item) => item.id === draftId && item.accountId === accountId,
    );
    if (!summary) throw new Error("The saved draft could not be reopened.");

    const latest = useAppStore.getState();
    if (
      !latest.composerOpen ||
      latest.composerAccountId !== accountId ||
      latest.composeNonce !== composeNonce
    )
      return;
    useAppStore.setState((state) => ({
      composeSeed: {
        ...(state.composeSeed ?? {}),
        draft,
        draftSummary: summary,
      },
    }));
  }, [composerAccountId, composeNonce]);

  const claimAccountlessSetup = useCallback(() => {
    const setupCompleted = useAppStore.getState().settings.setupCompleted;
    setSetupSession(
      (current) => current ?? (setupCompleted ? "wizard" : "flow"),
    );
  }, []);

  // Best-effort: routing already trusts the accounts, so ignore failures.
  const { update: repairSettings } = useSettingsSave();

  const openSettings = useCallback(
    (tab: SettingsTab = "general", accountId?: string, ruleSeed?: RuleSeed) => {
      setSettingsTab(tab);
      setSettingsAccountId(accountId);
      setSettingsRuleSeed(ruleSeed);
      setSettingsRouteRequest((value) => value + 1);
      setSettingsOpen(true);
    },
    [],
  );

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
    const account = accounts.find((item) => item.id === activeAccountId);
    const inbox = mailboxes.find(
      (mailbox) =>
        mailbox.accountId === activeAccountId && mailbox.role === "inbox",
    );
    const unread = inbox?.unreadCount ?? 0;
    document.title = mailboxWindowTitle({
      unread,
      accountLabel: account?.displayName || account?.email,
      severalAccounts: accounts.length > 1,
    });
  }, [accounts, activeAccountId, mailboxes]);

  useEffect(() => {
    const onCreateRule = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          accountId?: string;
          contains?: string;
          field?: RuleSeed["field"];
        }>
      ).detail;
      const contains = detail?.contains?.trim();
      if (!detail?.accountId || !contains) return;
      const field =
        detail.field === "to" || detail.field === "subject"
          ? detail.field
          : "from";
      openSettings("accounts", detail.accountId, {
        accountId: detail.accountId,
        contains,
        field,
      });
    };
    window.addEventListener("postal:create-rule", onCreateRule);
    return () => window.removeEventListener("postal:create-rule", onCreateRule);
  }, [openSettings]);

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
    const cancelBackgroundUpdate = startBackgroundUpdateWhileHidden();
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
    // An update relaunch forwards the original mailto: argument; skip it.
    void api
      .updateRelaunch()
      .catch(() => null)
      .then((relaunch) => (relaunch ? null : getCurrent()))
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
      cancelBackgroundUpdate();
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
      // macOS Control keys edit text (Ctrl+P is previous line); use Command.
      const mod =
        document.documentElement.dataset.platform === "macos"
          ? event.metaKey
          : event.metaKey || event.ctrlKey;
      if (mod) {
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
    void api.setComposerOpen(composerOpen).catch(() => undefined);
  }, [composerOpen]);

  useEffect(() => {
    const syncGuard = () => {
      const target = document.activeElement as HTMLElement | null;
      // Text fields own editing keys such as Cmd+Backspace, so native mail
      // commands must not take them while one has focus.
      const guarded = Boolean(
        document.querySelector(
          ".composer-layer, .settings-window, .modal-layer",
        ) ||
        target?.closest("[contenteditable='true']") ||
        target?.matches(TEXT_ENTRY_SELECTOR),
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
        <NoticeRegion />
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
      onOpenSettings={(tab, accountId) =>
        openSettings(tab === "accounts" ? "accounts" : "general", accountId)
      }
    />
  );

  return (
    <>
      <ContextMenuHost />
      <div className="app-viewport" inert={settingsOpen || undefined}>
        {mainContent}
      </div>
      {composerOpen && composerAccountId ? (
        <ErrorBoundary
          className="modal-layer composer-recovery crash-recovery"
          modal
          resetKey={`${composerAccountId}:${composeNonce}`}
          onReset={retryComposer}
          focusSelector="#composer-subject"
        >
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
              onDraftSaved={onComposerDraftSaved}
            />
          </Suspense>
        </ErrorBoundary>
      ) : null}
      {settingsOpen ? (
        <ErrorBoundary
          className="modal-layer settings-recovery crash-recovery"
          modal
          onClose={() => setSettingsOpen(false)}
          focusSelector=".settings-layer button:not([disabled])"
        >
          <SettingsDialog
            key={`${settingsTab}:${settingsRouteRequest}`}
            initialTab={settingsTab}
            initialAccountId={settingsAccountId}
            initialRuleSeed={settingsRuleSeed}
            onClose={() => setSettingsOpen(false)}
            onLastAccountRemoved={claimAccountlessSetup}
          />
        </ErrorBoundary>
      ) : null}
      <NoticeRegion />
      <WindowChrome />
    </>
  );
}
