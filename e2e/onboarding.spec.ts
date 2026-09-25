import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

test.beforeEach(async ({ page }) => installMockIpc(page));

async function reachAccountSetup(page: import("@playwright/test").Page) {
  await page.goto("/?firstRun=1");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}

test("discovers Fastmail, chooses Download all, and hands off first sync", async ({
  page,
}) => {
  await reachAccountSetup(page);
  await page.getByRole("button", { name: /Other email/i }).click();
  await page.getByLabel("Email address").fill("reader@fastmail.com");
  await page.getByRole("button", { name: "Find settings" }).click();

  await expect(
    page.getByRole("heading", { name: "Connect Fastmail" }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Incoming IMAP" }).getByLabel("Server"),
  ).toHaveValue("imap.fastmail.com");
  await page.getByLabel("Your name").fill("Reader");
  await page.getByLabel("App-specific password").fill("app-secret");
  await page.getByLabel("Download all mail").check();
  await page.getByRole("button", { name: "Connect securely" }).click();

  await expect(
    page.getByRole("heading", { name: "Getting your mail…" }),
  ).toBeVisible();
  await expect(
    page.getByRole("progressbar", { name: "Mail download progress" }),
  ).toHaveAttribute("value", "24");
  const request = await page.evaluate(
    () => window.__POSTAL_SNAP_TEST__?.setupRequest,
  );
  expect(request).toMatchObject({
    provider: "manual",
    cachePolicy: { mode: "full", days: 90, maxBytes: 0 },
    imap: { host: "imap.fastmail.com" },
    smtp: { host: "smtp.fastmail.com" },
  });

  await page.getByRole("button", { name: "Open mailbox" }).click();
  await expect(page.getByRole("button", { name: "Compose" })).toBeVisible();
});

test("explains unsupported Gmail without showing a dead-end password form", async ({
  page,
}) => {
  await reachAccountSetup(page);
  await page.getByRole("button", { name: /Other email/i }).click();
  await page.getByLabel("Email address").fill("reader@gmail.com");
  await page.getByRole("button", { name: "Find settings" }).click();

  await expect(page.getByText(/Gmail requires OAuth/)).toBeVisible();
  await expect(page.getByLabel(/password/i)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Connect securely" }),
  ).toHaveCount(0);
});

test("uses domain autoconfig and falls back to editable manual settings", async ({
  page,
}) => {
  await reachAccountSetup(page);
  await page.getByRole("button", { name: /Other email/i }).click();
  await page.getByLabel("Email address").fill("reader@autodetect.example");
  await page.getByRole("button", { name: "Find settings" }).click();
  await expect(
    page.getByRole("group", { name: "Incoming IMAP" }).getByLabel("Server"),
  ).toHaveValue("imap.autodetect.example");

  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: /Other email/i }).click();
  await page.getByLabel("Email address").fill("reader@unknown.example");
  await page.getByRole("button", { name: "Find settings" }).click();
  await expect(
    page.getByText(/enter the server settings manually/i),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Incoming IMAP" }),
  ).toBeVisible();
});
