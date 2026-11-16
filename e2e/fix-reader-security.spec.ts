import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifactsAfterEach, emitTauriEvent } from "./ipc";

test.afterEach(attachArtifactsAfterEach);

// Failure modes covered here:
// FM1. A native frame-link click on a link whose text is a different address
//      still shows the different-address warning before it opens.
// FM2. The print iframe (non-macOS path) is sandboxed with exactly
//      "allow-same-origin allow-modals" and never allow-scripts.
// FM3. A remote-image response that is not a data:image/ URL is not applied.

test.beforeEach(async ({ page }) => installMockIpc(page));

test("FM1: a native frame-link click names a different address in the link text", async ({
  page,
}) => {
  await page.goto("/?mismatchLink=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(
    page
      .frameLocator('iframe[title="Message content"]')
      .getByRole("link", { name: "https://bank.example/login" }),
  ).toBeVisible();
  page.once("dialog", async (dialog) => {
    const text = dialog.message();
    expect(text).toContain("phish.example.test");
    expect(text).toContain(
      "The link text shows a different address: https://bank.example/login",
    );
    await dialog.accept();
  });
  await emitTauriEvent(page, "frame-link", "https://phish.example.test/login");
  await expect
    .poll(() =>
      page.evaluate(() => window.__POSTAL_SNAP_TEST__?.openedUrls ?? []),
    )
    .toEqual(["https://phish.example.test/login"]);
});

test.describe("print iframe", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  });

  test("FM2: the print iframe sandbox is exact and has no allow-scripts", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("option", { name: /Weekend plans/i }).click();
    // Record each printer frame as it is attached; it is removed shortly after.
    await page.evaluate(() => {
      const seen: Array<string | null> = [];
      (
        window as unknown as { __printerSandboxes: Array<string | null> }
      ).__printerSandboxes = seen;
      new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes)
            if (
              node instanceof HTMLIFrameElement &&
              node.getAttribute("aria-hidden") === "true"
            )
              seen.push(node.getAttribute("sandbox"));
      }).observe(document.body, { childList: true });
    });
    await page.evaluate(() =>
      window.dispatchEvent(new Event("postal:print-message")),
    );
    const sandboxes = () =>
      page.evaluate(
        () =>
          (window as unknown as { __printerSandboxes: string[] })
            .__printerSandboxes,
      );
    await expect.poll(() => sandboxes()).toHaveLength(1);
    const [sandbox] = (await sandboxes()) ?? [];
    expect(sandbox).toBe("allow-same-origin allow-modals");
    expect(sandbox).not.toContain("allow-scripts");
  });
});

test("FM3: a remote image response that is not an image data URL is not applied", async ({
  page,
}) => {
  await page.goto("/?remote=1&nonImageData=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await page.getByRole("button", { name: "Load images", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__POSTAL_SNAP_TEST__?.remoteFetches))
    .toBe(1);
  const image = page
    .frameLocator('iframe[title="Message content"]')
    .locator("img");
  await expect(image).toHaveCount(1);
  // The reader swaps the image once its batch has settled.
  await expect(image).not.toHaveAttribute("data-remote-src");
  await expect(image).not.toHaveAttribute("src", /^data:text\//);
  await expect(image).toHaveAttribute("data-content-blocked", "true");
});
