import type { Dispatch, SetStateAction } from "react";
import { Maximize2, Minimize2, Minus, TriangleAlert, X } from "lucide-react";
import { strings } from "../../i18n";
import type { ComposerSeed } from "../../store";
import type { DraftSummary } from "../../types";
import { composerTitle } from "./composerSeed";

export interface ComposerHeaderProps {
  seed: ComposerSeed | undefined;
  saveState: "unsaved" | "saving" | "saved";
  maximized: boolean;
  sending: boolean;
  draftSyncState: DraftSummary["syncState"] | undefined;
  draftSyncDetail?: string | null;
  setMinimized: Dispatch<SetStateAction<boolean>>;
  setMaximized: Dispatch<SetStateAction<boolean>>;
  requestClose: () => void | Promise<void>;
}

export function ComposerHeader({
  seed,
  saveState,
  maximized,
  sending,
  draftSyncState,
  draftSyncDetail,
  setMinimized,
  setMaximized,
  requestClose,
}: ComposerHeaderProps) {
  return (
    <>
      <header data-tauri-drag-region="deep">
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
      </header>
      {draftSyncState && draftSyncState !== "synced" ? (
        <div
          className={`draft-sync-banner ${draftSyncState}`}
          role={draftSyncState === "conflict" ? "alert" : "status"}
        >
          <TriangleAlert aria-hidden="true" />
          <span>
            <strong>
              {draftSyncState === "conflict"
                ? strings.composer.recoveredTitle
                : draftSyncState === "localOnly"
                  ? strings.composer.localTitle
                  : strings.composer.syncingTitle}
            </strong>
            <small>
              {draftSyncDetail ??
                (draftSyncState === "conflict"
                  ? strings.composer.recoveredDetail
                  : draftSyncState === "localOnly"
                    ? strings.composer.localDetail
                    : strings.composer.syncingDetail)}
            </small>
          </span>
        </div>
      ) : null}
    </>
  );
}
