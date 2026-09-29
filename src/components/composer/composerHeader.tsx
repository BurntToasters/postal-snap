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
  FileText,
  Maximize2,
  Minimize2,
  Minus,
  MoreHorizontal,
  TriangleAlert,
  Type,
  X,
} from "lucide-react";
import { strings } from "../../i18n";
import type { ComposerSeed } from "../../store";
import type { BodyFormat, DraftSummary } from "../../types";
import { moveMenuFocus } from "../toolbarNav";
import { composerTitle } from "./composerSeed";

export interface ComposerHeaderProps {
  dragHandlers?: HTMLAttributes<HTMLElement>;
  seed: ComposerSeed | undefined;
  saveState: "unsaved" | "saving" | "saved";
  maximized: boolean;
  sending: boolean;
  draftSyncState: DraftSummary["syncState"] | undefined;
  draftSyncDetail?: string | null;
  bodyFormat: BodyFormat;
  onToggleBodyFormat: () => void;
  setMinimized: Dispatch<SetStateAction<boolean>>;
  setMaximized: Dispatch<SetStateAction<boolean>>;
  requestClose: () => void | Promise<void>;
}

export function ComposerHeader({
  dragHandlers = {},
  seed,
  saveState,
  maximized,
  sending,
  draftSyncState,
  draftSyncDetail,
  bodyFormat,
  onToggleBodyFormat,
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
      ?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')
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
                ? strings.composer.draftSaved
                : ""}
          </small>
        </span>
        <div className="composer-window-controls">
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
            <MoreHorizontal />
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => setMinimized(true)}
            disabled={sending}
            aria-label={strings.composer.minimize}
            title={strings.composer.minimize}
          >
            <Minus />
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
            {maximized ? <Minimize2 /> : <Maximize2 />}
          </button>
          <button
            className="icon-button"
            type="button"
            onClick={() => void requestClose()}
            disabled={sending || saveState === "saving"}
            aria-label={strings.composer.saveClose}
            title={strings.composer.saveClose}
          >
            <X />
          </button>
        </div>
        {menuOpen ? (
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
