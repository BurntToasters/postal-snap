import { useMemo, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  Check,
  Cloud,
  ExternalLink,
  Eye,
  EyeOff,
  Server,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { api } from "../api";
import { describeSetupError } from "../errors";
import { strings } from "../i18n";
import type { AccountSetupRequest, ProviderKind, ServerConfig } from "../types";
import { AppMark } from "./AppMark";
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

export function SetupWizard({ onComplete, onOpenSettings }: Props) {
  const [provider, setProvider] = useState<ProviderKind>();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [imap, setImap] = useState(emptyManualImap);
  const [smtp, setSmtp] = useState(emptyManualSmtp);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{
    kind: "working" | "success" | "error";
    text: string;
    hint?: string;
    showAppPasswordLink?: boolean;
  }>();

  const normalizedEmail = useMemo(() => {
    const trimmed = email.trim();
    if (provider === "icloud" && trimmed && !trimmed.includes("@")) {
      return `${trimmed}@icloud.com`;
    }
    return trimmed;
  }, [email, provider]);

  const request = useMemo<AccountSetupRequest>(
    () => ({
      provider: provider ?? "icloud",
      displayName: displayName.trim(),
      email: normalizedEmail,
      password: preparePassword(provider ?? "icloud", password),
      imap: provider === "manual" ? trimServer(imap) : undefined,
      smtp: provider === "manual" ? trimServer(smtp) : undefined,
    }),
    [displayName, imap, normalizedEmail, password, provider, smtp],
  );

  function chooseProvider(next: ProviderKind) {
    const username = email.trim();
    setProvider(next);
    setPassword("");
    setShowPassword(false);
    setStatus(undefined);
    if (next === "manual") {
      setImap((current) =>
        current.host ? current : emptyManualImap(username),
      );
      setSmtp((current) =>
        current.host ? current : emptyManualSmtp(username),
      );
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
      await api.addAccount(request);
      setStatus({ kind: "success", text: strings.setup.connected });
      setPassword("");
      try {
        await onComplete();
      } catch {
        // The account is already saved. Listing accounts is best-effort.
      }
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

  if (!provider) {
    return (
      <div className="setup-page">
        <section
          className="setup-card provider-picker"
          aria-labelledby="setup-title"
        >
          <header className="setup-brand" data-tauri-drag-region="deep">
            <AppMark size={52} />
            <span>
              <p>{strings.appName}</p>
              <h1 id="setup-title">{strings.setup.title}</h1>
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
          <div className="provider-list">
            <button
              type="button"
              className="provider-button provider-primary"
              onClick={() => chooseProvider("icloud")}
            >
              <span className="provider-symbol" aria-hidden="true">
                <Cloud />
              </span>
              <span>
                <strong>{strings.setup.icloud}</strong>
                <small>{strings.setup.icloudRecommended}</small>
              </span>
              <span className="provider-arrow" aria-hidden="true">
                →
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
              <span>
                <strong>{strings.setup.other}</strong>
                <small>{strings.setup.otherDetail}</small>
              </span>
              <span className="provider-arrow" aria-hidden="true">
                →
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

  return (
    <div className="setup-page">
      <form
        className="setup-card account-form"
        onSubmit={submit}
        aria-labelledby="setup-form-title"
      >
        <header className="setup-form-header" data-tauri-drag-region="deep">
          <button
            className="back-button"
            type="button"
            onClick={() => {
              setProvider(undefined);
              setPassword("");
              setShowPassword(false);
              setStatus(undefined);
            }}
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
        </header>
        <div>
          <h1 id="setup-form-title">
            {provider === "icloud"
              ? strings.setup.connectIcloud
              : strings.setup.connectOther}
          </h1>
          <p className="setup-intro">
            {provider === "icloud"
              ? strings.setup.icloudIntro
              : strings.setup.manualIntro}
          </p>
        </div>
        {provider === "icloud" ? (
          <div className="setup-help">
            <span>{strings.setup.normalPasswordWarning}</span>
            <button
              type="button"
              className="text-button"
              onClick={() => void api.openHelpUrl()}
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
        {provider === "icloud" ? (
          <p className="setup-field-hint" id="setup-email-hint">
            {strings.setup.icloudEmailHint}
          </p>
        ) : null}
        <div className="field-label">
          <label htmlFor="setup-password">
            {provider === "icloud"
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
                provider === "icloud" ? "setup-password-hint" : undefined
              }
              onChange={(event) => setPassword(event.target.value)}
              placeholder={
                provider === "icloud"
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
        {provider === "icloud" ? (
          <p className="setup-field-hint" id="setup-password-hint">
            {strings.setup.appPasswordHint}
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
                  onClick={() => void api.openHelpUrl()}
                >
                  {strings.setup.createAppPassword} <ExternalLink />
                </button>
              ) : null}
            </span>
          </div>
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
