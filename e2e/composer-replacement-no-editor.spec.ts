import { expect, test } from "./coverage-fixture";
import {
  attachIpcLog,
  emitTauriEvent,
  recordIpc,
  recordedCalls,
} from "./ipc-recorder";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. The composer chunk is still loading, so an open composer has no editor.
//    A mailto that arrives then must open at once, not wait and then fail.
// 2. Nothing is saved for an editor that never mounted, so no save_draft runs.
// 3. The mailto composer still appears once the chunk arrives.

test("a replacement with no editor yet opens at once without a save", async ({
  page,
}, testInfo) => {
  await installMockIpc(page);
  await recordIpc(page);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let requested = 0;
  await page.route("**/src/components/Composer.tsx*", async (route) => {
    requested += 1;
    await gate;
    await route.continue();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await expect(page.getByText("Opening editor…")).toBeVisible();
  await expect.poll(() => requested).toBeGreaterThan(0);

  await emitTauriEvent(page, "deep-link://new-url", [
    "mailto:late@example.test?subject=Replacement",
  ]);
  // Hold the chunk past the registration wait, so a wait-then-fail shows here.
  await page.waitForTimeout(2_500);
  await expect(
    page.getByRole("alert").filter({
      hasText: "Could not save the open message",
    }),
  ).toHaveCount(0);

  release();
  await expect(
    page.getByRole("textbox", { name: "Subject", exact: true }),
  ).toHaveValue("Replacement");
  const saves = (await recordedCalls(page)).filter(
    (call) => call.command === "save_draft",
  );
  expect(saves).toHaveLength(0);
  await attachIpcLog(page, testInfo);
});
