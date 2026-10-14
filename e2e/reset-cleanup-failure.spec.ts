import { expect, test } from "./coverage-fixture";
import { attachIpcLog, recordIpc, recordedCalls } from "./ipc-recorder";
import { installMockIpc } from "./mock-ipc";

// An incomplete reset must keep its failure visible instead of restarting
// into setup and implying local storage cleanup finished.
test("reset cleanup failure stays visible without restart", async ({
  page,
}, testInfo) => {
  await installMockIpc(page);
  await recordIpc(page);
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__;
    if (!mock) throw new Error("Mock IPC was not installed");
    mock.handlers.erase_all_data = () => {
      throw new Error(
        "Accounts were removed, but local storage cleanup is still pending. Restart Postal Snap to retry.",
      );
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page
    .getByRole("button", { name: "Reset & Restart", exact: true })
    .click();
  await expect(
    page.getByText("Reset did not finish. Try again.", { exact: true }),
  ).toBeVisible();
  expect((await recordedCalls(page)).map((call) => call.command)).not.toContain(
    "relaunch_app",
  );
  await attachIpcLog(page, testInfo);
});
