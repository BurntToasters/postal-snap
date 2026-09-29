import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import {
  attachIpcLog,
  emitTauriEvent,
  recordIpc,
  recordedCalls,
} from "./ipc-recorder";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A drop outside the composer, or with no composer open, attaches files.
// 2. A file path reaches the page: the UI only gets a position and a count.
// 3. The overlay never appears, or stays after the pointer leaves.
// 4. The overlay has no accessible text, or attach results are not announced.
// 5. Dropped files are not part of the saved draft.
// 6. A minimized composer or an empty drop attaches or errors.
// 7. The "Attach" button stops working once drop-in exists.
// The run ends with a screenshot and the recorded IPC calls.

test.beforeEach(async ({ page }) => {
  await installMockIpc(page);
  await recordIpc(page);
});

async function openComposer(page: Page, path = "/") {
  await page.goto(path);
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await expect(page.locator(".composer-window")).toBeVisible();
}

async function composerCenter(page: Page) {
  const box = await page.locator(".composer-window").boundingBox();
  if (!box) throw new Error("composer is not visible");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const drag = (
  page: Page,
  phase: "over" | "drop" | "leave",
  point: { x: number; y: number },
  count = 0,
) => emitTauriEvent(page, "compose-drag", { phase, ...point, count });

const dropCalls = async (page: Page) =>
  (await recordedCalls(page)).filter(
    (call) => call.command === "attach_dropped_files",
  );

test("dropping files on the composer attaches them by opaque token", async ({
  page,
}, testInfo) => {
  await openComposer(page);
  const inside = await composerCenter(page);
  const overlay = page.locator(".composer-drop-overlay");

  await drag(page, "over", inside, 2);
  await expect(overlay).toHaveAttribute("data-active", "true");
  const announcer = page.locator(".visually-hidden[aria-live]");
  await expect(announcer).toHaveText("Drop files here to attach them");
  await expect(overlay).toContainText("Drop files here to attach them");
  await drag(page, "leave", { x: 0, y: 0 });
  await expect(overlay).toHaveAttribute("data-active", "false");

  await drag(page, "over", inside, 2);
  await drag(page, "drop", inside, 2);
  await expect(overlay).toHaveAttribute("data-active", "false");
  const chips = page.locator(".compose-attachments");
  await expect(chips).toContainText("family-photo.jpg");
  await expect(chips).toContainText("notes.txt");
  await expect(announcer).toHaveText("2 files attached.");

  const calls = await dropCalls(page);
  expect(calls).toHaveLength(1);
  expect(calls[0].args).toEqual({ accountId: "account-1" });

  await page.keyboard.press("Meta+s");
  await expect
    .poll(async () =>
      (await recordedCalls(page)).some((call) => call.command === "save_draft"),
    )
    .toBe(true);
  const saved = (await recordedCalls(page)).find(
    (call) => call.command === "save_draft",
  )?.args as { draft: { attachments: Array<{ token: string }> } };
  expect(saved.draft.attachments.map((item) => item.token)).toEqual([
    "dropped-token-1",
    "dropped-token-2",
  ]);

  // No IPC argument or event payload the page handled names a path.
  const everything = JSON.stringify(await recordedCalls(page));
  expect(everything).not.toMatch(/"paths?"\s*:/);
  expect(everything).not.toMatch(/\/Users\/|[A-Z]:\\\\/);

  await page.screenshot({ path: "test-results/compose-drop.png" });
  await testInfo.attach("final.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await attachIpcLog(page, testInfo);
});

test("drops elsewhere are ignored", async ({ page }) => {
  // No composer: the mailbox ignores the drop.
  await page.goto("/");
  await drag(page, "drop", { x: 300, y: 300 }, 2);
  expect(await dropCalls(page)).toHaveLength(0);
  await expect(page.locator(".compose-attachments")).toHaveCount(0);

  // A composer is open but the pointer is off it.
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const box = await page.locator(".composer-window").boundingBox();
  expect(box).not.toBeNull();
  const outside = { x: 2, y: 2 };
  expect(outside.x < (box?.x ?? 0) || outside.y < (box?.y ?? 0)).toBe(true);
  await drag(page, "over", outside, 2);
  await expect(page.locator(".composer-drop-overlay")).toHaveAttribute(
    "data-active",
    "false",
  );
  await drag(page, "drop", outside, 2);
  expect(await dropCalls(page)).toHaveLength(0);
  await expect(page.locator(".compose-attachments")).toHaveCount(0);
});

test("a minimized composer ignores drops", async ({ page }) => {
  await openComposer(page);
  const inside = await composerCenter(page);
  await page.getByRole("button", { name: "Minimize draft" }).click();
  await drag(page, "drop", inside, 2);
  expect(await dropCalls(page)).toHaveLength(0);
  await page
    .getByRole("button", { name: /Restore editor/ })
    .first()
    .click();
  await expect(page.locator(".compose-attachments")).toHaveCount(0);
});

test("an empty drop attaches nothing and shows no error", async ({ page }) => {
  await openComposer(page, "/?dropEmpty=1");
  const inside = await composerCenter(page);
  await drag(page, "drop", inside, 0);
  await expect.poll(async () => (await dropCalls(page)).length).toBe(1);
  await expect(page.locator(".compose-attachments")).toHaveCount(0);
  await expect(page.locator(".error-toast")).toHaveCount(0);
});

test("the Attach button still works next to drop-in", async ({ page }) => {
  await openComposer(page, "/?pickFile=1");
  await page.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(page.locator(".compose-attachments")).toContainText(
    "budget.pdf",
  );
  const picks = (await recordedCalls(page)).filter(
    (call) => call.command === "choose_attachments",
  );
  expect(picks).toHaveLength(1);
});
