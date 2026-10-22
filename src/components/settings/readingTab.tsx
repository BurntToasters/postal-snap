import { strings } from "../../i18n";
import type { AppSettings } from "../../types";
import { useAppStore } from "../../store";
import { SettingRow, SettingsGroup, SettingsPanel } from "./primitives";
import type { SettingsSaveUpdate } from "./useSettingsSave";

interface ReadingTabProps {
  update: SettingsSaveUpdate;
}

export function ReadingTab({ update }: ReadingTabProps) {
  const settings = useAppStore((state) => state.settings);

  return (
    <SettingsPanel id="reading" title={strings.settings.reading}>
      <SettingsGroup>
        <label className="switch-row">
          <span>
            <strong>{strings.settings.showMessagePreviews}</strong>
            <small>{strings.settings.showMessagePreviewsHelp}</small>
          </span>
          <input
            type="checkbox"
            checked={settings.showMessagePreviews}
            onChange={(event) =>
              void update({ showMessagePreviews: event.target.checked })
            }
          />
        </label>
        <label className="switch-row">
          <span>
            <strong>{strings.settings.groupThreads}</strong>
            <small>{strings.settings.groupThreadsHelp}</small>
          </span>
          <input
            type="checkbox"
            checked={settings.groupThreads}
            onChange={(event) =>
              void update({ groupThreads: event.target.checked })
            }
          />
        </label>
        <label className="switch-row">
          <span>
            <strong>{strings.settings.bccSelf}</strong>
            <small>{strings.settings.bccSelfHelp}</small>
          </span>
          <input
            type="checkbox"
            checked={settings.bccSelf}
            onChange={(event) => void update({ bccSelf: event.target.checked })}
          />
        </label>
        <label className="switch-row">
          <span>
            <strong>{strings.settings.replyToAll}</strong>
            <small>{strings.settings.replyToAllHelp}</small>
          </span>
          <input
            type="checkbox"
            checked={settings.replyToAll}
            onChange={(event) =>
              void update({ replyToAll: event.target.checked })
            }
          />
        </label>
        <label className="switch-row">
          <span>
            <strong>{strings.settings.signatureAboveQuote}</strong>
            <small>{strings.settings.signatureAboveQuoteHelp}</small>
          </span>
          <input
            type="checkbox"
            checked={settings.signatureAboveQuote}
            onChange={(event) =>
              void update({ signatureAboveQuote: event.target.checked })
            }
          />
        </label>
        <p className="settings-note">
          <strong>{strings.settings.imageSenders}</strong>{" "}
          {strings.settings.imageSendersHelp}
        </p>
        <SettingRow
          title={strings.settings.markRead}
          help={strings.settings.markReadHelp}
        >
          <select
            aria-label={strings.settings.markRead}
            value={settings.markRead ?? "open"}
            onChange={(event) =>
              void update({
                markRead: event.target.value as AppSettings["markRead"],
              })
            }
          >
            <option value="open">{strings.settings.markReadOpen}</option>
            <option value="after2s">{strings.settings.markReadAfter2s}</option>
            <option value="manual">{strings.settings.markReadManual}</option>
          </select>
        </SettingRow>
        <SettingRow
          title={strings.mail.undoSendWindow}
          help={strings.mail.undoSendHelp}
        >
          <select
            aria-label={strings.mail.undoSendWindow}
            value={settings.undoSendSeconds ?? 10}
            onChange={(event) =>
              void update({ undoSendSeconds: Number(event.target.value) })
            }
          >
            <option value={0}>{strings.mail.undoSendOff}</option>
            {[5, 10, 20, 30].map((seconds) => (
              <option key={seconds} value={seconds}>
                {strings.mail.undoSendSeconds(seconds)}
              </option>
            ))}
          </select>
        </SettingRow>
      </SettingsGroup>
    </SettingsPanel>
  );
}
