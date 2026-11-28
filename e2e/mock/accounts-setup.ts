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
    const badgeTestState = state as MockState & {
      pendingBadgeCounts?: number;
      releaseDelayedBadgeCounts?: () => void;
    };
    const delayedBadgeCounts: Array<() => void> = [];
    badgeTestState.pendingBadgeCounts = 0;
    badgeTestState.releaseDelayedBadgeCounts = () => {
      for (const release of delayedBadgeCounts.splice(0)) release();
    };
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
    let connectionLoadAttempts = 0;
    let folderLoadAttempts = 0;
    let accountOrder: string[] | null = null;
    type OfflineFixtureOperation = {
      id: number;
      kind: string;
      state: "queued" | "needs_attention";
      reviewToken: string;
      payload?: string;
    };
    const offlineFixtureKey = "postal-snap-e2e-offline-recovery";
    let offlineOperations: Record<string, OfflineFixtureOperation[]> = {};
    let offlineDismissedIds: Record<string, number[]> = {};
    let offlineUnsentMessages: Record<string, number> = {};
    if (params.has("offlineAttentionRecovery")) {
      try {
        const stored = localStorage.getItem(offlineFixtureKey);
        if (stored) {
          const parsed = JSON.parse(stored) as {
            operations?: Record<string, OfflineFixtureOperation[]>;
            dismissedIds?: Record<string, number[]>;
            unsentMessages?: Record<string, number>;
          };
          offlineOperations = parsed.operations ?? {};
          offlineDismissedIds = parsed.dismissedIds ?? {};
          offlineUnsentMessages = parsed.unsentMessages ?? {};
        }
      } catch {
        offlineOperations = {};
      }
      if (params.has("offlineNoFailures")) {
        offlineOperations = { "account-1": [], "account-2": [] };
        offlineDismissedIds = {};
        offlineUnsentMessages = {};
      } else if (!offlineOperations["account-2"]) {
        offlineOperations = {
          "account-1": [
            {
              id: 201,
              kind: "keyword",
              state: "needs_attention",
              reviewToken: "review-account-1-201-v1",
              payload: "PRIVATE_SUBJECT Sam@icloud.com",
            },
          ],
          "account-2": [
            {
              id: 101,
              kind: "move",
              state: "needs_attention",
              reviewToken: "review-account-2-101-v1",
              payload: "PRIVATE_SUBJECT reader@fastmail.com",
            },
            {
              id: 102,
              kind: "flags",
              state: "queued",
              reviewToken: "",
              payload: "PRIVATE_SUBJECT reader@fastmail.com",
            },
          ],
        };
        offlineDismissedIds = {};
        offlineUnsentMessages = { "account-2": 1 };
      }
      localStorage.setItem(
        offlineFixtureKey,
        JSON.stringify({
          operations: offlineOperations,
          dismissedIds: offlineDismissedIds,
          unsentMessages: offlineUnsentMessages,
        }),
      );
    }
    function saveOfflineFixture() {
      localStorage.setItem(
        offlineFixtureKey,
        JSON.stringify({
          operations: offlineOperations,
          dismissedIds: offlineDismissedIds,
          unsentMessages: offlineUnsentMessages,
        }),
      );
    }
    function blockers(id: string) {
      if (params.has("pendingConnectionWork"))
        return { queuedChanges: 2, unsentMessages: 1 };
      const operations = offlineOperations[id] ?? [];
      return {
        queuedChanges: operations.length,
        unsentMessages: offlineUnsentMessages[id] ?? 0,
      };
    }
    let accountPolicy = {
      mode: "recent",
      days: 90,
      maxBytes: 1_073_741_824,
    };
    function listedAccounts() {
      const listed = (params.has("multiAccount") ? accounts : [account]).map(
        (item) => ({ ...item, aliases: [...(item.aliases ?? [])] }),
      );
      if (!accountOrder) return listed;
      const byId = new Map(listed.map((item) => [item.id, item]));
      return accountOrder.flatMap((id) => {
        const item = byId.get(id);
        return item ? [item] : [];
      });
    }
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
      return {
        ...connections[item.id],
        blockers: blockers(item.id),
      };
    }
    function folderAssignments(id: unknown) {
      const item = ownedAccount(id);
      assignments[item.id] ??= [
        "inbox",
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
      test_saved_account(args: Record<string, unknown>) {
        if (!mock.accounts.some((item) => item.id === args.accountId))
          throw mock.mockError("notFound", "Account not found.");
        return undefined;
      },
      get_account_connection(args: Record<string, unknown>) {
        if (
          params.has("connectionLoadFailure") &&
          connectionLoadAttempts++ < 2
        ) {
          return new Promise((resolve) =>
            setTimeout(resolve, params.has("slowAccountLoads") ? 1000 : 0),
          ).then(() => {
            throw {
              code: "localStorageFailed",
              message:
                "Postal Snap could not access local mail data on your computer.",
              retryable: true,
            };
          });
        }
        return structuredClone(connection(args.accountId));
      },
      update_account_connection(args: Record<string, unknown>) {
        const item = ownedAccount(args.accountId);
        if (
          params.has("pendingConnectionWork") ||
          blockers(item.id).queuedChanges > 0 ||
          blockers(item.id).unsentMessages > 0
        )
          throw {
            code: "pendingOperations",
            message:
              "Resolve queued changes and unsent mail before changing the incoming server identity.",
            retryable: false,
          };
        if (
          params.has("failIncomingConnection") ||
          params.has("failOutgoingConnection")
        )
          throw {
            code: "connectionFailed",
            stage: params.has("failIncomingConnection") ? "imap" : "smtp",
            message: "Synthetic raw connection detail fixture-private-secret.",
            retryable: true,
          };
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
        return structuredClone(connections[item.id]);
      },
      get_failed_offline_operations(args: Record<string, unknown>) {
        const item = ownedAccount(args.accountId);
        const operations = (offlineOperations[item.id] ?? []).filter(
          (operation) => operation.state === "needs_attention",
        );
        const limit = Math.max(1, Math.min(Number(args.limit) || 100, 100));
        return {
          items: operations
            .slice(0, limit)
            .map(({ id, kind, reviewToken }) => ({ id, kind, reviewToken })),
          totalCount: operations.length,
        };
      },
      dismiss_failed_offline_operations(args: Record<string, unknown>) {
        const item = ownedAccount(args.accountId);
        const reviewed = Array.isArray(args.operations)
          ? (args.operations as Array<{ id: number; reviewToken: string }>)
          : [];
        const ids = reviewed.map((operation) => Number(operation.id));
        const uniqueIds = new Set(ids);
        const operations = offlineOperations[item.id] ?? [];
        if (
          reviewed.length === 0 ||
          reviewed.length > 100 ||
          uniqueIds.size !== reviewed.length ||
          reviewed.some(
            ({ id, reviewToken }) =>
              !operations.some(
                (operation) =>
                  operation.id === Number(id) &&
                  operation.state === "needs_attention" &&
                  operation.reviewToken === reviewToken,
              ),
          )
        )
          throw {
            code: "invalidInput",
            message:
              "Some selected failed changes have changed. Refresh the list and try again.",
            retryable: false,
          };
        offlineOperations[item.id] = operations.filter(
          (operation) => !uniqueIds.has(operation.id),
        );
        offlineDismissedIds[item.id] = [
          ...(offlineDismissedIds[item.id] ?? []),
          ...ids,
        ];
        saveOfflineFixture();
        return {
          dismissedCount: ids.length,
          blockers: blockers(item.id),
        };
      },
      import_bridge_certificate() {
        if (params.has("invalidCertificate"))
          throw {
            code: "certificateInvalid",
            message: "Choose a valid public certificate.",
            retryable: false,
          };
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
        if (args.accountId) {
          const item = ownedAccount(args.accountId);
          connection(item.id);
          connections[item.id]!.certificate = { ...approved };
        }
        return approved.reference;
      },
      remove_bridge_certificate(args: Record<string, unknown>) {
        const item = ownedAccount(args.accountId);
        delete connections[item.id]?.certificate;
        return undefined;
      },
      get_folder_assignments(args: Record<string, unknown>) {
        if (params.has("folderLoadFailure") && folderLoadAttempts++ < 2) {
          return new Promise((resolve) =>
            setTimeout(resolve, params.has("slowAccountLoads") ? 1000 : 0),
          ).then(() => {
            throw {
              code: "localStorageFailed",
              message:
                "Postal Snap could not access local mail data on your computer.",
              retryable: true,
            };
          });
        }
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
        return listedAccounts();
      },
      get_account_cache_policy() {
        return { ...accountPolicy };
      },
      set_account_cache_policy(args: Record<string, unknown>) {
        const policy = args.policy as
          { mode?: string; days?: number; maxBytes?: number } | undefined;
        if (!policy || (policy.mode !== "recent" && policy.mode !== "full")) {
          throw {
            code: "invalidInput",
            message: "Choose a valid download setting.",
            retryable: false,
          };
        }
        accountPolicy = {
          mode: policy.mode,
          days: Number(policy.days ?? 0),
          maxBytes: Number(policy.maxBytes ?? 0),
        };
        return { ...accountPolicy };
      },
      get_account_cache_usage() {
        return {
          bytes: 4096,
          maxBytes: accountPolicy.maxBytes,
          messageCount: 4,
        };
      },
      clear_account_downloads() {
        return undefined;
      },
      update_account_color(args: Record<string, unknown>) {
        const allowed = [
          "blue",
          "teal",
          "green",
          "amber",
          "orange",
          "red",
          "pink",
          "purple",
        ];
        const color = args.color == null ? null : String(args.color);
        if (color !== null && !allowed.includes(color)) {
          throw {
            code: "invalidInput",
            message: "Choose one of the listed colors.",
            retryable: false,
          };
        }
        const listed = params.has("multiAccount") ? accounts : [account];
        const target = listed.find((item) => item.id === args.accountId);
        if (!target) {
          throw {
            code: "notFound",
            message: "Account not found.",
            retryable: false,
          };
        }
        target.color = color ?? undefined;
        return { ...target, aliases: [...(target.aliases ?? [])] };
      },
      set_account_notifications(args: Record<string, unknown>) {
        const listed = params.has("multiAccount") ? accounts : [account];
        const target = listed.find((item) => item.id === args.accountId);
        if (!target)
          throw {
            code: "notFound",
            message: "Account not found.",
            retryable: false,
          };
        if (params.has("notifyFail"))
          throw {
            code: "operationFailed",
            message: "The notification setting could not be saved.",
            retryable: true,
          };
        target.notifyNewMail = Boolean(args.enabled);
        return undefined;
      },
      reorder_accounts(args: Record<string, unknown>) {
        const ids = args.accountIds;
        const listed = (params.has("multiAccount") ? accounts : [account]).map(
          (item) => item.id,
        );
        if (
          !Array.isArray(ids) ||
          ids.length !== listed.length ||
          new Set(ids).size !== ids.length ||
          !ids.every((id) => listed.includes(String(id)))
        ) {
          throw {
            code: "invalidInput",
            message: "Account order is invalid.",
            retryable: false,
          };
        }
        accountOrder = ids.map((id) => String(id));
        return listedAccounts();
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
      update_account_display_name(args: Record<string, unknown>) {
        account.displayName = String(args.displayName ?? "").trim();
        return { ...account };
      },
      update_account_reply_to(args: Record<string, unknown>) {
        (account as { replyTo?: string }).replyTo = String(
          args.replyTo ?? "",
        ).trim();
        return { ...account };
      },
      update_account_signature(args: Record<string, unknown>) {
        (account as { signature?: string }).signature = String(args.signature);
        if (typeof args.signatureHtml === "string") {
          (account as { signatureHtml?: string }).signatureHtml =
            args.signatureHtml;
        } else {
          (account as { signatureHtml?: string }).signatureHtml = "";
        }
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
        if (params.has("blockedSender") && state.rules.length === 0) {
          state.rules.push({
            id: "rule-block",
            accountId: account.id,
            name: "Block sender",
            field: "from",
            contains: "jane@example.com",
            action: "move_junk",
            enabled: true,
          });
        }
        if (params.has("legacyRule") && state.rules.length === 0) {
          state.rules.push({
            id: "rule-legacy",
            accountId: account.id,
            name: "Legacy archive",
            field: "from",
            contains: "legacy@example.test",
            action: "move_archive",
            targetMailbox: null,
            enabled: true,
          });
        }
        const v2Block = params.get("v2BlockedSender");
        if (v2Block && state.rules.length === 0) {
          const extra =
            v2Block === "2" ? [{ field: "subject", value: "Weekend" }] : [];
          state.rules.push({
            id: "rule-v2-block",
            accountId: account.id,
            name: "Block sender",
            field: "from",
            contains: "jane@example.com",
            action: "move_junk",
            targetMailbox: null,
            enabled: true,
            matchMode: "all",
            conditions: [
              { field: "from", value: "jane@example.com" },
              ...extra,
            ],
            actions: [
              { kind: "move_junk", targetMailbox: null, flagColor: null },
            ],
          });
        }
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
      reorder_filter_rules(args: Record<string, unknown>) {
        const ids = args.orderedIds as string[];
        state.rules = ids
          .map((id) => state.rules.find((rule) => rule.id === id))
          .filter((rule) => rule !== undefined);
        return state.rules;
      },
      preview_filter_rule() {
        return { matched: 0, capped: false, subjects: [] };
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
            stage:
              params.get("certificateFailureStage") === "imap"
                ? "imap"
                : "smtp",
            message:
              "Synthetic certificate failure detail fixture-private-secret.",
            retryable: true,
          };
        if (params.has("setupStorageFail"))
          throw {
            code: "localStorageFailed",
            message:
              "Postal Snap could not access local mail data on your computer.",
            retryable: true,
          };
        if (params.has("setupDuplicate"))
          throw {
            code: "operationFailed",
            message: "An account with this email address is already set up.",
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
        if (state.accountRemoved) return [];
        // ?badgeCounts=0,1200 overrides unread per account, in order.
        const forced = params.get("badgeCounts")?.split(",").map(Number);
        const counts = accounts.map((item, index) => {
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
        if (params.has("delayBadgeCounts") && !state.accountRemoved) {
          return new Promise<typeof counts>((resolve) => {
            badgeTestState.pendingBadgeCounts =
              (badgeTestState.pendingBadgeCounts ?? 0) + 1;
            delayedBadgeCounts.push(() => {
              badgeTestState.pendingBadgeCounts = Math.max(
                0,
                (badgeTestState.pendingBadgeCounts ?? 1) - 1,
              );
              resolve(counts);
            });
          });
        }
        return counts;
      },
      get_account_removal_impact() {
        return params.has("removalImpact")
          ? { unsentMessages: 2, unsyncedDrafts: 1, queuedChanges: 3 }
          : { unsentMessages: 0, unsyncedDrafts: 0, queuedChanges: 0 };
      },
      remove_account() {
        state.accountRemoved = true;
        return {
          cleanupPending: false,
          diskSpacePending: params.has("diskSpacePending"),
        };
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
    Object.assign(mock, {
      offlineFixture: {
        add(accountId: string, operation: OfflineFixtureOperation) {
          const item = ownedAccount(accountId);
          offlineOperations[item.id] ??= [];
          offlineOperations[item.id].push(structuredClone(operation));
          saveOfflineFixture();
        },
        failAgain(accountId: string, replacement: OfflineFixtureOperation) {
          const item = ownedAccount(accountId);
          const operations = offlineOperations[item.id] ?? [];
          const current = operations.find(
            (operation) => operation.id === replacement.id,
          );
          if (!current) throw new Error("Fixture operation not found.");
          current.state = "queued";
          current.reviewToken = "";
          Object.assign(current, structuredClone(replacement));
          saveOfflineFixture();
        },
        snapshot(accountId: string) {
          const item = ownedAccount(accountId);
          return {
            operations: structuredClone(offlineOperations[item.id] ?? []),
            dismissedIds: structuredClone(offlineDismissedIds[item.id] ?? []),
            unsentMessages: offlineUnsentMessages[item.id] ?? 0,
          };
        },
      },
    });
  });
}
