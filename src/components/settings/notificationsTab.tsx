import { useRef, useState } from "react";
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
  // Per-account save chain plus the last value the backend accepted.
  const notifyQueues = useRef(new Map<string, Promise<void>>());
  const notifyCommitted = useRef(new Map<string, boolean>());

  // Optimistic: the switch flips at once and rolls back if the save fails.
  function setAccountNotify(accountId: string, enabled: boolean) {
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
    if (!notifyCommitted.current.has(accountId)) {
      const before = useAppStore
        .getState()
        .accounts.find((item) => item.id === accountId);
      notifyCommitted.current.set(accountId, before?.notifyNewMail !== false);
    }
    apply(enabled);
    setAccountError(undefined);
    const previous = notifyQueues.current.get(accountId) ?? Promise.resolve();
    const run = previous.then(async () => {
      try {
        await api.setAccountNotifications(accountId, enabled);
        notifyCommitted.current.set(accountId, enabled);
      } catch (cause) {
        setAccountError(errorText(cause));
        if (notifyQueues.current.get(accountId) === run) {
          apply(notifyCommitted.current.get(accountId) ?? true);
        }
      }
    });
    notifyQueues.current.set(accountId, run);
    void run.then(() => {
      if (notifyQueues.current.get(accountId) === run) {
        notifyQueues.current.delete(accountId);
        notifyCommitted.current.delete(accountId);
      }
    });
    return run;
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
            {accounts.map((account) => {
              const label = account.displayName || account.email;
              return (
                <label className="switch-row" key={account.id}>
                  <span>
                    <strong>{label}</strong>
                    {account.displayName ? (
                      <small>{account.email}</small>
                    ) : null}
                  </span>
                  <input
                    type="checkbox"
                    aria-label={strings.settings.accountNotifyNewMailFor(label)}
                    checked={account.notifyNewMail !== false}
                    onChange={(event) =>
                      void setAccountNotify(account.id, event.target.checked)
                    }
                  />
                </label>
              );
            })}
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
