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
    type Certificate = {
      reference: string;
      fingerprint: string;
      expiresAt: string;
    };
    type Server = {
      host: string;
      port: number;
      tlsMode: string;
      username: string;
    };
    const connections: Record<
      string,
      { imap: Server; smtp: Server; certificate?: Certificate }
    > = {};
    const certificates = new Map<string, Certificate>();
    const assignments: Record<
      string,
      Array<{ role: string; mailboxId: number | null; missing: boolean }>
    > = {};
    const certificate: Certificate = {
      reference: "bridge-certificate-fixture",
      fingerprint: "SHA-256: 12:34:56:78:90:AB:CD:EF",
      expiresAt: "2099-01-01T00:00:00Z",
    };
    function ownedAccount(id: unknown) {
      const item = accounts.find((candidate) => candidate.id === id);
      if (!item)
        throw {
          code: "invalidInput",
          message: "Account not found.",
          retryable: false,
        };
      return item;
    }
    function connection(id: unknown) {
      const item = ownedAccount(id);
      connections[item.id] ??= {
        imap: {
          host: "imap.mail.me.com",
          port: 993,
          tlsMode: "tls",
          username: item.email,
        },
        smtp: {
          host: "smtp.mail.me.com",
          port: 587,
          tlsMode: "startTls",
          username: item.email,
        },
      };
      return connections[item.id];
    }
    function folderAssignments(id: unknown) {
      const item = ownedAccount(id);
      assignments[item.id] ??= [
        "sent",
        "drafts",
        "archive",
        "junk",
        "trash",
      ].map((role) => ({
        role,
        mailboxId:
          params.has("missingFolder") &&
          item.id === account.id &&
          role === "sent"
            ? 999
            : null,
        missing:
          params.has("missingFolder") &&
          item.id === account.id &&
          role === "sent",
      }));
      return assignments[item.id];
    }
    Object.assign(mock.handlers, {
      get_account_connection(args: Record<string, unknown>) {
        return structuredClone(connection(args.accountId));
      },
      update_account_connection(args: Record<string, unknown>) {
        const item = ownedAccount(args.accountId);
        if (params.has("failConnection"))
          throw {
            code: "connectionFailed",
            message:
              "Connection test failed. Your saved connection has not changed.",
            retryable: true,
          };
        connections[item.id] = {
          ...connection(item.id),
          imap: structuredClone(args.imap as Server),
          smtp: structuredClone(args.smtp as Server),
        };
        return { ...item };
      },
      import_bridge_certificate() {
        if (params.has("certificateCancel")) return null;
        certificates.set(certificate.reference, certificate);
        return { ...certificate };
      },
      approve_bridge_certificate(args: Record<string, unknown>) {
        const approved = certificates.get(
          String(args.reference ?? args.certificateReference),
        );
        if (!approved)
          throw {
            code: "invalidInput",
            message: "Import a public certificate first.",
            retryable: false,
          };
        if (args.accountId)
          connection(args.accountId).certificate = { ...approved };
        return approved.reference;
      },
      remove_bridge_certificate(args: Record<string, unknown>) {
        delete connection(args.accountId).certificate;
        return undefined;
      },
      get_folder_assignments(args: Record<string, unknown>) {
        return structuredClone(folderAssignments(args.accountId));
      },
      set_folder_assignment(args: Record<string, unknown>) {
        const rows = folderAssignments(args.accountId);
        const row = rows.find((item) => item.role === args.role);
        if (!row)
          throw {
            code: "invalidInput",
            message: "Unknown folder role.",
            retryable: false,
          };
        const mailboxId =
          args.mailboxId == null ? null : Number(args.mailboxId);
        if (
          mailboxId !== null &&
          !mock.mailboxes.some(
            (box) => box.id === mailboxId && box.accountId === args.accountId,
          )
        )
          throw {
            code: "invalidInput",
            message: "Choose a folder belonging to this account.",
            retryable: false,
          };
        row.mailboxId = mailboxId;
        row.missing = false;
        return structuredClone(rows);
      },
      list_accounts() {
        state.accountLoads += 1;
        if (location.search.includes("startupFail")) {
          throw {
            code: "localStorageFailed",
            message:
              "Postal Snap could not access local mail data on your computer.",
            retryable: true,
          };
        }
        if (state.accountRemoved) return [];
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
      update_account_default_body_format(args: Record<string, unknown>) {
        (account as { defaultBodyFormat?: string }).defaultBodyFormat = String(
          args.format,
        );
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
      async add_account(args: Record<string, unknown>) {
        const request = args.request as Record<string, unknown>;
        if (
          params.has("bridgeCertificateFail") &&
          request.provider === "protonBridge" &&
          !request.certificateReference
        )
          throw {
            code: "certificateFailed",
            message:
              "Bridge certificate verification failed. Import Bridge's exported public certificate.",
            retryable: true,
          };
        if (location.search.includes("setupFail")) {
          throw {
            code: "authenticationFailed",
            message: "Sign-in failed. Check the email address and password.",
            retryable: true,
          };
        }
        state.added = true;
        state.accountRemoved = false;
        state.setupRequest = args.request;
        if (params.has("delayAddAccount")) {
          await new Promise<void>((resolve) => {
            state.releaseAddAccount = resolve;
          });
        }
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
        // ?badgeCounts=0,1200 overrides unread per account, in order.
        const forced = params.get("badgeCounts")?.split(",").map(Number);
        return accounts.map((item, index) => {
          const inbox = mock.mailboxes.find(
            (mailbox) =>
              mailbox.accountId === item.id && mailbox.role === "inbox",
          );
          return {
            accountId: item.id,
            unreadCount: forced?.[index] ?? inbox?.unreadCount ?? 0,
            totalCount: inbox?.totalCount ?? 0,
          };
        });
      },
      get_account_removal_impact() {
        return params.has("removalImpact")
          ? { unsentMessages: 2, unsyncedDrafts: 1, queuedChanges: 3 }
          : { unsentMessages: 0, unsyncedDrafts: 0, queuedChanges: 0 };
      },
      remove_account() {
        state.accountRemoved = true;
        return { cleanupPending: false };
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
