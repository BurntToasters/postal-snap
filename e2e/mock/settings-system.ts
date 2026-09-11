import type { Page } from "@playwright/test";
import type { MockShared, MockState } from "./context";

// Settings, startup/cache state, distribution channel, and window effects.
// The init script below is stringified into the page, so keep it
// self-contained: type-only imports, locals, and browser globals only.
export async function registerMockSettingsSystem(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as MockShared;
    const state = window.__POSTAL_SNAP_TEST__ as MockState;
    const { params } = mock;
    Object.assign(mock.handlers, {
      get_settings() {
        return {
          schemaVersion: 2,
          readingPane:
            params.get("pane") ??
            (location.search.includes("tallBottom") ? "bottom" : "right"),
          textScale: Number(params.get("scale") ?? 1),
          privateNotifications: false,
          theme: params.get("theme") ?? "system",
          density: params.get("density") ?? "comfortable",
          cachePolicy: {
            mode: "recent",
            days: 90,
            maxBytes: 1_073_741_824,
          },
          lastAccountId: null,
          lastMailboxId: null,
          folderPaneWidth: params.has("oversized") ? 400 : 248,
          messagePaneWidth: params.has("oversized") ? 720 : 390,
          readerPaneHeight: location.search.includes("tallBottom") ? 800 : 360,
          windowEffects: false,
          sidebarVisible: !params.has("hiddenSidebar"),
          undoSendSeconds: 10,
          blockAdvertisingAndTracking: true,
          blockReportedThreats: true,
          groupThreads: true,
          notifyNewMail: true,
          setupCompleted: location.search.includes("firstRun") ? false : true,
          setupStep: null,
        };
      },
      supports_workspace_window_fx() {
        return true;
      },
      set_workspace_window_fx() {
        return undefined;
      },
      save_settings(args: Record<string, unknown>) {
        state.savedSettings.push(args.settings);
        return args.settings;
      },
      export_settings() {
        state.exportedSettings += 1;
        return true;
      },
      import_settings() {
        state.importedSettings += 1;
        return {
          schemaVersion: 2,
          readingPane: "bottom",
          textScale: 1.15,
          privateNotifications: true,
          theme: "dark",
          density: "compact",
          cachePolicy: {
            mode: "recent",
            days: 90,
            maxBytes: 1073741824,
          },
          lastAccountId: null,
          lastMailboxId: null,
          folderPaneWidth: 248,
          messagePaneWidth: 390,
          readerPaneHeight: 360,
          blockAdvertisingAndTracking: true,
          blockReportedThreats: true,
          groupThreads: true,
          notifyNewMail: true,
          setupCompleted: true,
          setupStep: null,
        };
      },
      reset_settings() {
        state.resetSettings += 1;
        return {
          schemaVersion: 2,
          readingPane: "right",
          textScale: 1,
          privateNotifications: false,
          theme: "system",
          density: "comfortable",
          cachePolicy: {
            mode: "recent",
            days: 90,
            maxBytes: 1073741824,
          },
          lastAccountId: null,
          lastMailboxId: null,
          folderPaneWidth: 248,
          messagePaneWidth: 390,
          readerPaneHeight: 360,
          blockAdvertisingAndTracking: true,
          blockReportedThreats: true,
          groupThreads: true,
          notifyNewMail: true,
          setupCompleted: true,
          setupStep: null,
        };
      },
      get_startup_notice() {
        return null;
      },
      get_startup_error() {
        return location.search.includes("startupFail")
          ? "Postal Snap could not open saved accounts. Your mail data was not deleted. Restart Postal Snap to try again."
          : null;
      },
      get_cache_usage() {
        return { bytes: 0, maxBytes: 1_073_741_824, messageCount: 0 };
      },
      get_distribution_channel() {
        return { kind: "direct", updatesManagedBy: "postalSnap" };
      },
    });
  });
}
