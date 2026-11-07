import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type HTMLAttributes,
  type KeyboardEvent,
  type SetStateAction,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckCheck,
  FileText,
  Maximize2,
  Minimize2,
  Minus,
  Ellipsis,
  PenLine,
  TriangleAlert,
  Type,
  X,
} from "lucide-react";
import { formatMessageDate } from "../../format";
import { strings } from "../../i18n";
import type { ComposerSeed } from "../../store";
import type { BodyFormat, DraftSummary } from "../../types";
import { moveMenuFocus } from "../toolbarNav";
import { composerTitle } from "./composerSeed";

/** Checkable message options, listed in the header's options menu. */
export interface ComposerMessageOptions {
  importance: "" | "high" | "low";
  onImportanceChange: (value: "" | "high" | "low") => void;
  requestReceipt: boolean;
  onRequestReceiptChange: (value: boolean) => void;
  /** Present only when the account has a signature. */
  signature?: { included: boolean; onChange: (value: boolean) => void };
}

export interface ComposerHeaderProps {
  dragHandlers?: HTMLAttributes<HTMLElement>;
  seed: ComposerSeed | undefined;
  saveState: "unsaved" | "saving" | "saved";
  savedAt?: string;
  maximized: boolean;
  sending: boolean;
  draftSyncState: DraftSummary["syncState"] | undefined;
  draftSyncDetail?: string | null;
  bodyFormat: BodyFormat;
  onToggleBodyFormat: () => void;
  hideFormat?: boolean;
  messageOptions?: ComposerMessageOptions;
  setMinimized: Dispatch<SetStateAction<boolean>>;
  setMaximized: Dispatch<SetStateAction<boolean>>;
  requestClose: () => void | Promise<void>;
}

export function ComposerHeader({
  dragHandlers = {},
  seed,
  saveState,
  savedAt,
  maximized,
  sending,
  draftSyncState,
  draftSyncDetail,
  bodyFormat,
  onToggleBodyFormat,
  hideFormat = false,
  messageOptions,
  setMinimized,
  setMaximized,
  requestClose,
}: ComposerHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current
      ?.querySelector<HTMLElement>(
        '[role="menuitem"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled])',
      )
      ?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !menuButtonRef.current?.contains(target)
      )
        setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  function closeMenu() {
    setMenuOpen(false);
    menuButtonRef.current?.focus();
  }

  const plain = bodyFormat === "plain";
  return (
    <>
      {/* Floating: drag moves the composer. Maximized: the app window. */}
      <header
        data-tauri-drag-region={maximized ? "deep" : undefined}
        title={
          dragHandlers.onPointerDown ? strings.composer.moveHint : undefined
        }
        {...dragHandlers}
      >
        <span>
          <h1 id="composer-title">{composerTitle(seed)}</h1>
          <small aria-live="polite">
            {saveState === "saving"
              ? strings.common.saving
              : saveState === "saved"
                ? savedAt
                  ? strings.composer.draftSavedAt(formatMessageDate(savedAt))
                  : strings.composer.draftSaved
                : ""}
          </small>
        </span>
        <div className="composer-window-controls">
          {hideFormat ? null : (
            <button
              className="icon-button"
              type="button"
              ref={menuButtonRef}
              onClick={() => setMenuOpen((open) => !open)}
              disabled={sending}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={strings.composer.messageOptions}
              title={strings.composer.messageOptions}
            >
              <Ellipsis aria-hidden="true" />
            </button>
          )}
          <button
            className="icon-button"
            type="button"
            onClick={() => setMinimized(true)}
            disabled={sending}
            aria-label={strings.composer.minimize}
            title={strings.composer.minimize}
          >
            <Minus aria-hidden="true" />
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => setMaximized((v) => !v)}
            disabled={sending}
            aria-label={
              maximized ? strings.composer.restore : strings.composer.maximize
            }
            title={
              maximized ? strings.composer.restore : strings.composer.maximize
            }
          >
            {maximized ? (
              <Minimize2 aria-hidden="true" />
            ) : (
              <Maximize2 aria-hidden="true" />
            )}
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => void requestClose()}
            disabled={sending || saveState === "saving"}
            aria-label={strings.composer.saveClose}
            title={strings.composer.saveClose}
          >
            <X aria-hidden="true" />
          </button>
        </div>
        {menuOpen && !hideFormat && messageOptions ? (
          <div
            className="composer-options-menu app-menu"
            ref={menuRef}
            role="menu"
            aria-label={strings.composer.messageOptions}
            onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
              if (event.key === "Escape" || event.key === "Tab") {
                event.preventDefault();
                event.stopPropagation();
                closeMenu();
                return;
              }
              moveMenuFocus(event);
            }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onToggleBodyFormat();
              }}
            >
              {plain ? (
                <Type aria-hidden="true" />
              ) : (
                <FileText aria-hidden="true" />
              )}
              {plain ? strings.composer.richText : strings.composer.plainText}
            </button>
            <div role="separator" />
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={messageOptions.importance === "high"}
              title={strings.composer.highImportanceHelp}
              onClick={() =>
                messageOptions.onImportanceChange(
                  messageOptions.importance === "high" ? "" : "high",
                )
              }
            >
              <ArrowUp aria-hidden="true" />
              {strings.composer.highImportance}
            </button>
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={messageOptions.importance === "low"}
              title={strings.composer.lowImportanceHelp}
              onClick={() =>
                messageOptions.onImportanceChange(
                  messageOptions.importance === "low" ? "" : "low",
                )
              }
            >
              <ArrowDown aria-hidden="true" />
              {strings.composer.lowImportance}
            </button>
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={messageOptions.requestReceipt}
              title={strings.composer.requestReceiptHelp}
              onClick={() =>
                messageOptions.onRequestReceiptChange(
                  !messageOptions.requestReceipt,
                )
              }
            >
              <CheckCheck aria-hidden="true" />
              {strings.composer.requestReceipt}
            </button>
            {messageOptions.signature ? (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={messageOptions.signature.included}
                onClick={() =>
                  messageOptions.signature?.onChange(
                    !messageOptions.signature.included,
                  )
                }
              >
                <PenLine aria-hidden="true" />
                {strings.composer.includeSignature}
              </button>
            ) : null}
          </div>
        ) : null}
      </header>
      {draftSyncState === "localOnly" || draftSyncState === "conflict" ? (
        <div
          className={`draft-sync-banner ${draftSyncState}`}
          role={draftSyncState === "conflict" ? "alert" : "status"}
        >
          <TriangleAlert aria-hidden="true" />
          <span>
            <strong>
              {draftSyncState === "conflict"
                ? strings.composer.recoveredTitle
                : strings.composer.localTitle}
            </strong>
            <small>
              {draftSyncDetail ??
                (draftSyncState === "conflict"
                  ? strings.composer.recoveredDetail
                  : strings.composer.localDetail)}
            </small>
          </span>
        </div>
      ) : null}
    </>
  );
}
