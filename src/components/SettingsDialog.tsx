import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  Bell,
  Database,
  CloudDownload,
  Eye,
  Info,
  Keyboard,
  Monitor,
  Palette,
  ShieldAlert,
  UserRound,
  X,
} from "lucide-react";
import { api } from "../api";
import { strings } from "../i18n";
import { useAppStore } from "../store";
import { useDialogFocus } from "./useDialogFocus";
import type { SettingsTab } from "./settings/primitives";
import { useSettingsSave } from "./settings/useSettingsSave";
import { settingsSearchEntries } from "./settings/settingsSearch";
import { AppearanceTab } from "./settings/appearanceTab";
import { GeneralTab } from "./settings/generalTab";
import { ReadingTab } from "./settings/readingTab";
import { NotificationsTab } from "./settings/notificationsTab";
import { StorageTab } from "./settings/storageTab";
import { AccountsTab } from "./settings/accountsTab";
import { ShortcutsTab } from "./settings/shortcutsTab";
import { UpdatesTab } from "./settings/updatesTab";
import { AdvancedTab } from "./settings/advancedTab";
import { AboutTab } from "./settings/aboutTab";
import { useSettingsAccountManagement } from "./settings/useSettingsAccountManagement";
import { useSettingsCapabilities } from "./settings/useSettingsCapabilities";
import { useSettingsFilterRules } from "./settings/useSettingsFilterRules";
import type { RuleSeed } from "./settings/useSettingsFilterRules";
import { useSettingsStorage } from "./settings/useSettingsStorage";
import { useSettingsThreatProtection } from "./settings/useSettingsThreatProtection";
import { useSettingsUpdates } from "./settings/useSettingsUpdates";

export type { SettingsTab } from "./settings/primitives";
export type { RuleSeed } from "./settings/useSettingsFilterRules";

interface Props {
  onClose: () => void;
  initialTab?: SettingsTab;
  initialAccountId?: string;
  initialRuleSeed?: RuleSeed;
  onLastAccountRemoved?: () => void;
}

const tabs: Array<{
  id: SettingsTab;
  label: string;
  icon: typeof Monitor;
}> = [
  { id: "general", label: strings.settings.general, icon: Monitor },
  { id: "appearance", label: strings.settings.appearanceTitle, icon: Palette },
  { id: "reading", label: strings.settings.reading, icon: Eye },
  { id: "notifications", label: strings.settings.notifications, icon: Bell },
  { id: "storage", label: strings.settings.storage, icon: Database },
  { id: "accounts", label: strings.settings.accounts, icon: UserRound },
  { id: "shortcuts", label: strings.settings.shortcuts, icon: Keyboard },
  { id: "updates", label: strings.settings.updates, icon: CloudDownload },
  { id: "advanced", label: strings.settings.advanced, icon: ShieldAlert },
  { id: "about", label: strings.settings.about, icon: Info },
];

// Arrow step in whole pixels; matches the native line step.
const KEYBOARD_SCROLL_STEP = 40;

function nearestScroller(
  start: HTMLElement | null,
  boundary: HTMLElement,
): HTMLElement | undefined {
  for (
    let node = start;
    node && boundary.contains(node);
    node = node.parentElement
  ) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
  }
  return undefined;
}

// WebKit can drop the first native arrow press after focus moves in.
// Only the region handles arrows; controls keep their native keys.
function scrollRegionWithArrows(event: KeyboardEvent<HTMLDivElement>) {
  const region = event.currentTarget;
  const direction =
    event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
  if (!direction || event.target !== region || event.defaultPrevented) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const dialog = region.closest<HTMLElement>(".settings-window");
  const scroller = dialog ? nearestScroller(region, dialog) : undefined;
  if (!scroller) return;
  event.preventDefault();
  scroller.scrollTop += direction * KEYBOARD_SCROLL_STEP;
}

function revealFocusedSettingsRow(target: HTMLElement, content: HTMLElement) {
  const row = target.closest<HTMLElement>(".settings-row, .switch-row");
  const dialog = content.closest<HTMLElement>(".settings-window");
  if (!row || !dialog || !content.contains(row)) return;

  const scroller = nearestScroller(row.parentElement, dialog);
  if (!scroller) return;

  const viewport = scroller.getBoundingClientRect();
  const rowBounds = row.getBoundingClientRect();
  if (rowBounds.height > scroller.clientHeight) return;

  // clientHeight is rounded; take the bottom edge from the exact box.
  const bottomInset =
    scroller.offsetHeight - scroller.clientTop - scroller.clientHeight;
  const visibleTop = viewport.top + scroller.clientTop;
  const visibleBottom = viewport.bottom - bottomInset;
  // WebKit keeps whole-pixel scroll offsets; round moves up.
  if (rowBounds.top < visibleTop) {
    scroller.scrollTop -= Math.ceil(visibleTop - rowBounds.top);
  } else if (rowBounds.bottom > visibleBottom) {
    scroller.scrollTop += Math.ceil(rowBounds.bottom - visibleBottom);
  }
}

export function SettingsDialog({
  onClose,
  initialTab = "general",
  initialAccountId,
  initialRuleSeed,
  onLastAccountRemoved,
}: Props) {
  const accounts = useAppStore((state) => state.accounts);
  const settings = useAppStore((state) => state.settings);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [query, setQuery] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState(initialAccountId);
  const [requestedAccountPage, setRequestedAccountPage] = useState<
    "connection" | "folders" | "identity" | "rules"
  >(initialRuleSeed ? "rules" : "connection");
  const [connectionDirty, setConnectionDirty] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [searchTarget, setSearchTarget] = useState<string>();
  const discardBusy = useRef(false);
  const accountFocusRequest = useRef<
    { action: "detail" | "list"; accountId: string } | undefined
  >(undefined);
  const { saving, update } = useSettingsSave((cause) =>
    setSaveError(String(cause)),
  );
  const [horizontalTabs, setHorizontalTabs] = useState(() =>
    typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 760px)").matches
      : false,
  );
  const settingsContentRef = useRef<HTMLDivElement>(null);
  const accountSettings = useSettingsAccountManagement({
    onClose,
    onLastAccountRemoved,
    update,
  });
  const ruleSettings = useSettingsFilterRules({
    enabled: tab === "accounts",
    initialRuleSeed,
  });
  const storageSettings = useSettingsStorage();
  const { distribution, windowFxSupported } = useSettingsCapabilities();
  const { updateStatus, checkingUpdate, checkForUpdates } = useSettingsUpdates({
    distribution,
  });
  const threatSettings = useSettingsThreatProtection({ update });
  const {
    testingAccountId,
    testedHealthy,
    testAccount,
    removeAccount,
    passwordInputs,
    setPasswordInputs,
    passwordStatus,
    updatingPasswordId,
    handleUpdatePassword,
    nameInputs,
    setNameInputs,
    nameStatus,
    savingNameId,
    handleSaveName,
    replyToInputs,
    setReplyToInputs,
    replyToStatus,
    savingReplyToId,
    handleSaveReplyTo,
    signatureInputs,
    setSignatureInputs,
    signatureHtmlInputs,
    setSignatureHtmlInputs,
    signatureStatus,
    savingSignatureId,
    handleSaveSignature,
    detectingAliasesAccountId,
    handleDetectAliases,
    aliasStatus,
    newAliasInputs,
    setNewAliasInputs,
    handleAddAlias,
    handleRemoveAlias,
  } = accountSettings;
  const {
    accountMailboxes,
    filterRules,
    ruleInput,
    ruleStatus,
    setRuleField,
    handleAddRule,
    handlePreviewRule,
    handleMoveRule,
    handleToggleRule,
    handleDeleteRule,
  } = ruleSettings;
  const {
    usage,
    dataBusy,
    dataStatus,
    eraseBusy,
    eraseStatus,
    clearCache,
    retryAttachmentCleanup,
    exportSettings,
    importSettings,
    eraseAllData,
  } = storageSettings;
  const {
    confirmThreatOff,
    confirmToken,
    setConfirmToken,
    confirmInputRef,
    threatSwitchRef,
    cancelThreatOff,
    setAdvertisingBlocking,
    setThreatBlocking,
    confirmDisableThreats,
  } = threatSettings;
  const hasDirtyForms =
    connectionDirty ||
    accountSettings.hasDirtyForms ||
    ruleSettings.hasDirtyForms;
  const discardAccountForms = accountSettings.discardUnsavedForms;
  const discardRuleForms = ruleSettings.discardUnsavedForms;
  const confirmDiscard = useCallback(async () => {
    if (!hasDirtyForms) return true;
    if (discardBusy.current) return false;
    discardBusy.current = true;
    try {
      if (
        !(await api.showNativeConfirm(
          strings.settings.discardTitle,
          strings.settings.discardHelp,
        ))
      )
        return false;
      discardAccountForms();
      discardRuleForms();
      setConnectionDirty(false);
      return true;
    } catch (cause) {
      setSaveError(String(cause));
      return false;
    } finally {
      discardBusy.current = false;
    }
  }, [discardAccountForms, hasDirtyForms, discardRuleForms]);
  const openAccountOutbox = useCallback(
    async (accountId: string) => {
      if (!(await confirmDiscard())) return;
      const state = useAppStore.getState();
      state.selectAccount(accountId);
      state.selectLocalView("outbox");
      onClose();
    },
    [confirmDiscard, onClose],
  );
  const requestClose = useCallback(() => {
    if (confirmThreatOff) {
      cancelThreatOff();
      return;
    }
    void confirmDiscard()
      .then((leave) => {
        if (leave) onClose();
      })
      .catch((cause) => setSaveError(String(cause)));
  }, [cancelThreatOff, confirmThreatOff, confirmDiscard, onClose]);
  const dialogRef = useDialogFocus(requestClose);
  async function changeTab(next: SettingsTab) {
    if (next === tab) return true;
    if (await confirmDiscard()) {
      setTab(next);
      setSaveError("");
      return true;
    }
    return false;
  }
  async function updateSearch(value: string) {
    if (query || !value.trim() || (await confirmDiscard())) setQuery(value);
  }
  const platform = document.documentElement.dataset.platform;
  const results = settingsSearchEntries
    .filter(
      (entry) =>
        (!entry.accountPage || accounts.length > 0) &&
        (!entry.provider ||
          accounts.some((account) => account.provider === entry.provider)) &&
        (!entry.directUpdates ||
          distribution?.updatesManagedBy === "postalSnap") &&
        (entry.title !== strings.settings.cacheDays ||
          settings.cachePolicy.mode === "recent") &&
        (entry.title !== strings.settings.windowEffects || windowFxSupported) &&
        (entry.title !== strings.settings.closeToTrayWindows ||
          platform === "windows" ||
          platform === "macos"),
    )
    .map((entry) =>
      entry.title === strings.settings.closeToTrayWindows &&
      platform === "macos"
        ? {
            ...entry,
            title: strings.settings.closeToTrayMac,
            help: strings.settings.closeToTrayMacHelp,
          }
        : entry,
    )
    .filter((entry) =>
      query
        .trim()
        .toLocaleLowerCase()
        .split(/\s+/)
        .every((term) =>
          `${entry.title} ${entry.help} ${entry.keywords}`
            .toLocaleLowerCase()
            .includes(term),
        ),
    );
  const settingsContentLabel = query.trim()
    ? strings.settings.search
    : (tabs.find((item) => item.id === tab)?.label ??
      strings.settings.sections);
  async function openSearchResult(
    entry: (typeof settingsSearchEntries)[number],
  ) {
    if (!(await confirmDiscard())) return;
    setQuery("");
    setTab(entry.section);
    if (entry.accountPage) {
      setSelectedAccountId(
        accounts.find(
          (account) =>
            account.id === useAppStore.getState().activeAccountId &&
            (!entry.provider || account.provider === entry.provider),
        )?.id ??
          accounts.find(
            (account) => !entry.provider || account.provider === entry.provider,
          )?.id,
      );
      setRequestedAccountPage(entry.accountPage);
    }
    setSearchTarget(entry.title);
  }
  useEffect(() => {
    if (!searchTarget || query) return;
    let frame = 0;
    const deadline = performance.now() + 5000;
    function focusResult() {
      const controls =
        settingsContentRef.current?.querySelectorAll<HTMLElement>(
          "label,button,input,select,textarea,h2,h3,strong",
        );
      const target = Array.from(controls ?? []).find(
        (element) =>
          element.getAttribute("aria-label") === searchTarget ||
          element.textContent?.trim() === searchTarget ||
          element.querySelector("strong")?.textContent?.trim() === searchTarget,
      );
      if (!target && performance.now() < deadline) {
        frame = window.requestAnimationFrame(focusResult);
        return;
      }
      const labeledId = target?.getAttribute("for");
      const focus = target?.matches("input,select,textarea,button")
        ? target
        : (target?.querySelector<HTMLElement>("input,select,textarea,button") ??
          (labeledId ? document.getElementById(labeledId) : null) ??
          target
            ?.closest(".account-aliases-section")
            ?.querySelector<HTMLElement>("input,button") ??
          target);
      if (focus) {
        if (focus.matches("h2,h3,strong")) focus.tabIndex = -1;
        focus.scrollIntoView?.({ block: "nearest" });
        focus.focus();
      }
      setSearchTarget(undefined);
    }
    frame = window.requestAnimationFrame(focusResult);
    return () => window.cancelAnimationFrame(frame);
  }, [tab, query, searchTarget]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 760px)");
    const updateOrientation = () => setHorizontalTabs(media.matches);
    updateOrientation();
    media.addEventListener("change", updateOrientation);
    return () => media.removeEventListener("change", updateOrientation);
  }, []);

  useEffect(() => {
    if (settingsContentRef.current) settingsContentRef.current.scrollTop = 0;
  }, [tab]);

  useEffect(() => {
    const content = settingsContentRef.current;
    if (!content) return;
    const contentElement: HTMLDivElement = content;
    // Reveal synchronously so the row is final when focus returns.
    function revealRow(event: FocusEvent) {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest(".settings-row, .switch-row")
      ) {
        revealFocusedSettingsRow(target, contentElement);
      }
    }
    contentElement.addEventListener("focusin", revealRow);
    return () => contentElement.removeEventListener("focusin", revealRow);
  }, []);

  useEffect(() => {
    const request = accountFocusRequest.current;
    if (!request) return;
    if (
      tab !== "accounts" ||
      query.trim() ||
      searchTarget ||
      (request.action === "detail" &&
        selectedAccountId !== request.accountId) ||
      (request.action === "list" && selectedAccountId)
    ) {
      accountFocusRequest.current = undefined;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (accountFocusRequest.current !== request) return;
      const content = settingsContentRef.current;
      const target =
        request.action === "detail"
          ? content?.querySelector<HTMLElement>(
              ".account-detail-nav button.active",
            )
          : Array.from(
              content?.querySelectorAll<HTMLButtonElement>(
                ".account-overview-row",
              ) ?? [],
            ).find(
              (button) =>
                button.dataset.settingsAccountId === request.accountId,
            );
      accountFocusRequest.current = undefined;
      target?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [query, requestedAccountPage, searchTarget, selectedAccountId, tab]);

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const directionKeys = horizontalTabs
      ? ["ArrowLeft", "ArrowRight"]
      : ["ArrowUp", "ArrowDown"];
    if (![...directionKeys, "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (index +
              (event.key === "ArrowRight" || event.key === "ArrowDown"
                ? 1
                : -1) +
              tabs.length) %
            tabs.length;
    const next = tabs[nextIndex].id;
    void changeTab(next).then((changed) => {
      if (!changed) return;
      window.setTimeout(() => {
        const element = document.getElementById(`settings-tab-${next}`);
        element?.focus();
        element?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      }, 0);
    });
  }

  return (
    <div
      className="modal-layer settings-layer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
    >
      <button
        className="modal-backdrop"
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={requestClose}
      />
      <section className="settings-window" ref={dialogRef}>
        <header
          inert={confirmThreatOff || undefined}
          data-tauri-drag-region="deep"
        >
          <span>
            <h1 id="settings-title">{strings.settings.title}</h1>
            <small>
              {saving ? strings.settings.saving : strings.settings.autosave}
            </small>
          </span>
          <button
            className="icon-button"
            type="button"
            onClick={requestClose}
            aria-label={strings.settings.close}
            title={strings.settings.close}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        {saveError ? (
          <p className="settings-save-error" role="alert">
            {saveError}
          </p>
        ) : null}
        <div className="settings-layout" inert={confirmThreatOff || undefined}>
          <div className="settings-search">
            <input
              type="search"
              aria-label={strings.settings.search}
              placeholder={strings.settings.search}
              value={query}
              onChange={(event) => void updateSearch(event.target.value)}
            />
            {query ? (
              <button
                type="button"
                className="text-button"
                onClick={() => setQuery("")}
              >
                {strings.settings.clearSearch}
              </button>
            ) : null}
          </div>
          <label className="settings-section-select">
            <span>{strings.settings.sectionSelector}</span>
            <select
              aria-label={strings.settings.sectionSelector}
              value={tab}
              onChange={(event) =>
                void changeTab(event.target.value as SettingsTab)
              }
            >
              {tabs.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <nav
            className="settings-nav"
            aria-label={strings.settings.sections}
            role="tablist"
            aria-orientation={horizontalTabs ? "horizontal" : "vertical"}
          >
            {tabs.map(({ id, label, icon: Icon }, index) => (
              <button
                key={id}
                id={`settings-tab-${id}`}
                type="button"
                role="tab"
                aria-label={label}
                aria-selected={tab === id}
                aria-controls={!query.trim() ? `settings-${id}` : undefined}
                tabIndex={tab === id ? 0 : -1}
                className={tab === id ? "active" : ""}
                onClick={(event) => {
                  void changeTab(id);
                  event.currentTarget.scrollIntoView?.({
                    block: "nearest",
                    inline: "nearest",
                  });
                }}
                onKeyDown={(event) => moveTab(event, index)}
              >
                <Icon aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </nav>
          <div
            className="settings-content"
            ref={settingsContentRef}
            role="region"
            aria-label={settingsContentLabel}
            tabIndex={0}
            onKeyDown={scrollRegionWithArrows}
          >
            {query.trim() ? (
              <div className="settings-search-results">
                {results.length ? (
                  results.map((entry) => (
                    <button
                      className="settings-search-result"
                      type="button"
                      key={`${entry.section}-${entry.title}`}
                      onClick={() => void openSearchResult(entry)}
                    >
                      <strong>{entry.title}</strong>
                      <span>
                        {tabs.find((item) => item.id === entry.section)?.label}
                      </span>
                      <small>{entry.help}</small>
                    </button>
                  ))
                ) : (
                  <p role="status">{strings.settings.noResults}</p>
                )}
              </div>
            ) : (
              <>
                {tab === "appearance" ? (
                  <AppearanceTab
                    update={update}
                    windowFxSupported={windowFxSupported}
                  />
                ) : null}
                {tab === "general" ? (
                  <GeneralTab
                    update={update}
                    windowFxSupported={windowFxSupported}
                    dataBusy={dataBusy}
                    dataStatus={dataStatus}
                    setTab={setTab}
                    exportSettings={exportSettings}
                    importSettings={importSettings}
                  />
                ) : null}
                {tab === "reading" ? <ReadingTab update={update} /> : null}
                {tab === "notifications" ? (
                  <NotificationsTab update={update} />
                ) : null}
                {tab === "storage" ? (
                  <StorageTab
                    usage={usage}
                    update={update}
                    clearCache={clearCache}
                    retryAttachmentCleanup={retryAttachmentCleanup}
                  />
                ) : null}
                {tab === "accounts" ? (
                  <AccountsTab
                    key={`${selectedAccountId ?? "list"}-${requestedAccountPage}`}
                    selectedAccountId={selectedAccountId}
                    initialPage={requestedAccountPage}
                    onSelectAccount={(id) => {
                      if (id) {
                        accountFocusRequest.current = {
                          action: "detail",
                          accountId: id,
                        };
                      }
                      setSelectedAccountId(id);
                      setRequestedAccountPage("connection");
                    }}
                    onReturnToAccounts={(accountId) => {
                      accountFocusRequest.current = {
                        action: "list",
                        accountId,
                      };
                    }}
                    onOpenOutbox={(accountId) => {
                      void openAccountOutbox(accountId);
                    }}
                    beforeNavigate={confirmDiscard}
                    onConnectionDirty={setConnectionDirty}
                    onClose={onClose}
                    mailboxes={accountMailboxes}
                    testingAccountId={testingAccountId}
                    testedHealthy={testedHealthy}
                    testAccount={testAccount}
                    removeAccount={removeAccount}
                    passwordInputs={passwordInputs}
                    setPasswordInputs={setPasswordInputs}
                    passwordStatus={passwordStatus}
                    updatingPasswordId={updatingPasswordId}
                    handleUpdatePassword={handleUpdatePassword}
                    nameInputs={nameInputs}
                    setNameInputs={setNameInputs}
                    nameStatus={nameStatus}
                    savingNameId={savingNameId}
                    handleSaveName={handleSaveName}
                    replyToInputs={replyToInputs}
                    setReplyToInputs={setReplyToInputs}
                    replyToStatus={replyToStatus}
                    savingReplyToId={savingReplyToId}
                    handleSaveReplyTo={handleSaveReplyTo}
                    signatureInputs={signatureInputs}
                    setSignatureInputs={setSignatureInputs}
                    signatureHtmlInputs={signatureHtmlInputs}
                    setSignatureHtmlInputs={setSignatureHtmlInputs}
                    signatureStatus={signatureStatus}
                    savingSignatureId={savingSignatureId}
                    handleSaveSignature={handleSaveSignature}
                    filterRules={filterRules}
                    ruleInput={ruleInput}
                    setRuleField={setRuleField}
                    handleAddRule={handleAddRule}
                    handlePreviewRule={handlePreviewRule}
                    handleMoveRule={handleMoveRule}
                    handleToggleRule={handleToggleRule}
                    handleDeleteRule={handleDeleteRule}
                    ruleStatus={ruleStatus}
                    detectingAliasesAccountId={detectingAliasesAccountId}
                    handleDetectAliases={handleDetectAliases}
                    aliasStatus={aliasStatus}
                    newAliasInputs={newAliasInputs}
                    setNewAliasInputs={setNewAliasInputs}
                    handleAddAlias={handleAddAlias}
                    handleRemoveAlias={handleRemoveAlias}
                    eraseBusy={eraseBusy}
                    eraseStatus={eraseStatus}
                    eraseAllData={eraseAllData}
                  />
                ) : null}
                {tab === "shortcuts" ? <ShortcutsTab /> : null}
                {tab === "updates" ? (
                  <UpdatesTab
                    distribution={distribution}
                    updateStatus={updateStatus}
                    checkingUpdate={checkingUpdate}
                    checkForUpdates={checkForUpdates}
                    update={update}
                  />
                ) : null}
                {tab === "advanced" ? (
                  <AdvancedTab
                    distribution={distribution}
                    update={update}
                    setAdvertisingBlocking={setAdvertisingBlocking}
                    setThreatBlocking={setThreatBlocking}
                    threatSwitchRef={threatSwitchRef}
                  />
                ) : null}
                {tab === "about" ? <AboutTab /> : null}
              </>
            )}
          </div>
        </div>
        {confirmThreatOff ? (
          <div
            className="settings-confirm-overlay"
            onClick={(event) => {
              if (event.target === event.currentTarget) cancelThreatOff();
            }}
          >
            <form
              className="settings-confirm-card"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="settings-threat-off-title"
              aria-describedby="settings-threat-off-lead"
              onClick={(event) => event.stopPropagation()}
              onSubmit={(event) => {
                event.preventDefault();
                void confirmDisableThreats();
              }}
            >
              <h2 id="settings-threat-off-title">
                {strings.settings.threatDisableTitle}
              </h2>
              <p id="settings-threat-off-lead">
                {strings.settings.threatDisableLead}
              </p>
              <label className="settings-confirm-field">
                <span>{strings.settings.threatDisableHelp}</span>
                <input
                  ref={confirmInputRef}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={strings.settings.threatDisableInput}
                  value={confirmToken}
                  onChange={(event) => setConfirmToken(event.target.value)}
                />
              </label>
              <div className="settings-confirm-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={cancelThreatOff}
                >
                  {strings.settings.threatDisableCancel}
                </button>
                <button
                  className="danger-button"
                  type="submit"
                  disabled={
                    confirmToken !== strings.settings.threatDisableToken
                  }
                >
                  {strings.settings.threatDisableConfirm}
                </button>
              </div>
            </form>
          </div>
        ) : null}
      </section>
    </div>
  );
}
