import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here (docs/0.5.0-FAILURE-INVENTORY.md, section A):
// A1. The legacy setError slot shows, replaces, and clears its notice.
// A2. Both live regions exist before any notice is announced.
// A4. An error notice never auto-dismisses.
// A5. A send that needs attention offers no Retry or Undo from the notice.
// Undo-send stays outside the queue, so A3 and A18 have no folded flow here.

const VIEWPORT = { width: 1280, height: 900 };
const combos = [
  { density: "comfortable", scale: 1 },
  { density: "compact", scale: 1 },
  { density: "comfortable", scale: 2 },
  { density: "compact", scale: 2 },
] as const;

async function openMailbox(page: Page, query: string) {
  await installMockIpc(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto(`/?localMail=1&${query}`);
  await expect(page.locator(".message-row").first()).toBeVisible();
}

async function sendDraft(page: Page, body: string) {
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page.getByPlaceholder("name@example.com").fill("lee@example.com");
  await page.getByRole("textbox", { name: "Subject" }).fill("Notice check");
  await page.getByLabel("Message body").pressSequentially(body);
  // The keyboard shortcut avoids a bottom-right notice covering Send at 200%.
  await page.getByLabel("Message body").press("ControlOrMeta+Enter");
  await expect(page.locator(".composer-window")).toHaveCount(0);
}

async function expectFitsViewport(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(VIEWPORT.width);
}

async function expectScaledText(page: Page, scale: number) {
  await expect
    .poll(() =>
      page.locator("html").evaluate((n) => getComputedStyle(n).fontSize),
    )
    .toBe(`${scale * 16}px`);
}

async function expectAxeClean(page: Page, selector: string) {
  const scan = await new AxeBuilder({ page }).include(selector).analyze();
  expect(
    scan.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(`${name}-screen`, { path, contentType: "image/png" });
}

for (const { density, scale } of combos) {
  const label = `${density} ${scale * 100}%`;
  const query = `density=${density}&scale=${scale}`;

  test(`live regions exist before any notice, ${label}`, async ({
    page,
  }, testInfo) => {
    await openMailbox(page, `${query}&sendOutcome=queued`);
    await expectScaledText(page, scale);

    const polite = page.locator(
      '.notice-region .notice-stack[aria-live="polite"]',
    );
    const assertive = page.locator(
      '.notice-region .notice-stack[aria-live="assertive"]',
    );
    await expect(polite).toHaveCount(1);
    await expect(assertive).toHaveCount(1);
    await expect(page.locator(".notice-region .toast")).toHaveCount(0);

    // Tag the mounted region; a remount would drop the tag.
    await page.evaluate(() => {
      (document.querySelector(".notice-region") as HTMLElement).dataset.probe =
        "mounted";
    });
    await sendDraft(page, "Queued before the region check.");
    await expect(assertive.locator(".error-toast")).toContainText(
      "Not sent yet.",
    );
    await expect(page.locator(".notice-region")).toHaveAttribute(
      "data-probe",
      "mounted",
    );
    await expectAxeClean(page, ".notice-region");
    await attachScreenshot(page, testInfo, `notices-live-${density}-${scale}`);
    await attachArtifacts(page, testInfo, `notices-live-${density}-${scale}`);
  });

  test(`legacy error replaces, clears, and never auto-dismisses, ${label}`, async ({
    page,
  }, testInfo) => {
    await openMailbox(page, `${query}&sendOutcome=queued`);
    await expectScaledText(page, scale);

    const toast = page.locator(".notice-region .error-toast");
    await sendDraft(page, "First try.");
    await expect(toast).toHaveCount(1);
    await expect(toast).toContainText("Not sent yet.");
    await expectFitsViewport(page, ".notice-region .error-toast");

    // A second failure replaces the slot instead of stacking a copy.
    await sendDraft(page, "Second try.");
    await expect(toast).toHaveCount(1);
    await expect(toast).toContainText("Not sent yet.");

    // Errors have no timer; wait longer than the info timeout to prove it.
    await page.waitForTimeout(9_000);
    await expect(toast).toBeVisible();

    const dismiss = toast.getByRole("button", { name: "Dismiss error" });
    await expect(dismiss).toHaveAttribute("title", "Dismiss error");
    if (density === "comfortable") {
      const box = await dismiss.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await expectAxeClean(page, ".notice-region");
    await attachScreenshot(page, testInfo, `notices-error-${density}-${scale}`);

    await dismiss.click();
    await expect(page.locator(".notice-region .toast")).toHaveCount(0);
    await attachArtifacts(page, testInfo, `notices-error-${density}-${scale}`);
  });

  test(`uncertain send shows no Retry or Undo in the notice, ${label}`, async ({
    page,
  }, testInfo) => {
    await openMailbox(page, `${query}&sendOutcome=needs_attention`);
    await expectScaledText(page, scale);

    await sendDraft(page, "Outcome unknown.");
    const toast = page.locator(".notice-region .error-toast");
    await expect(toast).toContainText("Delivery could not be confirmed.");
    await expect(toast.getByRole("button")).toHaveCount(1);
    await expect(
      toast.getByRole("button", { name: /retry|undo|send/i }),
    ).toHaveCount(0);
    await expect(page.getByText("Message sent")).toHaveCount(0);
    await attachArtifacts(
      page,
      testInfo,
      `notices-uncertain-${density}-${scale}`,
    );
  });
}

test("error notice keeps a visible border and no slide under forced colors", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await openMailbox(page, "sendOutcome=queued");
  await sendDraft(page, "Forced colors check.");

  const toast = page.locator(".notice-region .error-toast");
  await expect(toast).toBeVisible();
  const style = await toast.evaluate((el) => {
    const computed = getComputedStyle(el);
    return {
      border: computed.borderTopStyle,
      animation: computed.animationName,
    };
  });
  expect(style.border).not.toBe("none");
  expect(style.animation).toBe("none");

  await toast.getByRole("button", { name: "Dismiss error" }).focus();
  await expect(
    toast.getByRole("button", { name: "Dismiss error" }),
  ).toBeFocused();
  await attachScreenshot(page, testInfo, "notices-forced-colors");
  await attachArtifacts(page, testInfo, "notices-forced-colors");
});
