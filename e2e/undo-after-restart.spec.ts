import AxeBuilder from "@axe-core/playwright";
import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here (docs/0.5.0-FAILURE-INVENTORY.md, section A):
// A7. The app restarts inside the undo window. The archive stays put, is not
// replayed twice, and no Undo is offered for a notice the restart erased.

const VIEWPORT = { width: 1280, height: 900 };
const combos = [
  { density: "comfortable", scale: 1 },
  { density: "compact", scale: 1 },
  { density: "comfortable", scale: 2 },
  { density: "compact", scale: 2 },
] as const;

for (const { density, scale } of combos) {
  const label = `${density} ${scale * 100}%`;
  const query = `density=${density}&scale=${scale}`;
  const slug = `${density}-${scale * 100}`;

  test(`an archive survives a restart inside the undo window, ${label}`, async ({
    page,
  }, testInfo: TestInfo) => {
    await installMockIpc(page);
    await page.setViewportSize(VIEWPORT);
    await page.goto(`/?${query}`);
    const row = page.getByRole("option", { name: /Weekend plans/i });
    await expect(row).toBeVisible();
    const originalSession = await page.evaluate(
      () => window.__POSTAL_SNAP_TEST__?.undoSession,
    );
    expect(originalSession).toMatch(/^[a-f0-9]{32}$/);
    await row.focus();
    await page.keyboard.press("e");
    await expect(row).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
              (call) => call.command === "move_message",
            ).length ?? 0,
        ),
      )
      .toBe(1);
    const originalCalls = await page.evaluate(
      () => window.__POSTAL_SNAP_TEST__?.ipcCalls ?? [],
    );
    const originalMove = originalCalls.find(
      (call) => call.command === "move_message",
    );
    expect(String(originalMove?.args.undoToken).slice(0, 32)).toBe(
      originalSession,
    );
    expect(
      originalCalls.findIndex((call) => call.command === "begin_undo_session"),
    ).toBeLessThan(
      originalCalls.findIndex((call) => call.command === "move_message"),
    );

    await page.reload();
    const restartedSession = await page.evaluate(
      () => window.__POSTAL_SNAP_TEST__?.undoSession,
    );
    expect(restartedSession).toMatch(/^[a-f0-9]{32}$/);
    expect(restartedSession).not.toBe(originalSession);
    const restartCalls = await page.evaluate(
      () => window.__POSTAL_SNAP_TEST__?.ipcCalls ?? [],
    );
    expect(
      restartCalls.findIndex((call) => call.command === "begin_undo_session"),
    ).toBeLessThan(
      restartCalls.findIndex((call) => call.command === "list_accounts"),
    );
    await expect(page.getByRole("button", { name: /^Archive/ })).toContainText(
      "1",
    );
    await expect(row).toHaveCount(0);
    await page.getByRole("button", { name: /^Archive/ }).click();
    await expect(row).toBeVisible();

    await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(row).toBeVisible();
    const undoCalls = await page.evaluate(
      () =>
        window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
          (call) => call.command === "undo_deferred",
        ).length ?? 0,
    );
    expect(undoCalls).toBe(0);
    const scan = await new AxeBuilder({ page })
      .include("#message-pane")
      .analyze();
    expect(
      scan.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
    await attachArtifacts(page, testInfo, `undo-restart-${slug}`);
  });
}
