import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ChevronDown,
  Clock,
  ImagePlus,
  Moon,
  Paperclip,
  Save,
  Send,
  Sunrise,
} from "lucide-react";
import { formatMessageDate, shortcutChord } from "../../format";
import { strings } from "../../i18n";
import { moveMenuFocus } from "../toolbarNav";
import { placeSendMenu } from "./sendMenuPlacement";
import { tonightAtNine, tomorrowAtEight } from "./schedule";

export interface SendBarProps {
  sendMenuRef: RefObject<HTMLDivElement | null>;
  canSend: boolean;
  sendMessage: (sendAt?: string) => void | Promise<void>;
  sendAndArchive?: () => void | Promise<void>;
  sending: boolean;
  sendMenuOpen: boolean;
  setSendMenuOpen: Dispatch<SetStateAction<boolean>>;
  scheduleOpen: boolean;
  setScheduleOpen: Dispatch<SetStateAction<boolean>>;
  scheduleValue: string;
  setScheduleValue: Dispatch<SetStateAction<string>>;
  saveDraft: (showStatus?: boolean) => void | Promise<void>;
  saveState: "unsaved" | "saving" | "saved";
  savedAt?: string;
  addAttachments: () => void | Promise<void>;
  addInlineImage: () => void | Promise<void>;
  discardDraft: () => void | Promise<void>;
  showAttachments?: boolean;
  /** Resize grip for the floating composer. */
  children?: ReactNode;
}

export function SendBar({
  sendMenuRef,
  canSend,
  sendMessage,
  sendAndArchive,
  sending,
  sendMenuOpen,
  setSendMenuOpen,
  scheduleOpen,
  setScheduleOpen,
  scheduleValue,
  setScheduleValue,
  saveDraft,
  saveState,
  savedAt,
  addAttachments,
  addInlineImage,
  discardDraft,
  showAttachments = true,
  children,
}: SendBarProps) {
  const chevronRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Placed before paint, and again when the schedule form changes its height.
  const placeMenu = useCallback(() => {
    const menu = menuRef.current;
    const trigger = sendMenuRef.current;
    if (menu && trigger) placeSendMenu(menu, trigger);
  }, [sendMenuRef]);

  useLayoutEffect(() => {
    if (sendMenuOpen) placeMenu();
  }, [placeMenu, scheduleOpen, sendMenuOpen]);

  useEffect(() => {
    if (!sendMenuOpen) return;
    menuRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')
      ?.focus();
    const view = window.visualViewport;
    // The footer scrolls sideways when narrow; scrolls inside the menu are ignored.
    const onScroll = (event: Event) => {
      const inMenu =
        event.target instanceof Node && menuRef.current?.contains(event.target);
      if (!inMenu) placeMenu();
    };
    window.addEventListener("resize", placeMenu);
    view?.addEventListener("resize", placeMenu);
    document.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener("resize", placeMenu);
      view?.removeEventListener("resize", placeMenu);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [placeMenu, sendMenuOpen]);

  function closeMenu() {
    setScheduleOpen(false);
    setSendMenuOpen(false);
    chevronRef.current?.focus();
  }

  return (
    <footer className={children ? "has-resize-grip" : undefined}>
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
          title={`${sending ? strings.composer.sending : strings.composer.send} (${shortcutChord("↵")})`}
        >
          <Send />
          <span>
            {sending ? strings.composer.sending : strings.composer.send}
          </span>
          <kbd className="send-kbd-hint">{shortcutChord("↵")}</kbd>
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
        {/* Portaled to body so the footer's scroll container cannot clip it.
            Presses stop here so the composer's outside-press listener ignores them. */}
        {sendMenuOpen
          ? createPortal(
              <div
                className="send-menu app-menu"
                ref={menuRef}
                role="menu"
                aria-label={strings.composer.sendOptions}
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                  const inForm =
                    event.target instanceof HTMLElement &&
                    event.target.closest(".schedule-form");
                  if (event.key === "Tab" && inForm) {
                    event.preventDefault();
                    event.stopPropagation();
                    const input = inForm.querySelector("input");
                    const submit = inForm.querySelector("button");
                    // WebKit's native Tab order can skip buttons.
                    const next =
                      event.target === input && !submit?.disabled
                        ? submit
                        : input;
                    next?.focus();
                    return;
                  }
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
                {sendAndArchive ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setSendMenuOpen(false);
                      void sendAndArchive();
                    }}
                  >
                    <Archive aria-hidden="true" />
                    {strings.composer.sendAndArchive}
                  </button>
                ) : null}
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
                        autoFocus
                        type="datetime-local"
                        required
                        value={scheduleValue}
                        onChange={(event) =>
                          setScheduleValue(event.target.value)
                        }
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
              </div>,
              document.body,
            )
          : null}
      </div>
      <button
        className="toolbar-button"
        type="button"
        onClick={() => void saveDraft(false)}
        disabled={sending || saveState === "saving"}
        aria-keyshortcuts="Meta+S Control+S"
        title={`${strings.composer.saveDraft} (${shortcutChord("S")})`}
      >
        <Save aria-hidden="true" />
        {saveState === "saving"
          ? strings.common.saving
          : saveState === "saved"
            ? savedAt
              ? strings.composer.draftSavedAt(formatMessageDate(savedAt))
              : strings.composer.draftSaved
            : strings.composer.saveDraft}
      </button>
      {showAttachments ? (
        <button
          className="toolbar-button"
          type="button"
          onClick={() => void addAttachments()}
          disabled={sending}
        >
          <Paperclip />
          {strings.composer.attach}
        </button>
      ) : null}
      {showAttachments ? (
        <button
          className="toolbar-button"
          type="button"
          onClick={() => void addInlineImage()}
          disabled={sending}
        >
          <ImagePlus />
          {strings.composer.picture}
        </button>
      ) : null}
      <button
        className="discard-button"
        type="button"
        onClick={() => void discardDraft()}
        disabled={sending || saveState === "saving"}
      >
        {strings.composer.discard}
      </button>
      {children}
    </footer>
  );
}
