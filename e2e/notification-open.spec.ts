import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import {
  attachArtifacts,
  attachArtifactsAfterEach,
  emitTauriEvent,
  ipcCalls,
} from "./ipc";

test.afterEach(attachArtifactsAfterEach);

// Failure modes covered here:
// FM1. A notification for another account and folder opens that exact message
//      and switches the active account; nothing from Weekend plans stays open.
// FM2. A notification for an unknown account is ignored: no error, no IPC.
// FM3. The per-account toggle sends set_account_notifications with the right
//      account and value, and the state survives closing and reopening Settings.
// FM4. Each per-account switch has an accessible name that includes its account.
// FM5. The per-account switch toggles with the keyboard (Space).
// FM6. A failed save rolls the switch back and shows the error.

test.beforeEach(async ({ page }) => installMockIpc(page));

async function openNotificationsTab(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Notifications" }).click();
}

function workSwitch(page: import("@playwright/test").Page) {
  return page.getByRole("checkbox", { name: /Notify for new mail: Work/ });
}

test("a notification opens its message in the other account", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/?multiAccount=1");
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  await emitTauriEvent(page, "notification-open", {
    accountId: "account-2",
    messageId: 20,
  });
  await expect(
    page.getByRole("heading", { name: "Team launch" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toHaveCount(0);
  const calls = await ipcCalls(page);
  expect(
    calls.some(
      (call) =>
        call.command === "get_message" &&
        (call.args as { accountId?: string; messageId?: number }).accountId ===
          "account-2" &&
        (call.args as { messageId?: number }).messageId === 20,
    ),
  ).toBe(true);
  await attachArtifacts(page, testInfo, "fm1-cross-account");
});

test("a notification for an unknown account is ignored", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/?multiAccount=1");
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  await emitTauriEvent(page, "notification-open", {
    accountId: "ghost-account",
    messageId: 20,
  });
  // Let the listener run before checking that nothing happened.
  await page.waitForTimeout(300);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Team launch" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("option", { name: /Weekend plans/i }),
  ).toBeVisible();
  const calls = await ipcCalls(page);
  expect(
    calls.some(
      (call) =>
        (call.args as { accountId?: string } | undefined)?.accountId ===
        "ghost-account",
    ),
  ).toBe(false);
  await attachArtifacts(page, testInfo, "fm2-unknown-account");
});

test("the per-account switch saves and keeps its state after reopening Settings", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/?multiAccount=1");
  await openNotificationsTab(page);
  const work = workSwitch(page);
  await expect(work).toBeChecked();
  await work.click();
  await expect(work).not.toBeChecked();
  const saved = (await ipcCalls(page)).filter(
    (call) => call.command === "set_account_notifications",
  );
  expect(saved).toEqual([
    {
      command: "set_account_notifications",
      args: { accountId: "account-2", enabled: false },
    },
  ]);
  await page.keyboard.press("Escape");
  await openNotificationsTab(page);
  await expect(workSwitch(page)).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: /Notify for new mail: Sam/ }),
  ).toBeChecked();
  await attachArtifacts(page, testInfo, "fm3-toggle-saved");
});

test("each per-account switch name includes its account", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/?multiAccount=1");
  await openNotificationsTab(page);
  await expect(workSwitch(page)).toHaveAccessibleName(
    /Notify for new mail: Work/,
  );
  await expect(
    page.getByRole("checkbox", { name: /Notify for new mail: Sam/ }),
  ).toBeVisible();
  await attachArtifacts(page, testInfo, "fm4-accessible-names");
});

test("the per-account switch toggles with the keyboard", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/?multiAccount=1");
  await openNotificationsTab(page);
  const work = workSwitch(page);
  await work.focus();
  await expect(work).toBeFocused();
  await page.keyboard.press("Space");
  await expect(work).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(work).toBeChecked();
  const values = (await ipcCalls(page))
    .filter((call) => call.command === "set_account_notifications")
    .map((call) => (call.args as { enabled: boolean }).enabled);
  expect(values).toEqual([false, true]);
  await attachArtifacts(page, testInfo, "fm5-keyboard");
});

test("a failed save rolls the switch back and explains why", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/?multiAccount=1&notifyFail=1");
  await openNotificationsTab(page);
  const work = workSwitch(page);
  await work.click();
  await expect(page.getByRole("alert")).toContainText(
    "The notification setting could not be saved.",
  );
  await expect(work).toBeChecked();
  await attachArtifacts(page, testInfo, "fm6-rollback");
});
