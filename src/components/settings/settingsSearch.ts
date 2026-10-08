import { strings } from "../../i18n";
import type { SettingsTab } from "./primitives";

export interface SettingsSearchEntry {
  section: SettingsTab;
  title: string;
  help: string;
  keywords: string;
  accountPage?: "connection" | "folders" | "identity" | "rules";
}
const s = strings.settings;
export const settingsSearchEntries: SettingsSearchEntry[] = [
  {
    section: "general",
    title: s.closeToTrayWindows,
    help: s.closeToTrayWindowsHelp,
    keywords: "quit tray menu bar background",
  },
  {
    section: "general",
    title: s.exportSettings,
    help: s.settingsDataHelp,
    keywords: "backup preferences",
  },
  {
    section: "general",
    title: s.importSettings,
    help: s.settingsDataHelp,
    keywords: "restore preferences",
  },
  {
    section: "appearance",
    title: s.appearance,
    help: s.appearanceHelp,
    keywords: "theme light dark system",
  },
  {
    section: "appearance",
    title: s.spacing,
    help: s.spacingHelp,
    keywords: "density comfortable compact",
  },
  {
    section: "appearance",
    title: s.textSize,
    help: s.textSizeHelp,
    keywords: "font scale accessibility zoom",
  },
  {
    section: "appearance",
    title: s.readingPane,
    help: s.readingPaneHelp,
    keywords: "right bottom hidden layout",
  },
  {
    section: "appearance",
    title: s.sidebar,
    help: s.sidebarHelp,
    keywords: "mailboxes navigation",
  },
  {
    section: "appearance",
    title: s.windowEffects,
    help: s.windowEffectsHelp,
    keywords: "glass transparency blur",
  },
  {
    section: "reading",
    title: s.groupThreads,
    help: s.groupThreadsHelp,
    keywords: "conversation grouping",
  },
  {
    section: "reading",
    title: strings.mail.undoSendWindow,
    help: strings.mail.undoSendHelp,
    keywords: "sending delay",
  },
  {
    section: "notifications",
    title: s.notifyNewMail,
    help: s.notifyNewMailHelp,
    keywords: "alerts",
  },
  {
    section: "notifications",
    title: s.privateNotifications,
    help: s.privateNotificationsHelp,
    keywords: "privacy alerts",
  },
  {
    section: "accounts",
    title: s.connection,
    help: strings.setup.bridgeUnavailableHint,
    keywords:
      "server imap smtp port username password proton bridge certificate",
    accountPage: "connection",
  },
  {
    section: "accounts",
    title: s.folders,
    help: s.folderMissing,
    keywords: "sent drafts junk trash archive automatic assignments",
    accountPage: "folders",
  },
  {
    section: "accounts",
    title: s.signature,
    help: s.signatureHelp,
    keywords: "identity compose",
    accountPage: "identity",
  },
  {
    section: "accounts",
    title: s.rulesTitle,
    help: s.rulesHelp,
    keywords: "filters move matching",
    accountPage: "rules",
  },
  {
    section: "advanced",
    title: s.blockAds,
    help: s.blockAdsHelp,
    keywords: "privacy security advertising tracking easylist",
  },
  {
    section: "advanced",
    title: s.blockThreats,
    help: s.blockThreatsHelp,
    keywords: "privacy security tweetfeed dangerous reported",
  },
  {
    section: "storage",
    title: s.cacheMode,
    help: s.cachePolicyHelp,
    keywords: "download mail offline recent full",
  },
  {
    section: "storage",
    title: s.cacheDays,
    help: s.cachePolicyHelp,
    keywords: "days storage retention",
  },
  {
    section: "storage",
    title: s.cacheLimit,
    help: s.cachePolicyHelp,
    keywords: "disk space size",
  },
  {
    section: "shortcuts",
    title: s.shortcuts,
    help: "",
    keywords: "keyboard keys",
  },
  {
    section: "updates",
    title: s.checkUpdates,
    help: "",
    keywords: "version download restart",
  },
  {
    section: "about",
    title: s.about,
    help: "",
    keywords: "version licenses credits",
  },
];
