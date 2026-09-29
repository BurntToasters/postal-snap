import type { Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachArtifacts, ipcCommands } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. One-click unsubscribe fires without a confirmation that names the host.
// 2. The frontend sends a URL to Rust (Rust must re-read the stored header).
// 3. Copy claims "unsubscribed" instead of "request sent"; a failure looks
//    like success.
// 4. mailto: sends mail on its own instead of opening a prefilled composer.
// 5. A plain https link skips the existing external-link confirmation.
// 6. Messages without a List-Unsubscribe header show the action.

test.beforeEach(async ({ page }) => installMockIpc(page));

async function openMore(page: Page, query: string) {
  await page.goto(`/${query}`);
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
}

test("one-click asks with the host first, then sends only ids", async ({
  page,
}, testInfo) => {
  let prompt = "";
  page.once("dialog", async (dialog) => {
    prompt = dialog.message();
    await dialog.accept();
  });
  await openMore(page, "?unsub=oneClick");
  await page.getByRole("menuitem", { name: /Unsubscribe/ }).click();
  const status = page.getByRole("status").filter({
    hasText: "Unsubscribe request sent",
  });
  await expect(status).toBeVisible();
  await expect(status).not.toContainText(/you are unsubscribed/i);
  const body = prompt.split("\n\n").slice(1);
  expect(body[0]).toBe("lists.example.test");
  const calls = await page.evaluate(
    () => window.__POSTAL_SNAP_TEST__?.ipcCalls ?? [],
  );
  const request = calls.find((c) => c.command === "unsubscribe_one_click");
  expect(request?.args).toEqual({ accountId: "account-1", messageId: 10 });
  expect(JSON.stringify(request)).not.toContain("https://");
  expect(await ipcCommands(page)).not.toContain("open_external_url");
  await attachArtifacts(page, testInfo, "unsubscribe-one-click");
});

test("declining the one-click prompt sends nothing", async ({
  page,
}, testInfo) => {
  page.once("dialog", (dialog) => void dialog.dismiss());
  await openMore(page, "?unsub=oneClick");
  await page.getByRole("menuitem", { name: /Unsubscribe/ }).click();
  await expect(page.getByText("Unsubscribe request sent")).toHaveCount(0);
  expect(await ipcCommands(page)).not.toContain("unsubscribe_one_click");
  await attachArtifacts(page, testInfo, "unsubscribe-declined");
});

test("a failed request is shown as an error, not as sent", async ({
  page,
}, testInfo) => {
  page.once("dialog", (dialog) => void dialog.accept());
  await openMore(page, "?unsub=oneClick&unsubFail=1");
  await page.getByRole("menuitem", { name: /Unsubscribe/ }).click();
  await expect(page.locator(".error-toast")).toContainText(
    "unsubscribe request was not sent",
  );
  await expect(page.getByText("Unsubscribe request sent")).toHaveCount(0);
  await attachArtifacts(page, testInfo, "unsubscribe-failed");
});

test("mailto opens a prefilled composer and sends nothing", async ({
  page,
}, testInfo) => {
  await openMore(page, "?unsub=mailto");
  await page.getByRole("menuitem", { name: /Unsubscribe/ }).click();
  await expect(
    page.getByRole("combobox", { name: "To", exact: true }),
  ).toHaveValue("leave-42@lists.example.test");
  await expect(page.getByRole("textbox", { name: "Subject" })).toHaveValue(
    "unsubscribe",
  );
  await expect(page.getByLabel("Message body")).toContainText(
    "Please remove me",
  );
  const commands = await ipcCommands(page);
  expect(commands).not.toContain("send_message");
  expect(commands).not.toContain("unsubscribe_one_click");
  await attachArtifacts(page, testInfo, "unsubscribe-mailto");
});

test("a plain https link uses the external link confirmation", async ({
  page,
}, testInfo) => {
  let prompt = "";
  page.once("dialog", async (dialog) => {
    prompt = dialog.message();
    await dialog.accept();
  });
  await openMore(page, "?unsub=https");
  await page.getByRole("menuitem", { name: /Unsubscribe/ }).click();
  await expect
    .poll(async () => ipcCommands(page))
    .toContain("open_external_url");
  expect(prompt).toContain("lists.example.test");
  expect(prompt).toContain("Open it in your browser?");
  expect(await ipcCommands(page)).not.toContain("unsubscribe_one_click");
  await attachArtifacts(page, testInfo, "unsubscribe-https");
});

test("messages without the header do not offer unsubscribe", async ({
  page,
}, testInfo) => {
  await openMore(page, "");
  await expect(page.getByRole("menuitem", { name: /Unsubscribe/ })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("menuitem", { name: "Show original" }),
  ).toBeVisible();
  await attachArtifacts(page, testInfo, "unsubscribe-none");
});
