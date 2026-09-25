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
    const { account, accounts, params } = mock;
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
        if (
          (location.search.includes("firstRun") || params.has("noAccounts")) &&
          !state.added
        ) {
          return [];
        }
        return (params.has("multiAccount") ? accounts : [account]).map(
          (item) => ({ ...item, aliases: [...(item.aliases ?? [])] }),
        );
      },
      test_account(args: Record<string, unknown>) {
        state.setupRequest = args.request;
        return undefined;
      },
      discover_mail_settings(args: Record<string, unknown>) {
        const email = String(args.email ?? "").toLowerCase();
        if (email.endsWith("@gmail.com")) {
          return {
            status: "unsupported",
            providerId: "gmail",
            providerName: "Gmail",
            message:
              "Gmail requires OAuth for new third-party mail connections. Postal Snap does not support Gmail sign-in yet.",
          };
        }
        if (email.endsWith("@fastmail.com")) {
          return {
            status: "found",
            providerId: "fastmail",
            providerName: "Fastmail",
            accountProvider: "manual",
            source: "preset",
            imap: {
              host: "imap.fastmail.com",
              port: 993,
              tlsMode: "tls",
              username: email,
            },
            smtp: {
              host: "smtp.fastmail.com",
              port: 465,
              tlsMode: "tls",
              username: email,
            },
            appPasswordUrl:
              "https://www.fastmail.help/hc/en-us/articles/360058752854-App-passwords",
          };
        }
        if (email.endsWith("@autodetect.example")) {
          return {
            status: "found",
            providerId: "autoconfig",
            providerName: "autodetect.example",
            accountProvider: "manual",
            source: "autoconfig",
            imap: {
              host: "imap.autodetect.example",
              port: 993,
              tlsMode: "tls",
              username: email,
            },
            smtp: {
              host: "smtp.autodetect.example",
              port: 587,
              tlsMode: "startTls",
              username: email,
            },
            appPasswordUrl: null,
          };
        }
        return {
          status: "notFound",
          domain: email.split("@").at(-1) ?? "example.com",
        };
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
      get_sync_progress() {
        return {
          accountId: account.id,
          folder: "INBOX",
          envelopesDone: 24,
          envelopesTotal: 100,
          bodiesDone: 8,
          bodiesTotal: 90,
          backfilling: true,
        };
      },
      get_account_inbox_counts() {
        return accounts.map((item) => {
          const inbox = mock.mailboxes.find(
            (mailbox) =>
              mailbox.accountId === item.id && mailbox.role === "inbox",
          );
          return {
            accountId: item.id,
            unreadCount: inbox?.unreadCount ?? 0,
            totalCount: inbox?.totalCount ?? 0,
          };
        });
      },
      get_account_removal_impact() {
        return params.has("removalImpact")
          ? { unsentMessages: 2, unsyncedDrafts: 1, queuedChanges: 3 }
          : { unsentMessages: 0, unsyncedDrafts: 0, queuedChanges: 0 };
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
