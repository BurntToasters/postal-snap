import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Cloud,
  ExternalLink,
  Eye,
  EyeOff,
  LoaderCircle,
  Server,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { api } from "../api";
import { describeSetupError } from "../errors";
import { strings } from "../i18n";
import type {
  AccountSetupRequest,
  AccountSummary,
  MailSettingsDiscovery,
  ProviderKind,
  ServerConfig,
  SyncProgress,
} from "../types";
import { AppMark } from "./AppMark";
import {
  APPLE_APP_PASSWORD_GUIDE_URL,
  inspectAndOpenExternalLink,
} from "./externalLink";
import {
  defaultPort,
  emptyManualImap,
  emptyManualSmtp,
  isStandardPort,
  preparePassword,
  trimServer,
} from "./setup/request";
import { ServerFields } from "./setup/serverFields";

interface Props {
  onComplete: () => Promise<void>;
  onOpenSettings?: () => void;
  embedded?: boolean;
}

const iCloudImapSummary = {
  host: "imap.mail.me.com",
  port: 993,
  security: strings.setup.tls,
};

const iCloudSmtpSummary = {
  host: "smtp.mail.me.com",
  port: 587,
  security: strings.setup.startTls,
};

export function SetupWizard({ onComplete, onOpenSettings, embedded }: Props) {
  const [provider, setProvider] = useState<ProviderKind>();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [imap, setImap] = useState(emptyManualImap);
  const [smtp, setSmtp] = useState(emptyManualSmtp);
  const [discovery, setDiscovery] = useState<MailSettingsDiscovery>();
  const [discovering, setDiscovering] = useState(false);
  const [cacheMode, setCacheMode] = useState<"recent" | "full">("recent");
  const [savedAccount, setSavedAccount] = useState<AccountSummary>();
  const [syncProgress, setSyncProgress] = useState<SyncProgress>();
  const [openingMailbox, setOpeningMailbox] = useState(false);
  const [testing, setTesting] = useState(false);
  const wizardRef = useRef<HTMLDivElement>(null);
  const previousProviderRef = useRef(provider);
  const [status, setStatus] = useState<{
    kind: "working" | "success" | "error";
    text: string;
    hint?: string;
    showAppPasswordLink?: boolean;
  }>();
  const [helpLinkNotice, setHelpLinkNotice] = useState<string>();

  const normalizedEmail = useMemo(() => {
    const trimmed = email.trim();
    if (provider === "icloud" && trimmed && !trimmed.includes("@")) {
      return `${trimmed}@icloud.com`;
    }
    return trimmed;
  }, [email, provider]);

  const request = useMemo<AccountSetupRequest>(() => {
    const accountProvider =
      discovery?.status === "found"
        ? discovery.accountProvider
        : (provider ?? "icloud");
    return {
      provider: accountProvider,
      displayName: displayName.trim(),
      email: normalizedEmail,
      password: preparePassword(provider ?? "icloud", password),
      imap: accountProvider === "manual" ? trimServer(imap) : undefined,
      smtp: accountProvider === "manual" ? trimServer(smtp) : undefined,
      cachePolicy: {
        mode: cacheMode,
        days: 90,
        maxBytes: cacheMode === "full" ? 0 : 1_073_741_824,
      },
    };
  }, [
    cacheMode,
    discovery,
    displayName,
    imap,
    normalizedEmail,
    password,
    provider,
    smtp,
  ]);

  useEffect(() => {
    if (!savedAccount) return;
    let disposed = false;
    let unlisten: () => void = () => undefined;
    void api
      .getSyncProgress(savedAccount.id)
      .then((progress) => {
        if (!disposed) setSyncProgress(progress);
      })
      .catch(() => undefined);
    void api
      .onSyncProgress((progress) => {
        if (!disposed && progress.accountId === savedAccount.id)
          setSyncProgress(progress);
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
    return () => {
      disposed = true;
      unlisten();
    };
  }, [savedAccount]);

  useEffect(() => {
    const wizard = wizardRef.current;
    if (!wizard) return;
    const host = wizard.closest<HTMLElement>(".setup-host");
    if (host) host.scrollTop = 0;
    if (previousProviderRef.current !== provider) {
      wizard
        .querySelector<HTMLElement>("#setup-title, #setup-form-title")
        ?.focus({ preventScroll: true });
    }
    previousProviderRef.current = provider;
  }, [provider]);

  function chooseProvider(next: ProviderKind) {
    const username = email.trim();
    setProvider(next);
    setPassword("");
    setShowPassword(false);
    setStatus(undefined);
    setHelpLinkNotice(undefined);
    setDiscovery(undefined);
    if (next === "manual") {
      setImap((current) =>
        current.host ? current : emptyManualImap(username),
      );
      setSmtp((current) =>
        current.host ? current : emptyManualSmtp(username),
      );
    }
  }

  function returnToProviderPicker() {
    setProvider(undefined);
    setDiscovery(undefined);
    setPassword("");
    setShowPassword(false);
    setStatus(undefined);
    setHelpLinkNotice(undefined);
  }

  async function discoverSettings() {
    if (discovering) return;
    setDiscovering(true);
    setStatus(undefined);
    setDiscovery(undefined);
    try {
      const found = await api.discoverMailSettings(email.trim());
      setDiscovery(found);
      if (found.status === "found") {
        setImap(found.imap);
        setSmtp(found.smtp);
      } else if (found.status === "notFound") {
        const username = email.trim();
        setImap(emptyManualImap(username));
        setSmtp(emptyManualSmtp(username));
      }
    } catch (cause) {
      const described = describeSetupError(cause, "manual");
      setStatus({
        kind: "error",
        text: described.text,
        hint: described.hint,
      });
    } finally {
      setDiscovering(false);
    }
  }

  function updateEmail(value: string) {
    const previous = email.trim();
    setEmail(value);
    if (provider !== "manual") return;
    const next = value.trim();
    setImap((server) => ({
      ...server,
      username:
        !server.username || server.username === previous
          ? next
          : server.username,
    }));
    setSmtp((server) => ({
      ...server,
      username:
        !server.username || server.username === previous
          ? next
          : server.username,
    }));
  }

  function updateServer(kind: "imap" | "smtp", patch: Partial<ServerConfig>) {
    const apply = (server: ServerConfig) => {
      const next = { ...server, ...patch };
      if (
        patch.tlsMode &&
        patch.tlsMode !== server.tlsMode &&
        isStandardPort(kind, server.port)
      ) {
        next.port = defaultPort(kind, patch.tlsMode);
      }
      return next;
    };
    if (kind === "imap") setImap(apply);
    else setSmtp(apply);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!provider || testing) return;
    setTesting(true);
    setStatus({
      kind: "working",
      text: strings.setup.testing,
    });
    try {
      const account = await api.addAccount(request);
      setStatus({ kind: "success", text: strings.setup.connected });
      setPassword("");
      setSavedAccount(account);
    } catch (cause) {
      const described = describeSetupError(cause, provider);
      setStatus({
        kind: "error",
        text: described.text,
        hint: described.hint,
        showAppPasswordLink: described.showAppPasswordLink,
      });
    } finally {
      setTesting(false);
    }
  }

  async function openHelpLink() {
    setHelpLinkNotice(undefined);
    const url =
      discovery?.status === "found" && discovery.appPasswordUrl
        ? discovery.appPasswordUrl
        : APPLE_APP_PASSWORD_GUIDE_URL;
    const outcome = await inspectAndOpenExternalLink(url);
    if (outcome === "failed")
      setHelpLinkNotice(
        provider === "icloud"
          ? strings.setup.helpLinkFailed
          : strings.setup.providerHelpLinkFailed,
      );
    else if (outcome === "declined")
      setHelpLinkNotice(strings.setup.helpLinkDeclined);
  }

  if (savedAccount) {
    const total = Math.max(
      1,
      syncProgress?.envelopesTotal ?? syncProgress?.bodiesTotal ?? 1,
    );
    const done = Math.min(
      total,
      syncProgress?.envelopesTotal
        ? syncProgress.envelopesDone
        : (syncProgress?.bodiesDone ?? 0),
    );
    return (
      <div
        className={embedded ? "setup-wizard-embedded" : "setup-page"}
        ref={wizardRef}
      >
        <section
          className={`setup-card first-sync${embedded ? " first-sync-embedded" : ""}`}
          aria-labelledby="first-sync-title"
        >
          {!embedded ? <AppMark size={52} /> : null}
          <LoaderCircle className="first-sync-spinner" aria-hidden="true" />
          <h2 id="first-sync-title" tabIndex={-1}>
            {strings.setup.gettingMail}
          </h2>
          <p className="setup-intro">{strings.setup.gettingMailIntro}</p>
          <progress
            aria-label={strings.setup.mailDownloadProgress}
            value={done}
            max={total}
          />
          <button
            type="button"
            className="primary-button full-button"
            disabled={openingMailbox}
            onClick={() => {
              setOpeningMailbox(true);
              void onComplete().catch(() => setOpeningMailbox(false));
            }}
          >
            {strings.setup.openMailbox}
          </button>
        </section>
      </div>
    );
  }

  if (!provider) {
    return (
      <div
        className={embedded ? "setup-wizard-embedded" : "setup-page"}
        ref={wizardRef}
      >
        <section
          className={`setup-card provider-picker${
            embedded ? " provider-picker-embedded" : ""
          }`}
          aria-labelledby="setup-title"
        >
          {!embedded ? (
            <>
              <header className="setup-brand" data-tauri-drag-region="deep">
                <AppMark size={52} />
                <span>
                  <p>{strings.appName}</p>
                  <h1 id="setup-title" tabIndex={-1}>
                    {strings.setup.title}
                  </h1>
                </span>
              </header>
              <p className="setup-intro">{strings.setup.intro}</p>
              <div
                className="setup-progress"
                role="list"
                aria-label={strings.setup.progress}
              >
                <span className="active" role="listitem" aria-current="step">
                  1
                </span>
                <i aria-hidden="true" />
                <span role="listitem">2</span>
                <small>{strings.setup.chooseAccount}</small>
                <small>{strings.setup.signIn}</small>
              </div>
            </>
          ) : (
            <h2
              id="setup-title"
              className="provider-picker-title"
              tabIndex={-1}
            >
              {strings.setup.chooseAccount}
            </h2>
          )}
          <div className="provider-list">
            <button
              type="button"
              className="provider-button provider-primary"
              onClick={() => chooseProvider("icloud")}
            >
              <span className="provider-symbol" aria-hidden="true">
                <Cloud />
              </span>
              <span className="provider-copy">
                <span className="provider-title">
                  <strong>{strings.setup.icloud}</strong>
                  <small className="provider-badge">
                    {strings.setup.recommended}
                  </small>
                </span>
                <small>{strings.setup.icloudRecommended}</small>
              </span>
              <span className="provider-arrow" aria-hidden="true">
                <ChevronRight />
              </span>
            </button>
            <button
              type="button"
              className="provider-button"
              onClick={() => chooseProvider("manual")}
            >
              <span className="provider-symbol" aria-hidden="true">
                <Server />
              </span>
              <span className="provider-copy">
                <strong>{strings.setup.other}</strong>
                <small>{strings.setup.otherDetail}</small>
                <small>{strings.setup.supportedProviders}</small>
              </span>
              <span className="provider-arrow" aria-hidden="true">
                <ChevronRight />
              </span>
            </button>
          </div>
          <div className="privacy-note">
            <ShieldCheck aria-hidden="true" />
            <span>{strings.setup.privacy}</span>
          </div>
          {onOpenSettings ? (
            <button
              type="button"
              className="secondary-button full-button setup-settings-button"
              onClick={onOpenSettings}
            >
              {strings.setup.openSettings}
            </button>
          ) : null}
        </section>
      </div>
    );
  }

  if (provider === "manual" && discovery?.status === "unsupported") {
    return (
      <div
        className={embedded ? "setup-wizard-embedded" : "setup-page"}
        ref={wizardRef}
      >
        <form
          className={`setup-card account-form${
            embedded ? " account-form-embedded" : ""
          }`}
          onSubmit={(event) => {
            event.preventDefault();
            void discoverSettings();
          }}
          aria-labelledby="setup-form-title"
        >
          <header className="setup-form-header" data-tauri-drag-region="deep">
            <button
              className="back-button"
              type="button"
              onClick={returnToProviderPicker}
            >
              <ArrowLeft aria-hidden="true" /> {strings.common.back}
            </button>
          </header>
          <div>
            <h2 id="setup-form-title" tabIndex={-1}>
              {strings.setup.connectOther}
            </h2>
            <p className="setup-intro">{strings.setup.discoverIntro}</p>
          </div>
          <label>
            {strings.setup.email}
            <input
              required
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={strings.setup.emailPlaceholder}
            />
          </label>
          {discovery?.status === "unsupported" ? (
            <div className="connection-status error" role="alert">
              <TriangleAlert aria-hidden="true" />
              <span>
                <strong>{discovery.providerName}</strong>
                <small>{discovery.message}</small>
              </span>
            </div>
          ) : null}
          {status?.kind === "error" ? (
            <div className="connection-status error" role="alert">
              <TriangleAlert aria-hidden="true" />
              <span>
                {status.text}
                {status.hint ? <small>{status.hint}</small> : null}
              </span>
            </div>
          ) : null}
          <button
            className="primary-button full-button"
            type="submit"
            disabled={discovering}
          >
            {discovering
              ? strings.setup.findingSettings
              : strings.setup.findSettings}
          </button>
        </form>
      </div>
    );
  }

  const FormTitle = embedded ? "h2" : "h1";
  const foundProvider = discovery?.status === "found" ? discovery : undefined;
  const requiresAppPassword =
    provider === "icloud" || Boolean(foundProvider?.appPasswordUrl);

  return (
    <div
      className={embedded ? "setup-wizard-embedded" : "setup-page"}
      ref={wizardRef}
    >
      <form
        className={`setup-card account-form${
          embedded ? " account-form-embedded" : ""
        }`}
        onSubmit={submit}
        aria-labelledby="setup-form-title"
      >
        <header className="setup-form-header" data-tauri-drag-region="deep">
          <button
            className="back-button"
            type="button"
            onClick={returnToProviderPicker}
          >
            <ArrowLeft aria-hidden="true" /> {strings.common.back}
          </button>
          {onOpenSettings ? (
            <button
              type="button"
              className="secondary-button setup-settings-button"
              onClick={onOpenSettings}
            >
              {strings.setup.openSettings}
            </button>
          ) : null}
          {!embedded ? (
            <div
              className="setup-progress compact"
              role="list"
              aria-label={strings.setup.stepTwo}
            >
              <span className="done" role="listitem">
                <Check aria-hidden="true" />
              </span>
              <i aria-hidden="true" />
              <span className="active" role="listitem" aria-current="step">
                2
              </span>
            </div>
          ) : null}
        </header>
        <div>
          <FormTitle id="setup-form-title" tabIndex={-1}>
            {provider === "icloud"
              ? strings.setup.connectIcloud
              : foundProvider
                ? strings.setup.connectProvider(foundProvider.providerName)
                : strings.setup.connectOther}
          </FormTitle>
          <p className="setup-intro">
            {provider === "icloud"
              ? strings.setup.icloudIntro
              : foundProvider
                ? strings.setup.settingsFound(foundProvider.providerName)
                : discovery?.status === "notFound"
                  ? strings.setup.settingsNotFound
                  : strings.setup.discoverIntro}
          </p>
        </div>
        {requiresAppPassword ? (
          <div className="setup-help">
            <span>
              {provider === "icloud"
                ? strings.setup.normalPasswordWarning
                : strings.setup.providerPasswordWarning(
                    foundProvider?.providerName ?? "This provider",
                  )}
            </span>
            <button
              type="button"
              className="text-button"
              onClick={() => void openHelpLink()}
            >
              {strings.setup.createAppPassword}{" "}
              <ExternalLink aria-hidden="true" />
            </button>
          </div>
        ) : null}
        <div className="form-grid two-columns">
          <label>
            {strings.setup.yourName}
            <input
              required
              autoComplete="name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={strings.setup.namePlaceholder}
            />
          </label>
          <label>
            {strings.setup.email}
            <input
              required
              type="text"
              inputMode="email"
              autoComplete="email"
              value={email}
              aria-describedby={
                provider === "icloud" ? "setup-email-hint" : undefined
              }
              onChange={(event) => updateEmail(event.target.value)}
              onBlur={() => {
                if (
                  provider === "icloud" &&
                  email.trim() &&
                  !email.includes("@")
                ) {
                  setEmail(`${email.trim()}@icloud.com`);
                }
              }}
              placeholder={
                provider === "icloud"
                  ? strings.setup.icloudEmailPlaceholder
                  : strings.setup.emailPlaceholder
              }
            />
          </label>
        </div>
        {provider === "manual" ? (
          <button
            type="button"
            className="secondary-button full-button"
            disabled={discovering || !email.trim()}
            onClick={() => void discoverSettings()}
          >
            {discovering
              ? strings.setup.findingSettings
              : strings.setup.findSettings}
          </button>
        ) : null}
        {provider === "icloud" ? (
          <p className="setup-field-hint" id="setup-email-hint">
            {strings.setup.icloudEmailHint}
          </p>
        ) : null}
        <div className="field-label">
          <label htmlFor="setup-password">
            {requiresAppPassword
              ? strings.setup.appPassword
              : strings.setup.emailPassword}
          </label>
          <span className="password-field">
            <input
              id="setup-password"
              required
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              spellCheck={false}
              value={password}
              aria-describedby={
                requiresAppPassword ? "setup-password-hint" : undefined
              }
              onChange={(event) => setPassword(event.target.value)}
              placeholder={
                requiresAppPassword
                  ? strings.setup.appPasswordPlaceholder
                  : undefined
              }
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={
                showPassword
                  ? strings.setup.hidePassword
                  : strings.setup.showPassword
              }
            >
              {showPassword ? (
                <EyeOff aria-hidden="true" />
              ) : (
                <Eye aria-hidden="true" />
              )}
            </button>
          </span>
        </div>
        {requiresAppPassword ? (
          <p className="setup-field-hint" id="setup-password-hint">
            {provider === "icloud"
              ? strings.setup.appPasswordHint
              : strings.setup.providerAppPasswordHint(
                  foundProvider?.providerName ?? "provider",
                )}
          </p>
        ) : null}
        {provider === "icloud" ? (
          <div
            className="server-summary"
            aria-label={strings.setup.icloudServers}
          >
            <p>{strings.setup.icloudServers}</p>
            <dl>
              <div>
                <dt>{strings.setup.incoming}</dt>
                <dd>
                  {`${iCloudImapSummary.host} · ${iCloudImapSummary.port} · ${iCloudImapSummary.security}`}
                </dd>
              </div>
              <div>
                <dt>{strings.setup.outgoing}</dt>
                <dd>
                  {`${iCloudSmtpSummary.host} · ${iCloudSmtpSummary.port} · ${iCloudSmtpSummary.security}`}
                </dd>
              </div>
            </dl>
          </div>
        ) : (
          <div className="server-settings">
            <ServerFields
              title={strings.setup.incoming}
              value={imap}
              onChange={(patch) => updateServer("imap", patch)}
            />
            <ServerFields
              title={strings.setup.outgoing}
              value={smtp}
              onChange={(patch) => updateServer("smtp", patch)}
            />
          </div>
        )}
        <fieldset className="download-choice">
          <legend>{strings.setup.downloadMail}</legend>
          <label>
            <input
              type="radio"
              name="setup-cache-mode"
              value="recent"
              checked={cacheMode === "recent"}
              onChange={() => setCacheMode("recent")}
            />
            <span>
              <strong>{strings.setup.downloadRecent}</strong>
              <small>{strings.setup.downloadRecentHelp}</small>
            </span>
          </label>
          <label>
            <input
              type="radio"
              name="setup-cache-mode"
              value="full"
              checked={cacheMode === "full"}
              onChange={() => setCacheMode("full")}
              aria-label={strings.setup.downloadAll}
            />
            <span>
              <strong>{strings.setup.downloadAll}</strong>
              <small>{strings.setup.downloadAllHelp}</small>
            </span>
          </label>
        </fieldset>
        {status ? (
          <div
            className={`connection-status ${status.kind}`}
            role={status.kind === "error" ? "alert" : "status"}
            aria-live={status.kind === "error" ? "assertive" : "polite"}
          >
            {status.kind === "error" ? (
              <TriangleAlert aria-hidden="true" />
            ) : status.kind === "success" ? (
              <Check aria-hidden="true" />
            ) : (
              <ShieldCheck aria-hidden="true" />
            )}
            <span>
              {status.text}
              {status.hint ? <small>{status.hint}</small> : null}
              {status.showAppPasswordLink ? (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void openHelpLink()}
                >
                  {strings.setup.createAppPassword}{" "}
                  <ExternalLink aria-hidden="true" />
                </button>
              ) : null}
            </span>
          </div>
        ) : null}
        {helpLinkNotice ? (
          <p className="setup-field-hint" role="status">
            {helpLinkNotice}
          </p>
        ) : null}
        <button
          className="primary-button full-button"
          type="submit"
          disabled={testing}
        >
          {testing ? strings.setup.connecting : strings.setup.connect}
        </button>
      </form>
    </div>
  );
}
