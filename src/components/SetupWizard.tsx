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
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "../api";
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
}

const iCloudImap: ServerConfig = {
  host: "imap.mail.me.com",
  port: 993,
  tlsMode: "tls",
  username: "",
};
const iCloudSmtp: ServerConfig = {
  host: "smtp.mail.me.com",
  port: 587,
  tlsMode: "startTls",
  username: "",
};

export function SetupWizard({ onComplete }: Props) {
  const [provider, setProvider] = useState<ProviderKind>();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [imap, setImap] = useState(iCloudImap);
  const [smtp, setSmtp] = useState(iCloudSmtp);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{
    kind: "working" | "success" | "error";
    text: string;
  }>();

  const request = useMemo<AccountSetupRequest>(
    () => ({
      provider: provider ?? "icloud",
      displayName: displayName.trim(),
      email: email.trim(),
      password,
      imap: provider === "manual" ? imap : undefined,
      smtp: provider === "manual" ? smtp : undefined,
    }),
    [displayName, email, imap, password, provider, smtp],
  );

  function updateServer(kind: "imap" | "smtp", patch: Partial<ServerConfig>) {
    const update = (server: ServerConfig) => ({ ...server, ...patch });
    if (kind === "imap") setImap(update);
    else setSmtp(update);
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
      await onComplete();
    } catch (cause) {
      setStatus({ kind: "error", text: String(cause) });
    } finally {
      setPassword("");
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
              onClick={() => setProvider("icloud")}
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
              onClick={() => setProvider("manual")}
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
            <ArrowLeft /> {strings.common.back}
          </button>
          <div
            className="setup-progress compact"
            aria-label={strings.setup.stepTwo}
          >
            <span className="done">
              <Check />
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
              onClick={() => void openUrl("https://support.apple.com/102654")}
            >
              {strings.setup.createAppPassword} <ExternalLink />
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
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={
                provider === "icloud"
                  ? strings.setup.icloudEmailPlaceholder
                  : strings.setup.emailPlaceholder
              }
            />
          </label>
        </div>
        <label className="field-label">
          {provider === "icloud"
            ? strings.setup.appPassword
            : strings.setup.emailPassword}
          <span className="password-field">
            <input
              required
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
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
              {showPassword ? <EyeOff /> : <Eye />}
            </button>
          </span>
        </label>
        {provider === "manual" ? (
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
        ) : null}
        {status ? (
          <div
            className={`connection-status ${status.kind}`}
            role="status"
            aria-live="polite"
          >
            {status.kind === "success" ? <Check /> : <ShieldCheck />}
            <span>{status.text}</span>
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
          />
        </label>
      </div>
    </fieldset>
  );
}
