import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { revealMenuItem } from "./menu-reveal";
import { attachArtifactsAfterEach } from "./ipc";

test.beforeEach(async ({ page }) => installMockIpc(page));
test.afterEach(attachArtifactsAfterEach);

async function openWeekend(page: Page, query = "") {
  await page.goto(query ? `/?${query}` : "/");
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
}

async function openSenderRulesAction(page: Page, name: string) {
  await page.getByRole("button", { name: "More actions" }).click();
  await revealMenuItem(page, name);
  return page.getByRole("menuitem", { name, exact: true });
}

test("canceling Block domain keeps the message and rules unchanged", async ({
  page,
}) => {
  await openWeekend(page, "junkFolder=1");
  let confirmation = "";
  page.once("dialog", (dialog) => {
    confirmation = dialog.message();
    void dialog.dismiss();
  });
  await (await openSenderRulesAction(page, "Block domain")).click();

  expect(confirmation).toContain("example.com");
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  const state = await page.evaluate(() => ({
    rules: window.__POSTAL_SNAP_TEST__!.rules,
    actions: window
      .__POSTAL_SNAP_TEST__!.ipcCalls.map((call) => call.command)
      .filter((command) =>
        [
          "create_filter_rule",
          "move_message",
          "move_message_to_mailbox",
        ].includes(command),
      ),
  }));
  expect(state.rules).toEqual([]);
  expect(state.actions).toEqual([]);
});

test("a stale Block domain confirmation cannot act on a newly selected message", async ({
  page,
}) => {
  await openWeekend(page, "threadGap=1&junkFolder=1");
  await page.evaluate(() => {
    type Gate = { started: boolean; resolve?: (confirmed: boolean) => void };
    const target = window as Window & { __readerConfirmGate?: Gate };
    const gate: Gate = { started: false };
    target.__readerConfirmGate = gate;
    window.__POSTAL_SNAP_MOCK__!.handlers.show_native_confirm = () =>
      new Promise<boolean>((resolve) => {
        gate.started = true;
        gate.resolve = resolve;
      });
  });

  await (await openSenderRulesAction(page, "Block domain")).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __readerConfirmGate?: { started: boolean };
            }
          ).__readerConfirmGate?.started ?? false,
      ),
    )
    .toBe(true);
  await page
    .getByRole("option", { name: /Library hours/i })
    .or(page.getByRole("treeitem", { name: /Library hours/i }))
    .click();
  await expect(
    page.getByRole("heading", { name: "Library hours" }),
  ).toBeVisible();
  await page.evaluate(() => {
    const gate = (
      window as Window & {
        __readerConfirmGate?: { resolve?: (confirmed: boolean) => void };
      }
    ).__readerConfirmGate;
    if (!gate?.resolve) throw new Error("Block confirmation was not held.");
    gate.resolve(true);
  });

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__POSTAL_SNAP_TEST__!.ipcCalls.filter((call) =>
            [
              "create_filter_rule",
              "move_message",
              "move_message_to_mailbox",
            ].includes(call.command),
          ).length,
      ),
    )
    .toBe(0);
  await expect(
    page.getByRole("heading", { name: "Library hours" }),
  ).toBeVisible();
  await expect(
    page.getByText("Could not block the sender domain."),
  ).toHaveCount(0);
});

test("blocking then unblocking a domain creates and removes its scoped rule", async ({
  page,
}) => {
  await openWeekend(page, "inJunk=1");
  await expect(page.getByText("This message is in Junk.")).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  await (await openSenderRulesAction(page, "Block domain")).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();

  const created = await page.evaluate(() => ({
    rules: window.__POSTAL_SNAP_TEST__!.rules,
    calls: window.__POSTAL_SNAP_TEST__!.ipcCalls.filter(
      (call) => call.command === "create_filter_rule",
    ),
  }));
  expect(created.calls).toHaveLength(1);
  expect(created.calls[0].args.rule).toMatchObject({
    accountId: "account-1",
    field: "domain",
    contains: "example.com",
    action: "move_junk",
    conditions: [{ field: "domain", value: "example.com" }],
  });
  expect(created.rules).toEqual([
    expect.objectContaining({
      id: "rule-1",
      accountId: "account-1",
      field: "domain",
      contains: "example.com",
    }),
  ]);

  const unblock = await openSenderRulesAction(page, "Unblock domain");
  await expect(unblock).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await unblock.click();

  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__POSTAL_SNAP_TEST__!.ipcCalls.filter(
            (call) => call.command === "move_message_to_mailbox",
          ).length,
      ),
    )
    .toBe(1);
  const removed = await page.evaluate(() => ({
    rules: window.__POSTAL_SNAP_TEST__!.rules,
    deletes: window.__POSTAL_SNAP_TEST__!.ipcCalls.filter(
      (call) => call.command === "delete_filter_rule",
    ),
    inboxMove: window.__POSTAL_SNAP_TEST__!.ipcCalls.find(
      (call) => call.command === "move_message_to_mailbox",
    ),
  }));
  expect(removed.deletes).toHaveLength(1);
  expect(removed.deletes[0].args).toMatchObject({
    accountId: "account-1",
    ruleId: "rule-1",
  });
  expect(removed.rules).toEqual([]);
  expect(removed.inboxMove?.args).toMatchObject({
    accountId: "account-1",
    messageId: 10,
    destinationMailboxId: 1,
  });
});

test("unblocking a domain removes only its rule and returns Junk mail to Inbox", async ({
  page,
}) => {
  await page.goto("/?inJunk=1");
  await page.evaluate(() => {
    window.__POSTAL_SNAP_TEST__!.rules.push(
      {
        id: "domain-example",
        accountId: "account-1",
        name: "Block example.com",
        field: "domain",
        contains: "example.com",
        action: "move_junk",
        targetMailbox: null,
        enabled: true,
        matchMode: "all",
        conditions: [{ field: "domain", value: "example.com" }],
        actions: [{ kind: "move_junk", targetMailbox: null, flagColor: null }],
      },
      {
        id: "unrelated-rule",
        accountId: "account-1",
        name: "Keep another sender rule",
        field: "from",
        contains: "other@example.test",
        action: "move_archive",
        targetMailbox: null,
        enabled: true,
      },
    );
  });
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(page.getByText("This message is in Junk.")).toBeVisible();
  const unblock = await openSenderRulesAction(page, "Unblock domain");
  await expect(unblock).toBeVisible();

  let confirmation = "";
  page.once("dialog", (dialog) => {
    confirmation = dialog.message();
    void dialog.accept();
  });
  await unblock.click();

  expect(confirmation).toContain(
    "Move this message to Inbox. Future messages from example.com can stay in Inbox.",
  );
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toHaveCount(0);
  const state = await page.evaluate(() => ({
    rules: window.__POSTAL_SNAP_TEST__!.rules,
    deletes: window.__POSTAL_SNAP_TEST__!.ipcCalls.filter(
      (call) => call.command === "delete_filter_rule",
    ),
    inboxMove: window.__POSTAL_SNAP_TEST__!.ipcCalls.find(
      (call) => call.command === "move_message_to_mailbox",
    ),
  }));
  expect(state.deletes).toHaveLength(1);
  expect(state.deletes[0].args).toMatchObject({
    accountId: "account-1",
    ruleId: "domain-example",
  });
  expect(state.rules.map((rule) => rule.id)).toEqual(["unrelated-rule"]);
  expect(state.inboxMove?.args).toMatchObject({
    accountId: "account-1",
    messageId: 10,
    destinationMailboxId: 1,
  });
});
