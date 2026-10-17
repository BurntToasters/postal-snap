import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here (docs/0.5.0-FAILURE-INVENTORY.md, A19):
// - hover or focus lets a visible Undo action expire past the native deadline;
// - boot does not initialize the durable undo session before the first move;
// - the move token is not scoped to the session that owns its notice;
// - Undo after the long pause commits instead of restoring the message.

const VIEWPORT = { width: 1280, height: 900 };
const combos = [
  { density: "comfortable", scale: 1 },
  { density: "compact", scale: 1 },
  { density: "comfortable", scale: 2 },
  { density: "compact", scale: 2 },
] as const;

async function calls(page: import("@playwright/test").Page) {
  return page.evaluate(() => window.__POSTAL_SNAP_TEST__?.ipcCalls ?? []);
}

for (const { density, scale } of combos) {
  const label = `${density} ${scale * 100}%`;
  const slug = `${density}-${scale * 100}`;

  test(`Undo stays available beyond the native deadline while hovered or focused, ${label}`, async ({
    page,
  }, testInfo: TestInfo) => {
    test.setTimeout(60_000);
    await page.clock.install();
    await installMockIpc(page);
    await page.setViewportSize(VIEWPORT);
    await page.goto(`/?density=${density}&scale=${scale}`);

    const row = page.getByRole("option", { name: /Weekend plans/i });
    await expect(row).toBeVisible();
    const bootCalls = await calls(page);
    const sessionId = await page.evaluate(
      () => window.__POSTAL_SNAP_TEST__?.undoSession,
    );
    expect(sessionId).toMatch(/^[a-f0-9]{32}$/);
    const beginIndex = bootCalls.findIndex(
      (call) => call.command === "begin_undo_session",
    );
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(beginIndex).toBeLessThan(
      bootCalls.findIndex((call) => call.command === "list_accounts"),
    );

    await row.focus();
    await page.keyboard.press("e");
    await expect(row).toBeHidden();
    const notice = page.locator(".notice", {
      has: page.getByRole("button", { name: "Undo" }),
    });
    await expect(notice).toBeVisible();

    const moved = (await calls(page)).find(
      (call) => call.command === "move_message",
    );
    expect(moved?.args.undoToken).toMatch(/^[a-f0-9]{64}$/);
    expect(String(moved?.args.undoToken).slice(0, 32)).toBe(sessionId);
    const moveIndex = (await calls(page)).findIndex(
      (call) => call.command === "move_message",
    );
    expect(
      bootCalls.findIndex((call) => call.command === "begin_undo_session"),
    ).toBeLessThan(moveIndex);

    await notice.hover();
    await page.clock.fastForward(61_000);
    await expect(notice).toBeVisible();
    expect(
      (await calls(page)).filter((call) => call.command === "commit_deferred"),
    ).toHaveLength(0);

    await page.mouse.move(0, 0);
    const undo = notice.getByRole("button", { name: "Undo" });
    await undo.focus();
    await page.clock.fastForward(61_000);
    await expect(notice).toBeVisible();
    expect(
      (await calls(page)).filter((call) => call.command === "commit_deferred"),
    ).toHaveLength(0);

    await undo.click();
    await expect(row).toBeVisible();
    const undoCall = (await calls(page)).find(
      (call) => call.command === "undo_deferred",
    );
    expect(undoCall?.args).toMatchObject({
      accountId: "account-1",
      undoToken: moved?.args.undoToken,
    });
    expect(
      (await calls(page)).filter((call) => call.command === "undo_deferred"),
    ).toHaveLength(1);
    expect(
      (await calls(page)).filter((call) => call.command === "commit_deferred"),
    ).toHaveLength(0);

    const artifactDirectory = join(
      testInfo.config.rootDir,
      "..",
      "artifacts/0.5.0/fixes/undo-watcher",
    );
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(
      join(artifactDirectory, `undo-long-pause-${slug}-ipc-calls.json`),
      `${JSON.stringify(await calls(page), null, 2)}\n`,
    );
    await writeFile(
      join(artifactDirectory, `undo-long-pause-${slug}.png`),
      await page.screenshot(),
    );
    await attachArtifacts(page, testInfo, `undo-long-pause-${slug}`);
  });
}
