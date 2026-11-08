import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifacts } from "./ipc";

// Failure modes covered here (docs/0.5.0-FAILURE-INVENTORY.md, section F):
// F4  The dragged row unmounts mid-drag, so the drop is lost.
// The drag starts far from the top, and the list scrolls back to the top
// while the pointer is down. Each test ends with a screenshot and IPC calls.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  await attachArtifacts(page, testInfo, `list-virtual-drag-${slug}`);
});

// Scrolls until the named row is mounted, so it sits far from the top.
async function scrollToRow(page: Page, subject: string) {
  const list = page.locator(".message-list");
  const target = page.getByRole("option", { name: new RegExp(`${subject},`) });
  for (let step = 0; step < 200 && (await target.count()) === 0; step += 1) {
    await list.evaluate((node) => {
      node.scrollTop += node.clientHeight;
    });
    // Let the virtualizer mount the next window before probing again; the
    // loop must tolerate a busy machine under the full test:all gate.
    await page.evaluate(
      () =>
        new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
    );
  }
  await expect(target).toHaveCount(1, { timeout: 15_000 });
  await target.scrollIntoViewIfNeeded();
  return target;
}

async function movedCalls(page: Page) {
  return page.evaluate(() =>
    (window.__POSTAL_SNAP_TEST__?.ipcCalls ?? []).filter(
      (call) => call.command === "move_message_to_mailbox",
    ),
  );
}

test("a row far from the top drops onto a folder", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/?hugeList=1500&theme=light");
  await expect(page.getByRole("option").first()).toBeVisible();
  const far = await scrollToRow(page, "Archive note 700");
  const id = Number(await far.getAttribute("data-message-id"));
  expect(id).toBeGreaterThan(5300);

  await far.dragTo(page.getByRole("button", { name: "Archive" }));

  await expect
    .poll(async () => (await movedCalls(page)).length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const [moved] = await movedCalls(page);
  expect(moved?.args).toMatchObject({
    accountId: "account-1",
    messageId: id,
    destinationMailboxId: 2,
  });
});

test("a drag from the list opens the drawer at the left edge and drops on a folder", async ({
  page,
}) => {
  await page.setViewportSize({ width: 620, height: 720 });
  await page.goto("/?threadGap=1");
  const source = page.getByRole("treeitem", { name: /Weekend plans/i });
  await expect(source).toBeVisible();
  const from = await source.boundingBox();
  if (!from) throw new Error("Drag source geometry is missing.");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 12, from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(4, from.y + from.height / 2, { steps: 8 });
  await expect(page.locator(".mail-shell")).toHaveClass(/sidebar-open/);
  // The drawer slides in over 150 ms; measure only once it has settled.
  const archive = page
    .locator(".folder-pane")
    .getByRole("button", { name: "Archive" });
  await page
    .locator(".folder-pane")
    .evaluate((node) =>
      Promise.all(node.getAnimations().map((animation) => animation.finished)),
    );
  const folder = await archive.boundingBox();
  if (!folder) throw new Error("Folder geometry is missing.");
  await page.mouse.move(
    folder.x + folder.width / 2,
    folder.y + folder.height / 2,
    {
      steps: 8,
    },
  );
  await page.mouse.move(
    folder.x + folder.width / 2 + 1,
    folder.y + folder.height / 2,
  );
  await expect(archive).toHaveClass(/drop-target/);
  await page.mouse.up();

  await expect(page.locator(".mail-shell")).not.toHaveClass(/sidebar-open/);
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            (window.__POSTAL_SNAP_TEST__?.ipcCalls ?? []).filter(
              (call) => call.command === "move_messages_to_mailbox",
            ),
          )
        ).length,
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
});

test("the dragged row survives a scroll during the drag", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/?hugeList=1500&theme=light");
  const list = page.locator(".message-list");
  await expect(page.getByRole("option").first()).toBeVisible();
  const far = await scrollToRow(page, "Archive note 700");
  const id = Number(await far.getAttribute("data-message-id"));
  const target = page.getByRole("button", { name: "Archive" });

  const source = await far.boundingBox();
  const drop = await target.boundingBox();
  if (!source || !drop) throw new Error("Drag geometry is missing.");
  await page.mouse.move(
    source.x + source.width / 2,
    source.y + source.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    source.x + source.width / 2 + 12,
    source.y + source.height / 2 + 12,
    { steps: 4 },
  );
  // Unmounts the rows near the drag source if the list does not keep it.
  await list.evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.mouse.move(drop.x + drop.width / 2, drop.y + drop.height / 2, {
    steps: 8,
  });
  await page.mouse.up();

  await expect
    .poll(async () => (await movedCalls(page)).length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const [moved] = await movedCalls(page);
  expect(moved?.args).toMatchObject({ messageId: id, destinationMailboxId: 2 });
});
