import type { ReactNode } from "react";
import { strings } from "../../i18n";

export type SettingsTab =
  | "appearance"
  | "general"
  | "reading"
  | "notifications"
  | "storage"
  | "accounts"
  | "shortcuts"
  | "updates"
  | "advanced"
  | "about";

export function SettingsPanel({
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

export function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-section">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function SettingsGroup({ children }: { children: ReactNode }) {
  return <div className="settings-group">{children}</div>;
}

// One short sentence visible; the rest sits behind "Learn more".
export function HelpText({ short, more }: { short: string; more?: string }) {
  return (
    <>
      <small>{short}</small>
      {more ? (
        <details className="help-more">
          <summary>{strings.settings.learnMore}</summary>
          <small>{more}</small>
        </details>
      ) : null}
    </>
  );
}

export function SettingRow({
  title,
  help,
  helpMore,
  children,
}: {
  title: string;
  help?: string;
  helpMore?: string;
  children: ReactNode;
}) {
  return (
    <label className="settings-row">
      <span>
        <strong>{title}</strong>
        {help ? <HelpText short={help} more={helpMore} /> : null}
      </span>
      {children}
    </label>
  );
}
