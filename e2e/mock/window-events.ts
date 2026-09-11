import type { Page } from "@playwright/test";
import type { MockShared, MockState } from "./context";

// Installs the Tauri internals stub plus the window, event, process,
// deep-link, and notification handlers. Unknown commands fall through to the
// handler registry that the other mock modules populate. The init script
// below is stringified into the page, so keep it self-contained: type-only
// imports, locals, and browser globals only.
export async function registerMockWindowEvents(
  page: Page,
  permissions: string[],
): Promise<void> {
  await page.addInitScript((permissions: string[]) => {
    Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
      value: { unregisterListener: () => undefined },
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        transformCallback(callback: (...args: unknown[]) => void) {
          const state = window.__POSTAL_SNAP_TEST__ as MockState;
          const id = state.nextCallback++;
          state.callbacks.set(id, callback);
          return id;
        },
        unregisterCallback(id: number) {
          const state = window.__POSTAL_SNAP_TEST__ as MockState;
          state.callbacks.delete(id);
        },
        convertFileSrc(path: string) {
          return path;
        },
        async invoke(command: string, args: Record<string, unknown> = {}) {
          const state = window.__POSTAL_SNAP_TEST__ as MockState;
          if (command.startsWith("plugin:window|")) {
            const action = command.split("|")[1];
            if (action === "is_maximized") return state.maximized;
            if (action === "is_fullscreen") return state.fullscreen;
            const permission =
              action === "internal_toggle_maximize"
                ? "core:default"
                : `core:window:allow-${action.replaceAll("_", "-")}`;
            if (!permissions.includes(permission))
              throw new Error(`Window permission missing: ${permission}`);
            if (state.failWindowAction)
              throw new Error("Window operation failed");
            state.windowCommands.push(action);
            if (
              action === "toggle_maximize" ||
              action === "internal_toggle_maximize"
            )
              state.maximized = !state.maximized;
            if (action === "set_fullscreen")
              state.fullscreen = Boolean(args.fullscreen);
            return undefined;
          }
          switch (command) {
            case "set_snap_overlay_bounds":
              state.snapBounds.push({ ...args });
              return undefined;
            case "plugin:event|listen": {
              const event = String(args.event);
              const handler = Number(args.handler);
              const listeners = state.eventListeners.get(event) ?? new Set();
              listeners.add(handler);
              state.eventListeners.set(event, listeners);
              return handler;
            }
            case "plugin:event|unlisten": {
              const listeners = state.eventListeners.get(String(args.event));
              listeners?.delete(Number(args.eventId));
              return undefined;
            }
            case "plugin:event|emit": {
              const event = String(args.event);
              for (const handler of state.eventListeners.get(event) ?? []) {
                state.callbacks.get(handler)?.({
                  event,
                  id: handler,
                  payload: args.payload,
                });
              }
              return null;
            }
            case "plugin:process|restart":
              return undefined;
            case "plugin:deep-link|get_current":
              return [];
            case "plugin:notification|is_permission_granted":
              return true;
            default: {
              const mock = window.__POSTAL_SNAP_MOCK__ as MockShared;
              const handler = mock.handlers[command];
              if (handler) return handler(args);
              throw new Error(`No mock handler for native command: ${command}`);
            }
          }
        },
      },
    });
  }, permissions);
}
