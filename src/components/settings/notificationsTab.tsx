import { useState } from "react";
import { api } from "../../api";
import { errorText } from "../../errors";
import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import { SettingsGroup, SettingsPanel, SettingsSection } from "./primitives";
import type { SettingsSaveUpdate } from "./useSettingsSave";

interface NotificationsTabProps {
  update: SettingsSaveUpdate;
}

export function NotificationsTab({ update }: NotificationsTabProps) {
  const settings = useAppStore((state) => state.settings);
  const accounts = useAppStore((state) => state.accounts);
  const [sameTimes, setSameTimes] = useState(false);
  const [accountError, setAccountError] = useState<string>();

  // Optimistic: the switch flips at once and rolls back if the save fails.
  async function setAccountNotify(accountId: string, enabled: boolean) {
    const before = accounts.find((item) => item.id === accountId);
    const apply = (value: boolean) =>
      useAppStore
        .getState()
        .setAccounts(
          useAppStore
            .getState()
            .accounts.map((item) =>
              item.id === accountId ? { ...item, notifyNewMail: value } : item,
            ),
        );
    apply(enabled);
    setAccountError(undefined);
    try {
      await api.setAccountNotifications(accountId, enabled);
    } catch (cause) {
      apply(before?.notifyNewMail !== false);
      setAccountError(errorText(cause));
    }
  }

  function changeQuietHours(which: "start" | "end", value: string) {
    const start = which === "start" ? value : settings.quietHoursStart;
    const end = which === "end" ? value : settings.quietHoursEnd;
    if (start && end && start === end) {
      setSameTimes(true);
      return;
    }
    setSameTimes(false);
    void update({ quietHoursStart: start, quietHoursEnd: end });
  }

  return (
    <SettingsPanel id="notifications" title={strings.settings.notifications}>
      <SettingsGroup>
        <label className="switch-row">
          <span>
            <strong>{strings.settings.notifyNewMail}</strong>
            <small>{strings.settings.notifyNewMailHelp}</small>
          </span>
          <input
            type="checkbox"
            checked={settings.notifyNewMail}
            onChange={(event) =>
              void update({ notifyNewMail: event.target.checked })
            }
          />
        </label>
        <label className="switch-row">
          <span>
            <strong>{strings.settings.newMailSound}</strong>
            <small>{strings.settings.newMailSoundHelp}</small>
          </span>
          <input
            type="checkbox"
            checked={settings.newMailSound}
            onChange={(event) =>
              void update({ newMailSound: event.target.checked })
            }
          />
        </label>
        <div className="switch-row">
          <span>
            <strong>{strings.settings.quietHours}</strong>
            <small>{strings.settings.quietHoursHelp}</small>
          </span>
          <span className="quiet-hours-times">
            <label>
              {strings.settings.quietHoursFrom}
              <input
                type="time"
                value={settings.quietHoursStart}
                onChange={(event) =>
                  changeQuietHours("start", event.target.value)
                }
              />
            </label>
            <label>
              {strings.settings.quietHoursUntil}
              <input
                type="time"
                value={settings.quietHoursEnd}
                onChange={(event) =>
                  changeQuietHours("end", event.target.value)
                }
              />
            </label>
          </span>
        </div>
        {sameTimes ? (
          <p className="settings-row-error" role="alert">
            {strings.settings.quietHoursSame}
          </p>
        ) : null}
        <label className="switch-row">
          <span>
            <strong>{strings.settings.privateNotifications}</strong>
            <small>{strings.settings.privateNotificationsHelp}</small>
          </span>
          <input
            type="checkbox"
            checked={settings.privateNotifications}
            onChange={(event) =>
              void update({
                privateNotifications: event.target.checked,
              })
            }
          />
        </label>
      </SettingsGroup>
      {accounts.length > 0 ? (
        <SettingsSection title={strings.settings.notifyPerAccount}>
          <SettingsGroup>
            {accounts.map((account) => (
              <label className="switch-row" key={account.id}>
                <span>
                  <strong>{account.displayName}</strong>
                  <small>{account.email}</small>
                </span>
                <input
                  type="checkbox"
                  aria-label={strings.settings.accountNotifyNewMailFor(
                    account.displayName,
                  )}
                  checked={account.notifyNewMail !== false}
                  onChange={(event) =>
                    void setAccountNotify(account.id, event.target.checked)
                  }
                />
              </label>
            ))}
          </SettingsGroup>
          {accountError ? (
            <p className="settings-row-error" role="alert">
              {accountError}
            </p>
          ) : null}
        </SettingsSection>
      ) : null}
    </SettingsPanel>
  );
}
