import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Raw source is rendered as HTML (script or handler runs).
// 2. The parsed header table is missing or the source is not shown.
// 3. Copy does not put the exact source on the clipboard.
// 4. Save .eml passes anything but ids (a path would be a fs escape).
// 5. Escape does not close the dialog or lose keyboard focus.

test.beforeEach(async ({ page }) => installMockIpc(page));

test("show original lists headers and shows source as inert text", async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  const more = page.getByRole("button", { name: "More actions" });
  await more.click();
  await page.getByRole("menuitem", { name: "Show original" }).click();

  const dialog = page.getByRole("dialog", { name: "Original message" });
  await expect(dialog).toBeVisible();
  const table = dialog.getByRole("table");
  await expect(
    table.getByRole("row", { name: /Subject\s+Weekend plans/ }),
  ).toBeVisible();
  await expect(
    table.getByRole("row", { name: /Message-ID\s+<weekend@example.com>/ }),
  ).toBeVisible();

  const source = dialog.locator("pre.original-source");
  await expect(source).toContainText("<script>window.__pwned = 1</script>");
  await expect(dialog.locator("script")).toHaveCount(0);
  await expect(dialog.locator("[onclick]")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { __pwned?: number }).__pwned,
    ),
  ).toBeUndefined();

  await dialog.getByRole("button", { name: "Copy source" }).click();
  await expect(dialog.getByRole("button", { name: "Copied!" })).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe(await source.innerText());
  expect(clipboard).toContain("Subject: Weekend plans");

  await dialog.getByRole("button", { name: "Save as .eml" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
            (call) => call.command === "save_message_eml",
          ) ?? [],
      ),
    )
    .toEqual([
      {
        command: "save_message_eml",
        args: { accountId: "account-1", messageId: 10 },
      },
    ]);
  const fetches = await page.evaluate(
    () =>
      window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
        (call) => call.command === "get_message_source",
      ) ?? [],
  );
  // Dev StrictMode may run the load effect twice.
  expect(fetches.length).toBeGreaterThan(0);
  for (const call of fetches) {
    expect(call.args).toEqual({ accountId: "account-1", messageId: 10 });
  }
  await attachArtifacts(page, testInfo, "message-source");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(more).toBeFocused();
});
