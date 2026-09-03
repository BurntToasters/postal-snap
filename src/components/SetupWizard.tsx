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
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { describeSetupError } from "../errors";
import { strings } from "../i18n";
import type {
  AccountSetupRequest,
  ProviderKind,
  ServerConfig,
  TlsMode,
} from "../types";
import { AppMark } from "./AppMark";

interface Props {
  onComplete: () => Promise<void>;
  onOpenSettings?: () => void;
}

const APPLE_APP_PASSWORD_GUIDE = "https://support.apple.com/102654";

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

function emptyManualImap(username = ""): ServerConfig {
  return { host: "", port: 993, tlsMode: "tls", username };
}

function emptyManualSmtp(username = ""): ServerConfig {
  return { host: "", port: 587, tlsMode: "startTls", username };
}

function defaultPort(kind: "imap" | "smtp", tlsMode: TlsMode): number {
  if (kind === "imap") return tlsMode === "tls" ? 993 : 143;
  return tlsMode === "tls" ? 465 : 587;
}

function isStandardPort(kind: "imap" | "smtp", port: number): boolean {
  return kind === "imap"
    ? port === 993 || port === 143
    : port === 465 || port === 587;
}

function preparePassword(provider: ProviderKind, password: string): string {
  const trimmed = password.trim();
  return provider === "icloud" ? trimmed.replace(/\s+/g, "") : trimmed;
}

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
      imap: provider === "manual" ? imap : undefined,
      smtp: provider === "manual" ? smtp : undefined,
    }),
    [displayName, imap, normalizedEmail, password, provider, smtp],
  );

  function chooseProvider(next: ProviderKind) {
    const username = email.trim();
    setProvider(next);
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
      await onComplete();
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
          <header className="setup-brand">
            <AppMark size={52} />
            <span>
              <p>{strings.appName}</p>
              <h1 id="setup-title">{strings.setup.title}</h1>
            </span>
          </header>
          <p className="setup-intro">{strings.setup.intro}</p>
          <div className="setup-progress" aria-label={strings.setup.progress}>
            <span className="active">1</span>
            <i />
            <span>2</span>
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
        <header className="setup-form-header">
          <button
            className="back-button"
            type="button"
            onClick={() => {
              setProvider(undefined);
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
            aria-label={strings.setup.stepTwo}
          >
            <span className="done">
              <Check aria-hidden="true" />
            </span>
            <i />
            <span className="active">2</span>
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
              onClick={() => void openUrl(APPLE_APP_PASSWORD_GUIDE)}
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
          <p className="setup-field-hint">{strings.setup.icloudEmailHint}</p>
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
          <p className="setup-field-hint">{strings.setup.appPasswordHint}</p>
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
            role="status"
            aria-live="polite"
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
                  onClick={() => void openUrl(APPLE_APP_PASSWORD_GUIDE)}
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

function ServerFields({
  title,
  value,
  onChange,
}: {
  title: string;
  value: ServerConfig;
  onChange: (patch: Partial<ServerConfig>) => void;
}) {
  return (
    <fieldset>
      <legend>{title}</legend>
      <div className="server-grid">
        <label>
          {strings.setup.server}
          <input
            required
            value={value.host}
            onChange={(event) => onChange({ host: event.target.value })}
            placeholder={strings.setup.serverPlaceholder}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label>
          {strings.setup.port}
          <input
            required
            type="number"
            min={1}
            max={65535}
            value={value.port}
            onChange={(event) => onChange({ port: Number(event.target.value) })}
          />
        </label>
        <label>
          {strings.setup.security}
          <select
            value={value.tlsMode}
            onChange={(event) =>
              onChange({ tlsMode: event.target.value as TlsMode })
            }
          >
            <option value="tls">{strings.setup.tls}</option>
            <option value="startTls">{strings.setup.startTls}</option>
          </select>
        </label>
        <label>
          {strings.setup.username}
          <input
            required
            value={value.username}
            onChange={(event) => onChange({ username: event.target.value })}
            placeholder={strings.setup.usernamePlaceholder}
            autoComplete="username"
            spellCheck={false}
          />
        </label>
      </div>
    </fieldset>
  );
}
