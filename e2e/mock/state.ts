import type { Page } from "@playwright/test";
import type { MockState } from "./context";

// Installs the observable test bag on window.__POSTAL_SNAP_TEST__.
// The init script below is stringified into the page, so keep it
// self-contained: type-only imports, locals, and browser globals only.
export async function registerMockState(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state: MockState = {
      windowCommands: [] as string[],
      snapBounds: [] as Array<Record<string, unknown>>,
      maximized: false,
      fullscreen: false,
      failWindowAction: false,
      savedSettings: [] as unknown[],
      added: false,
      accountRemoved: false,
      accountLoads: 0,
      discarded: false,
      snoozed: false,
      sentDraft: undefined as unknown,
      setupRequest: undefined as unknown,
      remoteFetches: 0,
      openedUrls: [] as string[],
      inlineReads: 0,
      retried: false,
      moved: false,
      exportedSettings: 0,
      importedSettings: 0,
      rules: [] as Array<Record<string, unknown>>,
      callbacks: new Map<number, (...args: unknown[]) => void>(),
      eventListeners: new Map<string, Set<number>>(),
      nextCallback: 1,
    };
    Object.defineProperty(window, "__POSTAL_SNAP_TEST__", { value: state });
  });
}
