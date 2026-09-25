import type { RefObject } from "react";
import {
  Clock,
  FileText,
  FolderPlus,
  Inbox,
  MailPlus,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { strings } from "../../i18n";
import type {
  AccountInboxCount,
  AccountSummary,
  MailboxRole,
  MailboxSummary,
  SyncState,
} from "../../types";
import { AccountSwitcher } from "./accountSwitcher";
import { FolderButton } from "./folderButton";
import { FolderTree } from "./folderTree";
import { SyncStatus } from "./syncStatus";

export type LocalFolderView = "drafts" | "outbox" | "snoozed";

export interface SidebarProps {
  folderPaneRef: RefObject<HTMLElement | null>;
  accounts: AccountSummary[];
  activeAccount: AccountSummary | undefined;
  accountCounts: AccountInboxCount[];
  syncByAccount: Record<string, SyncState>;
  activeSync: SyncState | undefined;
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
  activeMailboxId: number | undefined;
  folderIcons: Record<MailboxRole, typeof Inbox>;
  folderDialog:
    { mode: "create" } | { mode: "rename"; id: number; name: string } | null;
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
    dialog: { mode: "create" } | { mode: "rename"; id: number; name: string },
  ) => void;
  activeMailbox: MailboxSummary | undefined;
  onEmptyTrash: () => void;
  onEmptyJunk: () => void;
}

export function Sidebar({
  folderPaneRef,
  accounts,
  activeAccount,
  accountCounts,
  syncByAccount,
  activeSync,
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
        >
          <X />
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
          icon={TriangleAlert}
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
        <p className="sidebar-section-title">{strings.mail.mailboxes}</p>
        <FolderTree
          mailboxes={mailboxes}
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
            <Trash2 aria-hidden="true" /> {strings.mail.emptyTrash}
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
        onOpenSettings={onOpenSettings}
      />
    </aside>
  );
}
