import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here (docs/0.5.0-FAILURE-INVENTORY.md, section A):
// A11. A bulk move is undone as one group, so Undo restores every message in it.
// A17. A second move commits the first undo window, so only the latest move can be undone.
// B8. Mod+Z in a text field edits text and does not undo a move.

const VIEWPORT = { width: 1280, height: 900 };
const combos = [
  { density: "comfortable", scale: 1 },
  { density: "compact", scale: 1 },
  { density: "comfortable", scale: 2 },
  { density: "compact", scale: 2 },
] as const;

const BULK_PAIR = [/Urgent: server maintenance/i, /Receipt and tickets/i];

async function openRowMix(page: Page, query: string) {
  await installMockIpc(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto(`/?rowMix=1&${query}`);
  await expect(
    page.getByRole("treeitem", { name: /Urgent: server maintenance/i }),
  ).toBeVisible();
}

async function calls(page: Page, command: string) {
  return page.evaluate(
    (name) =>
      window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
        (call) => call.command === name,
      ) ?? [],
    command,
  );
}

async function lastCall(page: Page, command: string) {
  const all = await calls(page, command);
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1];
}

async function expectAxeClean(page: Page) {
  const scan = await new AxeBuilder({ page })
    .include(".notice-region")
    .analyze();
  expect(
    scan.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
}

async function bulkArchive(page: Page, names: RegExp[]) {
  await page.getByRole("button", { name: "Select", exact: true }).click();
  for (const name of names) {
    await page.getByRole("checkbox", { name }).check();
  }
  await page.locator(".bulk-bar").getByRole("button").first().click();
  for (const name of names) {
    await expect(page.getByRole("treeitem", { name })).toBeHidden();
  }
}

for (const { density, scale } of combos) {
  const label = `${density} ${scale * 100}%`;
  const query = `density=${density}&scale=${scale}`;
  const slug = `${density}-${scale * 100}`;

  test(`bulk move then Undo restores every message in the group, ${label}`, async ({
    page,
  }, testInfo: TestInfo) => {
    await openRowMix(page, query);
    await bulkArchive(page, BULK_PAIR);
    const notice = page.locator(".notice", {
      hasText: "Archived 2 messages.",
    });
    await expect(notice).toBeVisible();

    await notice.getByRole("button", { name: "Undo" }).click();
    for (const name of BULK_PAIR) {
      await expect(page.getByRole("treeitem", { name })).toBeVisible();
    }
    await expect(
      page.locator(".notice", { hasText: "2 messages restored." }),
    ).toBeVisible();
    const moved = await lastCall(page, "move_messages_to_mailbox");
    const undone = await lastCall(page, "undo_deferred");
    expect(undone.args).toMatchObject({
      accountId: "account-1",
      undoToken: moved.args.undoToken,
    });
    expect(await calls(page, "commit_deferred")).toHaveLength(0);
    await expectAxeClean(page);
    await attachArtifacts(page, testInfo, `undo-bulk-${slug}`);
  });

  test(`a second move commits the first undo window, ${label}`, async ({
    page,
  }, testInfo: TestInfo) => {
    await openRowMix(page, query);
    await bulkArchive(page, BULK_PAIR);
    const bulk = await lastCall(page, "move_messages_to_mailbox");
    await expect(
      page.locator(".notice", { hasText: "Archived 2 messages." }),
    ).toBeVisible();

    const next = page.getByRole("treeitem", {
      name: /Team calendar invitation/i,
    });
    await next.focus();
    await page.keyboard.press("e");
    await expect(next).toBeHidden();
    await expect(
      page.locator(".notice", { hasText: "Archived 1 message." }),
    ).toBeVisible();
    await expect(page.locator(".notice")).toHaveCount(1);

    const committed = await calls(page, "commit_deferred");
    expect(committed).toHaveLength(1);
    expect(committed[0].args).toMatchObject({
      accountId: "account-1",
      undoToken: bulk.args.undoToken,
    });
    expect(await calls(page, "undo_deferred")).toHaveLength(0);
    await attachArtifacts(page, testInfo, `second-move-commits-${slug}`);
  });
}

test("Mod+Z undoes the latest move, and not while typing", async ({
  page,
}, testInfo: TestInfo) => {
  await openRowMix(page, "density=comfortable&scale=1");
  const next = page.getByRole("treeitem", {
    name: /Team calendar invitation/i,
  });
  await next.focus();
  await page.keyboard.press("e");
  await expect(next).toBeHidden();
  await expect(
    page.locator(".notice", { hasText: "Archived 1 message." }),
  ).toBeVisible();

  await page.getByRole("searchbox", { name: "Search mail" }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  expect(await calls(page, "undo_deferred")).toHaveLength(0);
  await expect(
    page.locator(".notice", { hasText: "Archived 1 message." }),
  ).toBeVisible();

  await page
    .getByRole("treeitem", { name: /Urgent: server maintenance/i })
    .focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(next).toBeVisible();
  expect(await calls(page, "undo_deferred")).toHaveLength(1);
  await attachArtifacts(page, testInfo, "undo-mod-z");
});
