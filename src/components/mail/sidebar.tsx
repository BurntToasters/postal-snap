import type { RefObject } from "react";
import {
  ArrowUpFromLine,
  Clock,
  FileText,
  FolderPlus,
  Inbox,
  MailPlus,
  ShieldAlert,
  Trash,
  TriangleAlert,
  X,
} from "lucide-react";
import { strings } from "../../i18n";
import { folderLabel, folderPathLabel } from "../../i18n/mail";
import { mailboxIsPinned } from "../../pinnedMailboxes";
import { parentMailboxIds } from "./folderTreeModel";
import type {
  AccountInboxCount,
  AccountSummary,
  MailboxRole,
  MailboxSummary,
  PinnedMailbox,
  SyncProgress,
  SyncState,
} from "../../types";
import { AccountSwitcher } from "./accountSwitcher";
import { FolderButton } from "./folderButton";
import { FolderTree } from "./folderTree";
import { mailboxesForUnreadView } from "./folderTreeModel";
import { SyncStatus } from "./syncStatus";

export type LocalFolderView = "drafts" | "outbox" | "snoozed";

export interface SidebarProps {
  folderPaneRef: RefObject<HTMLElement | null>;
  accounts: AccountSummary[];
  activeAccount: AccountSummary | undefined;
  accountCounts: AccountInboxCount[];
  syncByAccount: Record<string, SyncState>;
  activeSync: SyncState | undefined;
  syncProgress?: SyncProgress;
  accountSwitcherOpen: boolean;
  syncingAllAccounts: boolean;
  onAccountSwitcherOpenChange: (open: boolean) => void;
  onSelectAccount: (id: string) => void;
  onRefreshAllAccounts: () => void;
  onAddAccount: () => void;
  onOpenSettings: (tab?: "accounts") => void;
  onCloseSidebar: () => void;
  activeLocalView: LocalFolderView | null | undefined;
  draftsCount: number;
  outboxCount: number;
  snoozedCount: number;
  onSelectLocalView: (view: LocalFolderView) => void;
  mailboxes: MailboxSummary[];
  pinnedMailboxes: PinnedMailbox[];
  hiddenMailboxes: PinnedMailbox[];
  collapsedMailboxIds: number[];
  onToggleCollapsed: (mailboxId: number, collapsed: boolean) => void;
  onCollapseFolders?: () => void;
  onExpandFolders?: () => void;
  unreadFoldersOnly: boolean;
  onUnreadFoldersOnlyChange: (unreadOnly: boolean) => void;
  activeMailboxId: number | undefined;
  folderIcons: Record<MailboxRole, typeof Inbox>;
  folderDialog:
    | { mode: "create"; parentId?: number; parentLabel?: string }
    | { mode: "rename"; id: number; name: string; parentLabel?: string }
    | null;
  folderName: string;
  folderBusy: boolean;
  newFolderButtonRef: RefObject<HTMLButtonElement | null>;
  onFolderClick: (mailbox: MailboxSummary) => void;
  onFolderRename: (mailbox: MailboxSummary) => void;
  onFolderDelete: (mailbox: MailboxSummary) => void;
  onFolderDialogKeyDown: (event: React.KeyboardEvent) => void;
  onFolderNameChange: (name: string) => void;
  onFolderDialogSubmit: () => void;
  onFolderDialogClose: () => void;
  onOpenFolderDialog: (
    dialog:
      | { mode: "create"; parentId?: number; parentLabel?: string }
      | { mode: "rename"; id: number; name: string; parentLabel?: string },
  ) => void;
  activeMailbox: MailboxSummary | undefined;
  onEmptyTrash: () => void;
  onEmptyJunk: () => void;
  onDropMessages?: (mailboxId: number, payload: string) => void;
}

export function Sidebar({
  folderPaneRef,
  accounts,
  activeAccount,
  accountCounts,
  syncByAccount,
  activeSync,
  syncProgress,
  accountSwitcherOpen,
  syncingAllAccounts,
  onAccountSwitcherOpenChange,
  onSelectAccount,
  onRefreshAllAccounts,
  onAddAccount,
  onOpenSettings,
  onCloseSidebar,
  activeLocalView,
  draftsCount,
  outboxCount,
  snoozedCount,
  onSelectLocalView,
  mailboxes,
  pinnedMailboxes,
  hiddenMailboxes,
  collapsedMailboxIds,
  onToggleCollapsed,
  onCollapseFolders,
  onExpandFolders,
  unreadFoldersOnly,
  onUnreadFoldersOnlyChange,
  activeMailboxId,
  folderIcons,
  folderDialog,
  folderName,
  folderBusy,
  newFolderButtonRef,
  onFolderClick,
  onFolderRename,
  onFolderDelete,
  onFolderDialogKeyDown,
  onFolderNameChange,
  onFolderDialogSubmit,
  onFolderDialogClose,
  onOpenFolderDialog,
  activeMailbox,
  onEmptyTrash,
  onEmptyJunk,
  onDropMessages,
}: SidebarProps) {
  return (
    <aside
      id="folder-pane"
      ref={folderPaneRef}
      className="folder-pane"
      aria-label={strings.mail.accountsAndMailboxes}
    >
      <div
        className="sidebar-titlebar-drag"
        data-tauri-drag-region
        aria-hidden="true"
      />
      <div className="sidebar-mobile-header">
        <strong>{strings.mail.mailboxes}</strong>
        <button
          type="button"
          className="icon-button"
          onClick={onCloseSidebar}
          aria-label={strings.mail.closeMailboxes}
          title={strings.mail.closeMailboxes}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <AccountSwitcher
        accounts={accounts}
        activeAccount={activeAccount}
        counts={accountCounts}
        sync={syncByAccount}
        open={accountSwitcherOpen}
        syncingAll={syncingAllAccounts}
        onOpenChange={onAccountSwitcherOpenChange}
        onSelect={onSelectAccount}
        onGetAll={onRefreshAllAccounts}
        onAdd={onAddAccount}
        onSettings={() => onOpenSettings("accounts")}
      />
      <button
        className="add-account-button"
        type="button"
        onClick={onAddAccount}
      >
        <MailPlus /> {strings.mail.addAccount}
      </button>
      <nav className="folder-list" aria-label={strings.mail.mailboxes}>
        <p className="sidebar-section-title">{strings.mail.localFolders}</p>
        <FolderButton
          icon={FileText}
          label={strings.mail.drafts}
          count={draftsCount}
          active={activeLocalView === "drafts"}
          tone="drafts"
          localView="drafts"
          onClick={() => onSelectLocalView("drafts")}
        />
        <FolderButton
          icon={outboxCount ? TriangleAlert : ArrowUpFromLine}
          label={strings.mail.outbox}
          count={outboxCount}
          active={activeLocalView === "outbox"}
          tone={outboxCount ? "warning" : undefined}
          localView="outbox"
          onClick={() => onSelectLocalView("outbox")}
        />
        <FolderButton
          icon={Clock}
          label={strings.mail.snoozed}
          count={snoozedCount}
          active={activeLocalView === "snoozed"}
          tone="archive"
          localView="snoozed"
          onClick={() => onSelectLocalView("snoozed")}
        />
        <PinnedFolders
          mailboxes={listedMailboxes(
            mailboxes,
            hiddenMailboxes,
            activeAccount?.id,
          )}
          pins={pinnedMailboxes}
          accountId={activeAccount?.id}
          activeMailboxId={activeLocalView ? undefined : activeMailboxId}
          folderIcons={folderIcons}
          onFolderClick={onFolderClick}
          onDropMessages={onDropMessages}
        />
        <div className="sidebar-section-heading">
          <p className="sidebar-section-title">{strings.mail.mailboxes}</p>
          <button
            type="button"
            className="unread-folders-toggle"
            aria-pressed={unreadFoldersOnly}
            onClick={() => onUnreadFoldersOnlyChange(!unreadFoldersOnly)}
          >
            {strings.mail.unreadFolders}
          </button>
        </div>
        <FolderTree
          mailboxes={mailboxesForUnreadView(
            listedMailboxes(mailboxes, hiddenMailboxes, activeAccount?.id),
            unreadFoldersOnly,
            activeLocalView ? undefined : activeMailboxId,
          )}
          activeMailboxId={activeMailboxId}
          folderIcons={folderIcons}
          folderDialog={folderDialog}
          folderName={folderName}
          folderBusy={folderBusy}
          onFolderClick={onFolderClick}
          onRename={onFolderRename}
          onDelete={onFolderDelete}
          onFolderDialogKeyDown={onFolderDialogKeyDown}
          onFolderNameChange={onFolderNameChange}
          onFolderDialogSubmit={onFolderDialogSubmit}
          onFolderDialogClose={onFolderDialogClose}
          onDropMessages={onDropMessages}
          collapsedMailboxIds={collapsedMailboxIds}
          onToggleCollapsed={onToggleCollapsed}
        />
        <FolderTreeActions
          mailboxes={mailboxes}
          collapsedMailboxIds={collapsedMailboxIds}
          onCollapseFolders={onCollapseFolders}
          onExpandFolders={onExpandFolders}
        />
        <HiddenFolders
          mailboxes={mailboxes}
          hidden={hiddenMailboxes}
          accountId={activeAccount?.id}
          activeMailboxId={activeLocalView ? undefined : activeMailboxId}
          folderIcons={folderIcons}
          onFolderClick={onFolderClick}
          onDropMessages={onDropMessages}
        />
        {folderDialog?.mode === "create" ? (
          <form
            className="folder-dialog"
            onKeyDown={onFolderDialogKeyDown}
            onSubmit={(event) => {
              event.preventDefault();
              onFolderDialogSubmit();
            }}
          >
            {folderDialog.parentLabel ? (
              <p className="folder-dialog-parent">
                {strings.mail.newFolderInside(folderDialog.parentLabel)}
              </p>
            ) : null}
            <label>
              <span className="visually-hidden">{strings.mail.folderName}</span>
              <input
                autoFocus
                value={folderName}
                maxLength={128}
                onChange={(event) => onFolderNameChange(event.target.value)}
                placeholder={strings.mail.folderName}
              />
            </label>
            <button
              type="submit"
              className="primary-button"
              disabled={folderBusy || !folderName.trim()}
            >
              {strings.mail.createFolder}
            </button>
            <button
              type="button"
              className="toolbar-button"
              onClick={onFolderDialogClose}
            >
              {strings.common.cancel}
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="add-account-button"
            ref={newFolderButtonRef}
            onClick={() => onOpenFolderDialog({ mode: "create" })}
          >
            <FolderPlus aria-hidden="true" /> {strings.mail.newFolder}
          </button>
        )}
        {!activeLocalView &&
        activeMailbox?.role === "trash" &&
        activeMailbox.totalCount > 0 ? (
          <button
            type="button"
            className="add-account-button"
            onClick={onEmptyTrash}
          >
            <Trash aria-hidden="true" /> {strings.mail.emptyTrash}
          </button>
        ) : null}
        {!activeLocalView &&
        activeMailbox?.role === "junk" &&
        activeMailbox.totalCount > 0 ? (
          <button
            type="button"
            className="add-account-button"
            onClick={onEmptyJunk}
          >
            <ShieldAlert aria-hidden="true" /> {strings.mail.emptyJunk}
          </button>
        ) : null}
      </nav>
      <SyncStatus
        account={activeAccount}
        sync={activeSync}
        progress={syncProgress}
        onOpenSettings={onOpenSettings}
      />
    </aside>
  );
}

function FolderTreeActions({
  mailboxes,
  collapsedMailboxIds,
  onCollapseFolders,
  onExpandFolders,
}: {
  mailboxes: MailboxSummary[];
  collapsedMailboxIds: number[];
  onCollapseFolders?: () => void;
  onExpandFolders?: () => void;
}) {
  const parents = parentMailboxIds(mailboxes);
  if (parents.length === 0 || !onCollapseFolders || !onExpandFolders)
    return null;
  const collapsed = parents.filter((id) => collapsedMailboxIds.includes(id));
  return (
    <div className="folder-tree-actions">
      {collapsed.length < parents.length ? (
        <button
          type="button"
          className="unread-folders-toggle"
          onClick={onCollapseFolders}
        >
          {strings.mail.collapseFolders}
        </button>
      ) : null}
      {collapsed.length > 0 ? (
        <button
          type="button"
          className="unread-folders-toggle"
          onClick={onExpandFolders}
        >
          {strings.mail.expandFolders}
        </button>
      ) : null}
    </div>
  );
}

function listedMailboxes(
  mailboxes: MailboxSummary[],
  hidden: PinnedMailbox[],
  accountId: string | undefined,
): MailboxSummary[] {
  return mailboxes.filter(
    (mailbox) =>
      mailbox.role === "inbox" ||
      !mailboxIsPinned(hidden, accountId, mailbox.id),
  );
}

function HiddenFolders({
  mailboxes,
  hidden,
  accountId,
  activeMailboxId,
  folderIcons,
  onFolderClick,
  onDropMessages,
}: {
  mailboxes: MailboxSummary[];
  hidden: PinnedMailbox[];
  accountId: string | undefined;
  activeMailboxId: number | undefined;
  folderIcons: Record<MailboxRole, typeof Inbox>;
  onFolderClick: (mailbox: MailboxSummary) => void;
  onDropMessages?: (mailboxId: number, payload: string) => void;
}) {
  if (!accountId) return null;
  const concealed = hidden.flatMap((entry) => {
    if (entry.accountId !== accountId) return [];
    const mailbox = mailboxes.find((box) => box.id === entry.mailboxId);
    if (!mailbox || mailbox.role === "inbox") return [];
    return [mailbox];
  });
  if (concealed.length === 0) return null;
  return (
    <div role="group" aria-label={strings.mail.hiddenFolders}>
      <p className="sidebar-section-title">{strings.mail.hiddenFolders}</p>
      {concealed.map((mailbox) => (
        <FolderButton
          key={mailbox.id}
          icon={folderIcons[mailbox.role]}
          label={folderLabel(mailbox)}
          pathLabel={folderPathLabel(mailbox)}
          count={mailbox.unreadCount}
          active={activeMailboxId === mailbox.id}
          mailboxId={mailbox.id}
          onClick={() => onFolderClick(mailbox)}
          onDropMessages={onDropMessages}
        />
      ))}
    </div>
  );
}

function PinnedFolders({
  mailboxes,
  pins,
  accountId,
  activeMailboxId,
  folderIcons,
  onFolderClick,
  onDropMessages,
}: {
  mailboxes: MailboxSummary[];
  pins: PinnedMailbox[];
  accountId: string | undefined;
  activeMailboxId: number | undefined;
  folderIcons: Record<MailboxRole, typeof Inbox>;
  onFolderClick: (mailbox: MailboxSummary) => void;
  onDropMessages?: (mailboxId: number, payload: string) => void;
}) {
  if (!accountId) return null;
  const pinned = pins.flatMap((pin) => {
    if (pin.accountId !== accountId) return [];
    const mailbox = mailboxes.find((box) => box.id === pin.mailboxId);
    return mailbox ? [mailbox] : [];
  });
  if (pinned.length === 0) return null;
  return (
    <div role="group" aria-label={strings.mail.pinnedFolders}>
      <p className="sidebar-section-title">{strings.mail.pinnedFolders}</p>
      {pinned.map((mailbox) => (
        <FolderButton
          key={mailbox.id}
          icon={folderIcons[mailbox.role]}
          label={folderLabel(mailbox)}
          pathLabel={folderPathLabel(mailbox)}
          count={mailbox.unreadCount}
          active={activeMailboxId === mailbox.id}
          mailboxId={mailbox.id}
          onClick={() => onFolderClick(mailbox)}
          onDropMessages={onDropMessages}
        />
      ))}
    </div>
  );
}
