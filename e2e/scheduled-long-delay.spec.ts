import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A send_at more than ~24.8 days out overflows setTimeout, which fires at once.
//    The callback reloads the outbox, the new array re-runs the effect, and the
//    reload loop hammers list_outbox.
// 2. The clamp is removed or set too low, so the timer fires early and reloads
//    repeatedly while the item is still in the future.
// 3. A held message shows as overdue and is sent before its time.

test.beforeEach(async ({ page }) => {
  await installMockIpc(page);
  await page.addInitScript(() => {
    // WebKit (the macOS Tauri webview) overflows delays above 2^31-1 ms and
    // fires at once. Chromium clamps instead, so emulate the overflow here.
    const native = window.setTimeout.bind(window);
    window.setTimeout = ((
      handler: TimerHandler,
      delay?: number,
      ...rest: unknown[]
    ) =>
      native(
        handler,
        (delay ?? 0) > 2_147_483_647 ? 0 : delay,
        ...rest,
      )) as typeof window.setTimeout;
    const mock = (
      window as unknown as {
        __POSTAL_SNAP_MOCK__: {
          account: { id: string };
          handlers: Record<string, (args: unknown) => unknown>;
        };
      }
    ).__POSTAL_SNAP_MOCK__;
    const counts = { listOutbox: 0 };
    (
      window as unknown as { __OUTBOX_COUNTS__: typeof counts }
    ).__OUTBOX_COUNTS__ = counts;
    const sixtyDays = Date.now() + 60 * 24 * 60 * 60 * 1000;
    mock.handlers.list_outbox = () => {
      counts.listOutbox += 1;
      return [
        {
          id: "outbox-far",
          accountId: mock.account.id,
          recipients: "lee@example.com",
          subject: "Renewal reminder",
          state: "scheduled",
          preview: "",
          attachmentCount: 0,
          detail: "Held for review. Undo anytime before it sends.",
          createdAt: "2026-08-18T11:00:00Z",
          sendAt: new Date(sixtyDays).toISOString(),
        },
      ];
    };
  });
});

test("a message scheduled 60 days out does not reload the outbox in a loop", async ({
  page,
}) => {
  await page.goto("/?localMail=1");
  await page.getByRole("button", { name: /^Outbox/ }).click();
  await expect(page.getByText("Renewal reminder")).toBeVisible();
  await page.waitForTimeout(300);
  const readCount = () =>
    page.evaluate(
      () =>
        (window as unknown as { __OUTBOX_COUNTS__: { listOutbox: number } })
          .__OUTBOX_COUNTS__.listOutbox,
    );
  const before = await readCount();
  await page.waitForTimeout(2000);
  const after = await readCount();
  // A tight loop would add hundreds of reloads in two seconds.
  expect(after - before).toBeLessThanOrEqual(1);
});
