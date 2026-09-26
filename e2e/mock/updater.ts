import type { Page } from "@playwright/test";
import type { MockShared, MockState } from "./context";

// Updater plugin plus update relaunch commands. `?update=1` offers 9.9.9;
// `?updateLater=1` offers it only from the second check (Check for Updates);
// `?updateRelaunch=window|background` simulates a launch after an update.
// Every call is recorded in state.updateCalls. The init script below is
// stringified into the page, so keep it self-contained.
export async function registerMockUpdater(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as MockShared;
    const state = window.__POSTAL_SNAP_TEST__ as MockState;
    const { params } = mock;
    const record =
      (command: string, result?: () => unknown) =>
      (args: Record<string, unknown> = {}) => {
        state.updateCalls.push({ command, args: { ...args } });
        return result ? result() : undefined;
      };
    let checks = 0;
    Object.assign(mock.handlers, {
      "plugin:updater|check": record("check", () => {
        checks += 1;
        const offered =
          params.has("update") || (params.has("updateLater") && checks > 1);
        return offered
          ? { rid: 71, currentVersion: "0.2.3", version: "9.9.9" }
          : null;
      }),
      "plugin:updater|download": record("download", () => 72),
      "plugin:updater|install": record("install"),
      "plugin:resources|close": record("resources-close"),
      relaunch_app: record("relaunch_app"),
      quit_app: record("quit_app"),
      prepare_update_relaunch: record("prepare_update_relaunch"),
      clear_update_relaunch: record("clear_update_relaunch"),
      set_update_ready: record("set_update_ready"),
      schedule_background_update: record("schedule_background_update"),
      show_native_confirm: record("show_native_confirm", () => {
        const args = state.updateCalls[state.updateCalls.length - 1].args;
        return window.confirm(
          `${String(args.title)}\n\n${String(args.message)}`,
        );
      }),
      get_update_relaunch: () => params.get("updateRelaunch"),
      background_update_allowed: record(
        "background_update_allowed",
        () => state.backgroundUpdateAllowed,
      ),
    });
  });
}
