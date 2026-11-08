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

// One short sentence visible; the rest sits behind a named "Learn more".
export function HelpText({
  label,
  short,
  more,
}: {
  label: string;
  short: string;
  more?: string;
}) {
  return (
    <>
      <small>{short}</small>
      {more ? <HelpMore label={label} more={more} /> : null}
    </>
  );
}

// Sits outside the row's <label>, so its text never joins the control's name.
export function HelpMore({ label, more }: { label: string; more: string }) {
  return (
    <details className="help-more">
      <summary aria-label={strings.settings.learnMoreAbout(label)}>
        {strings.settings.learnMore}
      </summary>
      <small>{more}</small>
    </details>
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
    <div className="settings-row-stack">
      <label className="settings-row">
        <span>
          <strong>{title}</strong>
          {help ? <small>{help}</small> : null}
        </span>
        {children}
      </label>
      {helpMore ? <HelpMore label={title} more={helpMore} /> : null}
    </div>
  );
}
