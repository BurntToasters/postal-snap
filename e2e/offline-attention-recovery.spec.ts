import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifactsAfterEach } from "./ipc";
import type { MockShared } from "./mock/context";

type OfflineFixtureMock = MockShared & {
  offlineFixture: {
    add: (
      accountId: string,
      operation: {
        id: number;
        kind: string;
        state: "queued" | "needs_attention";
        reviewToken: string;
        payload?: string;
      },
    ) => void;
    failAgain: (
      accountId: string,
      replacement: {
        id: number;
        kind: string;
        state: "needs_attention";
        reviewToken: string;
        payload?: string;
      },
    ) => void;
    snapshot: (accountId: string) => {
      operations: Array<{ id: number; state: string; reviewToken: string }>;
      dismissedIds: number[];
      unsentMessages: number;
    };
  };
};

test.afterEach(attachArtifactsAfterEach);
test.beforeEach(async ({ page }) => installMockIpc(page));

async function openAccount(
  page: import("@playwright/test").Page,
  name: string,
) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  await page
    .getByRole("button", { name: new RegExp(`^Manage ${name}\\b`) })
    .click();
}

test("dismisses only reviewed failed local changes for one account", async ({
  page,
}, testInfo) => {
  await page.goto("/?multiAccount=1&offlineAttentionRecovery=1");
  await openAccount(page, "Work");

  const server = page
    .getByRole("group", { name: "Incoming IMAP" })
    .getByLabel("Server", { exact: true });
  await server.fill("imap.edited.example");

  const recovery = page.getByRole("region", {
    name: "Connection recovery",
  });
  const failedChanges = recovery.getByRole("group", {
    name: "Connection recovery",
  });
  await expect(failedChanges).toHaveCount(1);
  await expect(failedChanges.locator("legend")).toHaveClass("visually-hidden");
  await expect(
    recovery.getByText("Move · change 101", { exact: true }),
  ).toBeVisible();
  await expect(recovery.getByText(/change 102|change 201/)).toHaveCount(0);
  await expect(recovery).not.toContainText("PRIVATE_SUBJECT");
  await expect(recovery).not.toContainText("reader@fastmail.com");
  await expect(recovery).not.toContainText("sam@icloud.com");
  await testInfo.attach("offline-attention-before-review", {
    body: await recovery.screenshot(),
    contentType: "image/png",
  });

  const selected = recovery.getByRole("checkbox", {
    name: "Move · change 101",
  });
  await selected.check();
  await recovery
    .getByRole("button", { name: "Review selected failed changes" })
    .click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Dismiss failed local changes?",
  });
  await expect(confirmation).toContainText("101");
  await expect(
    confirmation.getByRole("button", { name: "Cancel" }),
  ).toBeFocused();
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(
    recovery.getByText("Move · change 101", { exact: true }),
  ).toBeVisible();
  const reviewButton = recovery.getByRole("button", {
    name: "Review selected failed changes",
  });
  await expect(reviewButton).toBeFocused();
  expect(
    await page.evaluate(() =>
      window.__POSTAL_SNAP_TEST__!.ipcCalls.some(
        (call) => call.command === "dismiss_failed_offline_operations",
      ),
    ),
  ).toBe(false);

  await recovery
    .getByRole("button", { name: "Review selected failed changes" })
    .click();
  await page.evaluate(() => {
    const mock = window.__POSTAL_SNAP_MOCK__! as OfflineFixtureMock;
    mock.offlineFixture.failAgain("account-2", {
      id: 101,
      kind: "copy",
      state: "needs_attention",
      reviewToken: "review-account-2-101-v2",
      payload: "REPLACED_PRIVATE_SUBJECT new@example.test",
    });
    mock.offlineFixture.add("account-2", {
      id: 103,
      kind: "flags",
      state: "needs_attention",
      reviewToken: "review-account-2-103-v1",
      payload: "NEW_PRIVATE_SUBJECT",
    });
    mock.offlineFixture.add("account-2", {
      id: 104,
      kind: "keyword",
      state: "queued",
      reviewToken: "",
      payload: "QUEUED_PRIVATE_SUBJECT",
    });
  });
  await confirmation
    .getByRole("button", { name: "Dismiss reviewed changes" })
    .click();

  await expect(
    recovery.getByText("Copy · change 101", { exact: true }),
  ).toBeVisible();
  await expect(
    recovery.getByText("Flag change · change 103", { exact: true }),
  ).toBeVisible();
  await expect(recovery.getByRole("alert")).toContainText(
    "could not be dismissed",
  );
  await expect(recovery).not.toContainText("REPLACED_PRIVATE_SUBJECT");

  await recovery.getByRole("checkbox", { name: "Copy · change 101" }).check();
  await recovery
    .getByRole("button", { name: "Review selected failed changes" })
    .click();
  await page.evaluate(() => {
    const mock = window.__POSTAL_SNAP_MOCK__! as OfflineFixtureMock;
    mock.offlineFixture.add("account-2", {
      id: 105,
      kind: "keyword",
      state: "needs_attention",
      reviewToken: "review-account-2-105-v1",
      payload: "UNSEEN_PRIVATE_SUBJECT",
    });
    mock.offlineFixture.add("account-2", {
      id: 106,
      kind: "flags",
      state: "queued",
      reviewToken: "",
      payload: "QUEUED_PRIVATE_SUBJECT_2",
    });
  });
  const currentConfirmation = page.getByRole("alertdialog", {
    name: "Dismiss failed local changes?",
  });
  await currentConfirmation
    .getByRole("button", { name: "Dismiss reviewed changes" })
    .click();

  await expect(
    recovery.getByText("Copy · change 101", { exact: true }),
  ).toHaveCount(0);
  await expect(
    recovery.getByText("Flag change · change 103", { exact: true }),
  ).toBeVisible();
  await expect(recovery).not.toContainText("NEW_PRIVATE_SUBJECT");
  await expect(recovery).not.toContainText("UNSEEN_PRIVATE_SUBJECT");
  await expect(
    recovery.getByText("Dismissed 1 failed local change.", { exact: true }),
  ).toBeVisible();
  await expect(
    recovery.getByRole("heading", { name: "Connection recovery" }),
  ).toBeFocused();
  await expect(server).toHaveValue("imap.edited.example");
  await testInfo.attach("offline-attention-after-dismissal", {
    body: await recovery.screenshot(),
    contentType: "image/png",
  });

  const snapshot = await page.evaluate(() =>
    (
      window.__POSTAL_SNAP_MOCK__! as OfflineFixtureMock
    ).offlineFixture.snapshot("account-2"),
  );
  expect(snapshot).toMatchObject({
    dismissedIds: [101],
    unsentMessages: 1,
    operations: [
      { id: 102, state: "queued" },
      { id: 103, state: "needs_attention" },
      { id: 104, state: "queued" },
      { id: 105, state: "needs_attention" },
      { id: 106, state: "queued" },
    ],
  });
  const connection = await page.evaluate(() =>
    window.__POSTAL_SNAP_MOCK__!.handlers.get_account_connection({
      accountId: "account-2",
    }),
  );
  expect(connection).toMatchObject({
    blockers: { queuedChanges: 5, unsentMessages: 1 },
  });

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Back to accounts" }).click();
  await page.getByRole("button", { name: /^Manage Sam\b/ }).click();
  const samRecovery = page.getByRole("region", {
    name: "Connection recovery",
  });
  await expect(
    samRecovery.getByText("Keyword change · change 201", { exact: true }),
  ).toBeVisible();
  await expect(
    samRecovery.getByText("Flag change · change 103", { exact: true }),
  ).toHaveCount(0);

  const remoteWriteCommands = await page.evaluate(() => {
    const writes = new Set([
      "move_message",
      "move_message_to_mailbox",
      "copy_message_to_mailbox",
      "copy_messages_to_mailbox",
      "set_message_flags",
      "set_messages_flags",
      "send_outbox_now",
      "retry_outbox_message",
    ]);
    return window
      .__POSTAL_SNAP_TEST__!.ipcCalls.map((call) => call.command)
      .filter((command) => writes.has(command));
  });
  expect(remoteWriteCommands).toEqual([]);

  await page.reload({ waitUntil: "domcontentloaded" });
  await openAccount(page, "Work");
  const afterRestart = page.getByRole("region", {
    name: "Connection recovery",
  });
  await expect(
    afterRestart.getByText("Flag change · change 103", { exact: true }),
  ).toBeVisible();
  await expect(
    afterRestart.getByText("Move · change 101", { exact: true }),
  ).toHaveCount(0);
  await expect(
    afterRestart.getByText("Keyword change · change 105", { exact: true }),
  ).toBeVisible();
});

test("failed change list errors are redacted and retry loads the account list", async ({
  page,
}) => {
  await page.goto("/?multiAccount=1&offlineAttentionRecovery=1");
  await page.evaluate(() => {
    type RetryState = {
      account2Attempts: number;
      failures: number;
      retryAllowed: boolean;
    };
    const target = window as Window & { __offlineRetryState?: RetryState };
    const retryState: RetryState = {
      account2Attempts: 0,
      failures: 0,
      retryAllowed: false,
    };
    target.__offlineRetryState = retryState;
    const mock = window.__POSTAL_SNAP_MOCK__!;
    const list = mock.handlers.get_failed_offline_operations;
    mock.handlers.get_failed_offline_operations = (args) => {
      if (args.accountId === "account-2") {
        retryState.account2Attempts += 1;
      }
      if (args.accountId === "account-2" && !retryState.retryAllowed) {
        retryState.failures += 1;
        throw mock.mockError(
          "operationFailed",
          "PRIVATE_MAILBOX_PATH /users/reader@example.test/cache",
        );
      }
      return list(args);
    };
  });

  await openAccount(page, "Work");
  const recovery = page.getByRole("region", { name: "Connection recovery" });
  const error = recovery.getByRole("alert");
  await expect(error).toContainText("Could not load failed local changes.");
  await expect(error).not.toContainText("PRIVATE_MAILBOX_PATH");
  await expect(error).not.toContainText("reader@example.test");
  await page.evaluate(() => {
    const state = (
      window as Window & {
        __offlineRetryState?: { retryAllowed: boolean };
      }
    ).__offlineRetryState;
    if (!state) throw new Error("Retry fixture state is missing.");
    state.retryAllowed = true;
  });
  await recovery
    .getByRole("button", { name: "Refresh failed changes" })
    .click();
  await expect(
    recovery.getByText("Move · change 101", { exact: true }),
  ).toBeVisible();

  const attempts = await page.evaluate(
    () =>
      (
        window as Window & {
          __offlineRetryState?: {
            account2Attempts: number;
            failures: number;
            retryAllowed: boolean;
          };
        }
      ).__offlineRetryState,
  );
  expect(attempts?.retryAllowed).toBe(true);
  expect(attempts?.failures).toBeGreaterThanOrEqual(1);
  expect(attempts?.account2Attempts).toBe(attempts!.failures + 1);
});

test("a stale failed-list rejection cannot replace the selected account list", async ({
  page,
}) => {
  await page.goto("/?multiAccount=1&offlineAttentionRecovery=1");
  await page.evaluate(() => {
    type Gate = { started: boolean; reject?: (cause: unknown) => void };
    const target = window as Window & { __offlineListGate?: Gate };
    const gate: Gate = { started: false };
    target.__offlineListGate = gate;
    const mock = window.__POSTAL_SNAP_MOCK__!;
    const list = mock.handlers.get_failed_offline_operations;
    mock.handlers.get_failed_offline_operations = (args) => {
      if (args.accountId === "account-2" && !gate.started) {
        gate.started = true;
        return new Promise((_, reject) => {
          gate.reject = reject;
        });
      }
      return list(args);
    };
  });

  await openAccount(page, "Work");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __offlineListGate?: { started: boolean } })
            .__offlineListGate?.started ?? false,
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Back to accounts" }).click();
  await page.getByRole("button", { name: /^Manage Sam\b/ }).click();
  const samRecovery = page.getByRole("region", {
    name: "Connection recovery",
  });
  await expect(
    samRecovery.getByText("Keyword change · change 201", { exact: true }),
  ).toBeVisible();

  await page.evaluate(() => {
    type Gate = { reject?: (cause: unknown) => void };
    const gate = (window as Window & { __offlineListGate?: Gate })
      .__offlineListGate;
    if (!gate?.reject) throw new Error("The stale list request was not held.");
    gate.reject(
      window.__POSTAL_SNAP_MOCK__!.mockError(
        "operationFailed",
        "STALE_PRIVATE_MAILBOX_PATH /users/work@example.test/cache",
      ),
    );
  });
  await expect(
    samRecovery.getByText("Keyword change · change 201", { exact: true }),
  ).toBeVisible();
  await expect(samRecovery.getByRole("alert")).toHaveCount(0);
  await expect(samRecovery).not.toContainText("STALE_PRIVATE_MAILBOX_PATH");
  await expect(
    samRecovery.getByText("Move · change 101", { exact: true }),
  ).toHaveCount(0);
});

test("hides recovery guidance when an account has no failed local changes", async ({
  page,
}) => {
  await page.goto(
    "/?multiAccount=1&offlineAttentionRecovery=1&offlineNoFailures=1",
  );
  await openAccount(page, "Work");
  const recovery = page.getByRole("region", {
    name: "Connection recovery",
  });
  await expect(recovery).toHaveCount(0);
});

for (const density of ["normal", "comfortable", "compact"] as const) {
  test(`connection recovery works at 200% text in ${density} density`, async ({
    page,
  }, testInfo) => {
    await page.goto(
      `/?multiAccount=1&offlineAttentionRecovery=1&scale=2&density=${density}`,
    );
    await openAccount(page, "Work");
    const recovery = page.getByRole("region", {
      name: "Connection recovery",
    });
    await expect(
      recovery.getByText("Move · change 101", { exact: true }),
    ).toBeVisible();
    const checkbox = recovery.getByRole("checkbox", {
      name: "Move · change 101",
    });
    await checkbox.focus();
    await expect(checkbox).toBeFocused();
    expect(
      await recovery.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    mkdirSync("artifacts/0.5.4/offline", { recursive: true });
    const screenshotPath = join(
      "artifacts/0.5.4/offline",
      `connection-recovery-${density}-200.png`,
    );
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach(`connection-recovery-${density}-200`, {
      path: screenshotPath,
      contentType: "image/png",
    });
  });
}
