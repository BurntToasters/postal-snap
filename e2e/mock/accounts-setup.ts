import type { Page } from "@playwright/test";
import type { MockShared, MockState } from "./context";

// Account listing, credential updates, signatures, aliases, filter rules,
// adding accounts, erase, and relaunch. The init script below is stringified
// into the page, so keep it self-contained: type-only imports, locals, and
// browser globals only.
export async function registerMockAccountsSetup(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__ as MockShared;
    const state = window.__POSTAL_SNAP_TEST__ as MockState;
    const { account } = mock;
    Object.assign(mock.handlers, {
      list_accounts() {
        if (location.search.includes("startupFail")) {
          throw {
            code: "localStorageFailed",
            message:
              "Postal Snap could not access local mail data on your computer.",
            retryable: true,
          };
        }
        return location.search.includes("firstRun") && !state.added
          ? []
          : [account];
      },
      test_account(args: Record<string, unknown>) {
        state.setupRequest = args.request;
        return undefined;
      },
      update_account_password(args: Record<string, unknown>) {
        state.setupRequest = args.password;
        account.error = null;
        return { ...account };
      },
      update_account_signature(args: Record<string, unknown>) {
        (account as { signature?: string }).signature = String(args.signature);
        return { ...account };
      },
      list_filter_rules() {
        state.rules = state.rules ?? [];
        return state.rules;
      },
      create_filter_rule(args: Record<string, unknown>) {
        const rule = args.rule as Record<string, unknown>;
        const created = {
          ...rule,
          id: `rule-${state.rules.length + 1}`,
        };
        state.rules.push(created);
        return created;
      },
      update_filter_rule(args: Record<string, unknown>) {
        const rule = args.rule as Record<string, unknown>;
        state.rules = state.rules.map((item) =>
          item.id === rule.id ? rule : item,
        );
        return rule;
      },
      delete_filter_rule(args: Record<string, unknown>) {
        state.rules = state.rules.filter((rule) => rule.id !== args.ruleId);
        return undefined;
      },
      add_account(args: Record<string, unknown>) {
        if (location.search.includes("setupFail")) {
          throw {
            code: "authenticationFailed",
            message: "Sign-in failed. Check the email address and password.",
            retryable: true,
          };
        }
        state.added = true;
        state.setupRequest = args.request;
        return account;
      },
      discover_account_aliases() {
        (account as { aliases?: string[] }).aliases = [
          "alias1@icloud.com",
          "custom@mydomain.com",
        ];
        return { ...account };
      },
      update_account_aliases(args: Record<string, unknown>) {
        (account as { aliases?: string[] }).aliases = args.aliases as string[];
        return { ...account };
      },
      relaunch_app() {
        return undefined;
      },
      quit_app() {
        return undefined;
      },
      erase_all_data() {
        state.added = false;
        return 1;
      },
    });
  });
}
