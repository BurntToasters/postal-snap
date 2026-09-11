import { strings } from "../../i18n";
import type { ServerConfig, TlsMode } from "../../types";

export function ServerFields({
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
