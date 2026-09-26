import { useLayoutEffect, type FormEvent, type RefObject } from "react";
import { MailPlus, PanelLeft, RefreshCw, Search, Settings } from "lucide-react";
import { strings } from "../../i18n";

type LocalView = "drafts" | "outbox" | "snoozed";

// Fit steps: the Update badge shortens (1, 2) and then shows only its dot
// (3); Get Mail (4) and Compose (5) drop their labels only if the bar would
// still clip. Clipping corrupts the toolbar; accessible names stay intact.
const FIT_STEPS = 5;
const BADGE_STEPS = 3;

function fitToolbar(toolbar: HTMLElement) {
  for (let step = 1; step <= FIT_STEPS; step += 1) {
    toolbar.removeAttribute(`data-fit${step}`);
  }
  const trailing = toolbar.querySelector<HTMLElement>(".toolbar-trailing");
  // The narrow layout stacks rows instead (display: contents).
  if (!trailing || getComputedStyle(trailing).display === "contents") return;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const search = trailing.querySelector<HTMLElement>(".search-box > input");
  const hasBadge = trailing.querySelector(".update-ready-badge") !== null;
  // Flex-end overflow spills left, which scrollWidth does not report.
  const clipped = () => {
    const first = trailing.firstElementChild;
    return (
      first !== null &&
      first.getBoundingClientRect().left <
        trailing.getBoundingClientRect().left - 1
    );
  };
  const searchCramped = () => search !== null && search.clientWidth < rem * 5;
  for (let step = 1; step <= FIT_STEPS; step += 1) {
    const badgeStep = step <= BADGE_STEPS;
    if (badgeStep && !hasBadge) continue;
    const needed = clipped() || (badgeStep && searchCramped());
    if (!needed) break;
    toolbar.setAttribute(`data-fit${step}`, "");
  }
}

function useToolbarFit(
  toolbarRef: RefObject<HTMLElement | null>,
  updateReady: string | null,
) {
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    fitToolbar(toolbar);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fitToolbar(toolbar));
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [toolbarRef, updateReady]);
}

interface SearchBoxProps {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  activeLocalView?: LocalView;
  allFolders: boolean;
  onSubmit: () => void;
  onQueryChange: (value: string) => void;
  onToggleScope: () => void;
}

export function SearchBox({
  inputRef,
  query,
  activeLocalView,
  allFolders,
  onSubmit,
  onQueryChange,
  onToggleScope,
}: SearchBoxProps) {
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <form
      className="search-box"
      data-tauri-drag-region="false"
      role="search"
      onSubmit={submit}
    >
      <Search aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder={
          activeLocalView ? strings.mail.searchMailboxOnly : strings.mail.search
        }
        aria-label={strings.mail.search}
        aria-keyshortcuts="Meta+F Control+F /"
        disabled={Boolean(
          activeLocalView &&
          activeLocalView !== "drafts" &&
          activeLocalView !== "outbox",
        )}
      />
      {!activeLocalView ? (
        <button
          className="search-scope"
          type="button"
          aria-pressed={allFolders}
          title={
            allFolders ? strings.mail.thisAccount : strings.mail.thisMailbox
          }
          onClick={onToggleScope}
        >
          {allFolders ? strings.mail.thisAccount : strings.mail.thisMailbox}
        </button>
      ) : null}
    </form>
  );
}

interface MailToolbarProps extends SearchBoxProps {
  toolbarRef: RefObject<HTMLElement | null>;
  sidebarToggleRef: RefObject<HTMLButtonElement | null>;
  sidebarDrawerViewport: boolean;
  sidebarOpen: boolean;
  sidebarVisible: boolean;
  busy: boolean;
  updateReady: string | null;
  onToggleSidebar: () => void;
  onRefresh: () => void;
  onCompose: () => void;
  onApplyUpdate: () => void;
  onOpenSettings: () => void;
}

export function MailToolbar({
  toolbarRef,
  sidebarToggleRef,
  sidebarDrawerViewport,
  sidebarOpen,
  sidebarVisible,
  busy,
  updateReady,
  onToggleSidebar,
  onRefresh,
  onCompose,
  onApplyUpdate,
  onOpenSettings,
  ...searchProps
}: MailToolbarProps) {
  const sidebarExpanded = sidebarDrawerViewport ? sidebarOpen : sidebarVisible;
  useToolbarFit(toolbarRef, updateReady);
  return (
    <header
      ref={toolbarRef}
      className="app-toolbar"
      data-tauri-drag-region="deep"
      data-context="chrome"
    >
      <div className="toolbar-cluster toolbar-leading">
        <button
          ref={sidebarToggleRef}
          className="icon-button sidebar-toggle"
          type="button"
          onClick={onToggleSidebar}
          aria-label={
            sidebarExpanded
              ? strings.mail.hideMailboxes
              : strings.mail.showMailboxes
          }
          aria-expanded={sidebarExpanded}
          aria-controls="folder-pane"
        >
          <PanelLeft aria-hidden="true" />
        </button>
        <button
          className="toolbar-button get-mail-button"
          type="button"
          aria-keyshortcuts="F5 Meta+Shift+M Meta+Shift+N Control+Shift+M Control+Shift+N"
          onClick={onRefresh}
          disabled={busy}
          aria-label={strings.mail.getMail}
          title={strings.mail.getMail}
        >
          <RefreshCw aria-hidden="true" className={busy ? "spinning" : ""} />
          <span>{strings.mail.getMail}</span>
        </button>
      </div>
      <span className="toolbar-flex-spacer" aria-hidden="true" />
      <div className="toolbar-trailing">
        <button
          className="primary-button compose-button"
          type="button"
          aria-keyshortcuts="Meta+N Control+N"
          onClick={onCompose}
          aria-label={strings.mail.compose}
          title={strings.mail.compose}
        >
          <MailPlus aria-hidden="true" />
          <span>{strings.mail.compose}</span>
        </button>
        <SearchBox {...searchProps} />
        {updateReady ? (
          <button
            type="button"
            className="update-ready-badge"
            onClick={onApplyUpdate}
            title={strings.mail.updateReadyTooltip(updateReady)}
            aria-label={strings.mail.updateReadyBadge}
          >
            <span className="badge-dot" aria-hidden="true" />
            <span className="badge-label-long">
              {strings.mail.updateReadyBadge}
            </span>
            <span className="badge-label-short" aria-hidden="true">
              {strings.mail.updateReadyBadgeShort}
            </span>
            <span className="badge-label-tiny" aria-hidden="true">
              {strings.mail.updateReadyBadgeTiny}
            </span>
          </button>
        ) : null}
        <button
          className="icon-button settings-button"
          type="button"
          onClick={onOpenSettings}
          aria-label={strings.mail.settings}
          title={strings.mail.settings}
        >
          <Settings aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
