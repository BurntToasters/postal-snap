import {
  useEffect,
  useRef,
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  ChevronDown,
  Clock,
  ImagePlus,
  Moon,
  Paperclip,
  Save,
  Send,
  Sunrise,
} from "lucide-react";
import { shortcutMod } from "../../format";
import { strings } from "../../i18n";
import { moveMenuFocus } from "../toolbarNav";
import { tonightAtNine, tomorrowAtEight } from "./schedule";

export interface SendBarProps {
  sendMenuRef: RefObject<HTMLDivElement | null>;
  canSend: boolean;
  sendMessage: (sendAt?: string) => void | Promise<void>;
  sending: boolean;
  sendMenuOpen: boolean;
  setSendMenuOpen: Dispatch<SetStateAction<boolean>>;
  scheduleOpen: boolean;
  setScheduleOpen: Dispatch<SetStateAction<boolean>>;
  scheduleValue: string;
  setScheduleValue: Dispatch<SetStateAction<string>>;
  saveDraft: (showStatus?: boolean) => void | Promise<void>;
  saveState: "unsaved" | "saving" | "saved";
  addAttachments: () => void | Promise<void>;
  addInlineImage: () => void | Promise<void>;
  discardDraft: () => void | Promise<void>;
}

export function SendBar({
  sendMenuRef,
  canSend,
  sendMessage,
  sending,
  sendMenuOpen,
  setSendMenuOpen,
  scheduleOpen,
  setScheduleOpen,
  scheduleValue,
  setScheduleValue,
  saveDraft,
  saveState,
  addAttachments,
  addInlineImage,
  discardDraft,
}: SendBarProps) {
  const chevronRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sendMenuOpen) return;
    menuRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')
      ?.focus();
  }, [sendMenuOpen]);

  function closeMenu() {
    setScheduleOpen(false);
    setSendMenuOpen(false);
    chevronRef.current?.focus();
  }

  return (
    <footer>
      <div className="send-split" ref={sendMenuRef}>
        <button
          className="primary-button send-button"
          type="button"
          disabled={!canSend}
          onClick={() => void sendMessage()}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          aria-label={
            sending ? strings.composer.sending : strings.composer.send
          }
          title={`${sending ? strings.composer.sending : strings.composer.send} (${shortcutMod()}↵)`}
        >
          <Send />
          <span>
            {sending ? strings.composer.sending : strings.composer.send}
          </span>
          <kbd className="send-kbd-hint">{`${shortcutMod()}↵`}</kbd>
        </button>
        <button
          className="primary-button send-chevron"
          type="button"
          ref={chevronRef}
          disabled={!canSend}
          aria-expanded={sendMenuOpen}
          aria-haspopup="menu"
          aria-label={strings.composer.sendOptions}
          title={strings.composer.sendOptions}
          onClick={() => {
            setSendMenuOpen((value) => !value);
            setScheduleOpen(false);
          }}
        >
          <ChevronDown aria-hidden="true" />
        </button>
        {sendMenuOpen ? (
          <div
            className="send-menu app-menu"
            ref={menuRef}
            role="menu"
            aria-label={strings.composer.sendOptions}
            onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
              if (event.key === "Escape" || event.key === "Tab") {
                event.preventDefault();
                event.stopPropagation();
                closeMenu();
                return;
              }
              if (
                event.target instanceof HTMLElement &&
                event.target.matches("input, textarea")
              )
                return;
              moveMenuFocus(event);
            }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setSendMenuOpen(false);
                void sendMessage();
              }}
            >
              <Send aria-hidden="true" />
              {strings.composer.sendNow}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setSendMenuOpen(false);
                void sendMessage(tonightAtNine().toISOString());
              }}
            >
              <Moon aria-hidden="true" />
              {strings.composer.sendTonight}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setSendMenuOpen(false);
                void sendMessage(tomorrowAtEight().toISOString());
              }}
            >
              <Sunrise aria-hidden="true" />
              {strings.composer.sendTomorrow}
            </button>
            <button
              type="button"
              role="menuitem"
              aria-expanded={scheduleOpen}
              onClick={() => setScheduleOpen((value) => !value)}
            >
              <Clock aria-hidden="true" />
              {strings.composer.sendCustom}
            </button>
            {scheduleOpen ? (
              <form
                className="schedule-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const iso = new Date(scheduleValue).toISOString();
                  setSendMenuOpen(false);
                  setScheduleOpen(false);
                  void sendMessage(iso);
                }}
              >
                <label>
                  <span>{strings.composer.scheduleTime}</span>
                  <input
                    type="datetime-local"
                    required
                    value={scheduleValue}
                    onChange={(event) => setScheduleValue(event.target.value)}
                  />
                </label>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={!scheduleValue}
                >
                  {strings.composer.scheduleAction}
                </button>
              </form>
            ) : null}
          </div>
        ) : null}
      </div>
      <button
        className="toolbar-button"
        type="button"
        onClick={() => void saveDraft(false)}
        disabled={sending || saveState === "saving"}
        aria-keyshortcuts="Meta+S Control+S"
        title={`${strings.composer.saveDraft} (${shortcutMod()}+S)`}
      >
        <Save aria-hidden="true" />
        {saveState === "saving"
          ? strings.common.saving
          : saveState === "saved"
            ? strings.composer.draftSaved
            : strings.composer.saveDraft}
      </button>
      <button
        className="toolbar-button"
        type="button"
        onClick={() => void addAttachments()}
        disabled={sending}
      >
        <Paperclip />
        {strings.composer.attach}
      </button>
      <button
        className="toolbar-button"
        type="button"
        onClick={() => void addInlineImage()}
        disabled={sending}
      >
        <ImagePlus />
        {strings.composer.picture}
      </button>
      <button
        className="discard-button"
        type="button"
        onClick={() => void discardDraft()}
        disabled={sending || saveState === "saving"}
      >
        {strings.composer.discard}
      </button>
    </footer>
  );
}
