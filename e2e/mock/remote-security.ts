import type { Page } from "@playwright/test";
import type { MockShared, MockState } from "./context";

// Remote-image fetching, external-link inspection/opening, inline images,
// and native dialogs. The init script below is stringified into the page,
// so keep it self-contained: type-only imports, locals, and browser globals
// only.
export async function registerMockRemoteSecurity(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as MockShared;
    const state = window.__POSTAL_SNAP_TEST__ as MockState;
    Object.assign(mock.handlers, {
      fetch_remote_image() {
        state.remoteFetches += 1;
        if (location.search.includes("filterBlocked"))
          return { status: "blocked" };
        if (location.search.includes("threatBlocked"))
          return { status: "reportedThreat" };
        if (location.search.includes("imageFailed"))
          throw new Error("Image unavailable.");
        return {
          status: "loaded",
          dataUrl: "data:image/png;base64,iVBORw0KGgo=",
        };
      },
      inspect_external_url(args: Record<string, unknown>) {
        const raw = String(args.url);
        let parsed: URL;
        try {
          parsed = new URL(raw);
        } catch {
          throw new Error("That link is not a valid web address.");
        }
        if (
          parsed.username ||
          parsed.password ||
          !/^https?:$/.test(parsed.protocol)
        ) {
          throw new Error("Postal Snap can only open ordinary web links.");
        }
        return {
          url: parsed.href,
          hostname: parsed.hostname,
          reportedThreat: location.search.includes("threatLink"),
        };
      },
      open_external_url(args: Record<string, unknown>) {
        state.openedUrls.push(String(args.url));
        return undefined;
      },
      open_help_url() {
        return undefined;
      },
      read_message_inline_image() {
        state.inlineReads += 1;
        return "data:image/png;base64,iVBORw0KGgo=";
      },
      show_native_confirm(args: Record<string, unknown>) {
        return window.confirm(
          `${String(args.title)}\n\n${String(args.message)}`,
        );
      },
      show_native_message(args: Record<string, unknown>) {
        window.alert(`${String(args.title)}\n\n${String(args.message)}`);
        return undefined;
      },
    });
  });
}
