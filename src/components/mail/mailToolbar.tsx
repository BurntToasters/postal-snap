import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { MailPlus, PanelLeft, RefreshCw, Search, Settings } from "lucide-react";
import {
  CONTEXT_ACTION_EVENT,
  type ContextMenuActionDetail,
} from "../../contextMenu";
import { strings } from "../../i18n";
import { moveMenuFocus } from "../toolbarNav";
import { GetMailMenu } from "./getMailMenu";
import { SearchTips } from "./searchTips";

type LocalView = "drafts" | "outbox" | "snoozed";

// Fit steps: the Update badge shortens (1, 2) and then shows only its dot
// (3); Get Mail (4) and Compose (5) drop their labels only if the bar would
// still clip. Clipping corrupts the toolbar; accessible names stay intact.
const FIT_STEPS = 5;
const BADGE_STEPS = 3;

function fitToolbar(toolbar: HTMLElement) {
  toolbar.removeAttribute("data-fit-tips");
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
  // Below this search is too narrow to type in (wider fonts, e.g. Linux),
  // so Get Mail and Compose drop labels even without clipping.
  const searchUnusable = () =>
    search !== null && search.clientWidth < rem * 3.75;
  // The tips button gives its width back before anything else shrinks.
  if (searchCramped()) toolbar.setAttribute("data-fit-tips", "");
  for (let step = 1; step <= FIT_STEPS; step += 1) {
    const badgeStep = step <= BADGE_STEPS;
    if (badgeStep && !hasBadge) continue;
    const needed =
      clipped() || (badgeStep ? searchCramped() : searchUnusable());
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
  recentSearches: string[];
  activeLocalView?: LocalView;
  allFolders: boolean;
  onSubmit: () => void;
  onQueryChange: (value: string) => void;
  onPickRecent: (query: string) => void;
  onForgetRecent: (query: string) => void;
  onClearRecent: () => void;
  onToggleScope: () => void;
}

export function SearchBox({
  inputRef,
  query,
  recentSearches,
  activeLocalView,
  allFolders,
  onSubmit,
  onQueryChange,
  onPickRecent,
  onForgetRecent,
  onClearRecent,
  onToggleScope,
}: SearchBoxProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const showRecent = open && query.trim() === "" && recentSearches.length > 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    setOpen(false);
    onSubmit();
  }

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (showRecent) {
        setOpen(false);
        return;
      }
      if (query.trim()) {
        onQueryChange("");
        return;
      }
      inputRef.current?.blur();
      return;
    }
    if (!showRecent) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = document
      .getElementById(menuId)
      ?.querySelectorAll<HTMLButtonElement>("[role='menuitem']");
    if (!items?.length) return;
    items[event.key === "ArrowDown" ? 0 : items.length - 1].focus();
  }

  // Forgets one entry and moves focus to a neighbor, or the field if last.
  function forgetRecent(recent: string) {
    const items = [
      ...(document
        .getElementById(menuId)
        ?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? []),
    ];
    const at = items.findIndex((node) => node.dataset.recent === recent);
    const next =
      items[at + 1]?.dataset.recent !== undefined
        ? items[at + 1]
        : items.find(
            (node, i) => i !== at && node.dataset.recent !== undefined,
          );
    onForgetRecent(recent);
    if (next) next.focus();
    else inputRef.current?.focus();
  }

  // One forget listener for the SearchBox's life; forgetRecent stays fresh here.
  const forgetRecentRef = useRef(forgetRecent);
  useEffect(() => {
    forgetRecentRef.current = forgetRecent;
  });

  useEffect(() => {
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent<ContextMenuActionDetail>).detail;
      if (
        detail?.id === "forget-recent-search" &&
        detail.target?.kind === "recent-search"
      ) {
        forgetRecentRef.current(detail.target.query);
      }
    };
    window.addEventListener(CONTEXT_ACTION_EVENT, onAction);
    return () => window.removeEventListener(CONTEXT_ACTION_EVENT, onAction);
  }, []);

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      inputRef.current?.focus();
      setOpen(false);
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      const recent = (event.target as HTMLElement).dataset.recent;
      if (recent === undefined) return;
      event.preventDefault();
      forgetRecent(recent);
      return;
    }
    moveMenuFocus(event);
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
        onFocus={() => setOpen(true)}
        onKeyDown={onSearchKeyDown}
        placeholder={
          activeLocalView ? strings.mail.searchMailboxOnly : strings.mail.search
        }
        aria-label={strings.mail.search}
        aria-keyshortcuts="Meta+F Control+F /"
        aria-controls={showRecent ? menuId : undefined}
      />
      {showRecent ? (
        <div
          id={menuId}
          className="search-recent app-menu"
          role="menu"
          aria-label={strings.mail.recentSearches}
          onMouseDown={(event) => event.preventDefault()}
          onKeyDown={onMenuKeyDown}
        >
          <div className="context-menu-heading">
            {strings.mail.recentSearches}
          </div>
          {recentSearches.map((recent) => (
            <button
              key={recent}
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-recent={recent}
              data-context="recent-search"
              title={strings.mail.forgetRecentHint}
              onClick={() => {
                setOpen(false);
                onPickRecent(recent);
              }}
            >
              {recent}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              setOpen(false);
              onClearRecent();
            }}
          >
            {strings.mail.clearRecentSearches}
          </button>
        </div>
      ) : null}
      <SearchTips />
      {!activeLocalView ? (
        <button
          className="search-scope"
          type="button"
          aria-pressed={allFolders}
          title={strings.mail.searchAllFoldersTitle}
          onClick={onToggleScope}
        >
          {strings.mail.searchAllFolders}
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
  accountCount: number;
  syncingAll: boolean;
  onRefreshAll: () => void;
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
  accountCount,
  syncingAll,
  onRefreshAll,
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
          title={
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
          <RefreshCw
            aria-hidden="true"
            className={busy || syncingAll ? "spinning" : ""}
          />
          <span>{strings.mail.getMail}</span>
        </button>
        {accountCount > 1 ? (
          <GetMailMenu
            busy={busy}
            syncingAll={syncingAll}
            onRefreshAll={onRefreshAll}
          />
        ) : null}
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
