import { expect, test } from "./coverage-fixture";
import { attachIpcLog, recordIpc } from "./ipc-recorder";
import { installMockIpc } from "./mock-ipc";

// A stored reason code must show localized guidance even with no legacy
// detail. An uncertain send must keep explicit retry and never imply delivery.
test("outbox explains an uncertain send from its reason code", async ({
  page,
}, testInfo) => {
  await installMockIpc(page);
  await recordIpc(page);
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__;
    if (!mock) throw new Error("Mock IPC was not installed");
    const list = mock.handlers.list_outbox;
    mock.handlers.list_outbox = (args) =>
      (list(args) as Record<string, unknown>[]).map((item) => ({
        ...item,
        state: "needs_attention",
        detail: null,
        reasonCode: "deliveryUncertain",
      }));
  });
  await page.goto("/?localMail=1");
  await page.getByRole("button", { name: /^Outbox(?: \d+)?$/ }).click();
  await expect(
    page.getByText(
      "Delivery of this message could not be confirmed. Postal Snap will not resend automatically.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry sending", exact: true }),
  ).toBeVisible();
  await attachIpcLog(page, testInfo);
});
