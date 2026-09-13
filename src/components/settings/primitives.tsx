import type { ReactNode } from "react";

export type SettingsTab =
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

export function SettingRow({
  title,
  help,
  children,
}: {
  title: string;
  help: string;
  children: ReactNode;
}) {
  return (
    <label className="settings-row">
      <span>
        <strong>{title}</strong>
        <small>{help}</small>
      </span>
      {children}
    </label>
  );
}
