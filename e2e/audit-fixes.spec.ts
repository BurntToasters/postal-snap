import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A bulk move leaves the moved message open in the reader.
// 2. With conversations grouped, j/k move against the visible list order.
// 3. A message scheduled hours ahead counts down in raw seconds.
// 4. Opening another composer throws away unsaved text in the open one.
// 5. A send that was not accepted yet closes the composer without a word.

test.beforeEach(async ({ page }) => installMockIpc(page));

test("bulk archive closes the moved message in the reader", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator('[role="option"]').first().click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans", level: 1 }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("checkbox", { name: /Weekend plans/ }).check();
  await page
    .getByRole("toolbar", { name: /selected/i })
    .getByRole("button", { name: "Archive" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans", level: 1 }),
  ).toHaveCount(0);
  await page.screenshot({ path: "test-results/audit-bulk-archive.png" });
});

test("j and k follow the grouped conversation order", async ({ page }) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("treeitem", { name: /Library hours/ }).click();
  const title = page.locator("#message-title");
  await expect(title).toHaveText("Library hours");
  // Library hours is the last visible row: j has nowhere to go.
  await title.click();
  await page.keyboard.press("j");
  await expect(title).toHaveText("Library hours");
  // k goes to the conversation directly above, not past it.
  await page.keyboard.press("k");
  await expect(title).toHaveText("Older family note");
  await page.screenshot({ path: "test-results/audit-thread-keys.png" });
});

test("a message scheduled hours ahead shows when it sends", async ({
  page,
}) => {
  await page.goto("/?localMail=1&scheduled=1&scheduledLater=1");
  await page.getByRole("button", { name: /Outbox/ }).click();
  const row = page.locator(".attention-row");
  await expect(row).toContainText(/Sends /);
  await expect(row).not.toContainText(/\d{4,}s/);
  await page.screenshot({ path: "test-results/audit-scheduled-label.png" });
});

test("opening another composer saves the unsaved reply first", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    const mock = window.__POSTAL_SNAP_MOCK__!;
    const original = mock.handlers.save_draft;
    const saves: string[] = [];
    Object.assign(window, { __draftSaves: saves });
    mock.handlers.save_draft = (args: Record<string, unknown>) => {
      saves.push(String((args.draft as { htmlBody?: string }).htmlBody));
      return original(args);
    };
  });
  await page.locator('[role="option"]').first().click();
  await page.getByRole("button", { name: "Reply", exact: true }).click();
  await page.getByRole("textbox", { name: /message body/i }).click();
  await page.keyboard.type("Unsaved reply text");
  await page.getByRole("button", { name: "Compose" }).click();

  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          (window as unknown as { __draftSaves: string[] }).__draftSaves ?? []
        ).some((html) => html.includes("Unsaved reply text")),
      ),
    )
    .toBe(true);
});

test("a send that has not gone yet says so", async ({ page }) => {
  await page.goto("/?localMail=1&sendOutcome=queued");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByPlaceholder("name@example.com").fill("lee@example.com");
  await page.getByRole("textbox", { name: "Subject" }).fill("Later note");
  await page.getByLabel("Message body").pressSequentially("Not yet.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".composer-window")).toHaveCount(0);
  await expect(page.locator(".error-toast")).toContainText("Not sent yet.");
  await expect(page.getByText("Message sent")).toHaveCount(0);
});
