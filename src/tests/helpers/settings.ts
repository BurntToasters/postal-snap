import type { AppSettings } from "../../types";

export function makeSettings(
  theme: AppSettings["theme"] = "dark",
): AppSettings {
  return {
    schemaVersion: 2,
    readingPane: "right",
    textScale: 1,
    privateNotifications: false,
    theme,
    density: "comfortable",
    cachePolicy: { mode: "recent", days: 90, maxBytes: 1_073_741_824 },
    lastAccountId: null,
    lastMailboxId: null,
    folderPaneWidth: 248,
    messagePaneWidth: 390,
    readerPaneHeight: 360,
    windowEffects: false,
    sidebarVisible: true,
    undoSendSeconds: 10,
    blockAdvertisingAndTracking: true,
    blockReportedThreats: true,
    groupThreads: true,
    notifyNewMail: true,
    closeToTray: true,
    updateCheckInterval: "startupAnd6h",
    setupCompleted: true,
    setupStep: null,
  };
}
