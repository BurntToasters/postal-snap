import { strings } from "../../i18n";
import type { ProviderKind } from "../../types";
import type { SettingsTab } from "./primitives";

export interface SettingsSearchEntry {
  section: SettingsTab;
  title: string;
  help: string;
  keywords: string;
  provider?: ProviderKind;
  directUpdates?: boolean;
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
    title: s.bccSelf,
    help: s.bccSelfHelp,
    keywords: "bcc copy myself",
  },
  {
    section: "reading",
    title: s.replyToAll,
    help: s.replyToAllHelp,
    keywords: "reply all everyone recipients",
  },
  {
    section: "reading",
    title: s.signatureAboveQuote,
    help: s.signatureAboveQuoteHelp,
    keywords: "signature quote reply",
  },
  {
    section: "reading",
    title: s.markRead,
    help: s.markReadHelp,
    keywords: "unread read delay",
  },
  {
    section: "reading",
    title: s.showMessagePreviews,
    help: s.showMessagePreviewsHelp,
    keywords: "snippet preview list privacy",
  },
  {
    section: "reading",
    title: s.imageSenders,
    help: s.imageSendersHelp,
    keywords: "remote images pictures consent sender",
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
    title: s.newMailSound,
    help: s.newMailSoundHelp,
    keywords: "sound audio chime alert",
  },
  {
    section: "notifications",
    title: s.quietHours,
    help: s.quietHoursHelp,
    keywords: "quiet hours night schedule alerts sound",
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
    title: s.accountName,
    help: s.accountNameHelp,
    keywords: "from display identity sender",
    accountPage: "identity",
  },
  {
    section: "accounts",
    title: s.replyToAddress,
    help: s.replyToAddressHelp,
    keywords: "reply-to reply address identity",
    accountPage: "identity",
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
    directUpdates: true,
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
  {
    section: "accounts",
    accountPage: "connection",
    title: s.updatePassword,
    help: strings.setup.authHintManual,
    keywords: "credentials repair sign in authentication",
  },
  {
    section: "accounts",
    accountPage: "connection",
    provider: "protonBridge",
    title: s.importCertificate,
    help: strings.setup.bridgeCertificateHint,
    keywords: "proton bridge trust fingerprint expiry tls certificate",
  },
  {
    section: "accounts",
    accountPage: "identity",
    title: s.newMessageFormat,
    help: s.newMessageFormatHelp,
    keywords: "compose plain text rich html sending",
  },
  {
    section: "accounts",
    accountPage: "identity",
    provider: "icloud",
    title: s.aliasesTitle,
    help: s.aliasesHelp,
    keywords: "identity sender addresses custom domain",
  },
  {
    section: "storage",
    title: s.clearMail,
    help: s.clearMailHelp,
    keywords: "cache disk storage remove downloaded",
  },
  {
    section: "updates",
    directUpdates: true,
    title: s.updateCheckInterval,
    help: s.updateCheckIntervalHelp,
    keywords: "cadence automatic startup frequency interval",
  },
  {
    section: "about",
    title: s.aboutSource,
    help: "",
    keywords: "github repository open source",
  },
  {
    section: "about",
    title: s.aboutLicense,
    help: "",
    keywords: "licenses credits third party",
  },
];
