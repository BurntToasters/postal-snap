import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

test.beforeEach(async ({ page }) => installMockIpc(page));

// Failure mode: a body that could not download said the message had no text.
test("explains a body that has not downloaded yet", async ({ page }) => {
  await page.goto("/?bodyOffline=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page.getByRole("note").filter({ hasText: /has not downloaded yet/ }),
  ).toBeVisible();
  await expect(
    page.getByText("This message has no readable text."),
  ).toHaveCount(0);
  await page.screenshot({ path: "test-results/reader-body-offline.png" });
});

// Failure mode: an HTML part that sanitizes to nothing left a blank pane.
test("falls back to the text part when HTML shows nothing", async ({
  page,
}) => {
  await page.goto("/?blankHtml=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(page.getByText("Plain part is still readable.")).toBeVisible();
  await expect(page.locator(".message-body iframe")).toHaveCount(0);
  await page.screenshot({ path: "test-results/reader-body-text-fallback.png" });
});

test("renders HTML mail inside the sandboxed frame", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  const frame = page.locator(".message-body iframe");
  await expect(frame).toHaveAttribute(
    "sandbox",
    "allow-same-origin allow-popups",
  );
  await expect(
    frame.contentFrame().getByText("Are we still meeting on Saturday?"),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/reader-body-html.png" });
});

// Failure modes (WebKit): listeners never run in the scriptless frame, so an
// href="#" link navigated the frame to the app URL and blanked the message.
// Links must carry their real target as a denied popup, and the native
// "frame-link" event must still go through the confirmation flow.
test("frame links route to link confirmation without navigating", async ({
  page,
}) => {
  await page.goto("/?webLink=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  const link = page
    .frameLocator('iframe[title="Message content"]')
    .getByRole("link", { name: "Open site" });
  await expect(link).toHaveAttribute(
    "href",
    "https://library.example.test/hours",
  );
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("library.example.test");
    await dialog.accept();
  });
  await page.evaluate(() =>
    (
      window as typeof window & {
        __TAURI_INTERNALS__: {
          invoke: (
            command: string,
            args?: Record<string, unknown>,
          ) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "frame-link",
      payload: "https://library.example.test/hours",
    }),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __POSTAL_SNAP_TEST__: { openedUrls: string[] };
            }
          ).__POSTAL_SNAP_TEST__.openedUrls,
      ),
    )
    .toEqual(["https://library.example.test/hours"]);
  await page.screenshot({ path: "test-results/reader-body-link.png" });
});

test.describe("macOS print", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  });

  // Failure modes: WebKit ignores print() from a frame, so nothing prints;
  // the host frame loses its sandbox; app chrome prints over the message;
  // HTML-only mail prints an empty body.
  test("prints natively from a sandboxed host that hides app chrome", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("option", { name: /Weekend plans/i }).click();
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Print message" }).click();

    const host = page.locator("body > .print-host");
    await expect(host).toHaveCount(1);
    const frame = host.locator("iframe");
    await expect(frame).toHaveAttribute("sandbox", "allow-same-origin");
    await expect(
      frame.contentFrame().getByText("Are we still meeting on Saturday?"),
    ).toBeAttached();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __POSTAL_SNAP_TEST__: { printCalls: number };
              }
            ).__POSTAL_SNAP_TEST__.printCalls,
        ),
      )
      .toBe(1);

    await page.emulateMedia({ media: "print" });
    await expect(page.locator("#root")).toBeHidden();
    await expect(host).toBeVisible();
    await page.screenshot({ path: "test-results/reader-body-print.png" });
  });
});
