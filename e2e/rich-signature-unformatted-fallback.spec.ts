import type { Page, TestInfo } from "@playwright/test";

import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Unformatted rich HTML is dropped when its text differs from the fallback.
// 2. Removing all formatting drops the saved rich version and fallback pairing.

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  if (!page.isClosed() && page.url() !== "about:blank") {
    await attachArtifacts(
      page,
      testInfo,
      `signature-fallback-${testInfo.testId}`,
    );
  }
});

async function openSignatureSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  await page.getByRole("button", { name: "Manage Sam", exact: true }).click();
  await page.getByRole("button", { name: "Identity", exact: true }).click();
}

async function saveSignature(page: Page, expectedSaveCount: number) {
  await page
    .locator(".signature-form")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
            (call) => call.command === "update_account_signature",
          ).length ?? 0,
      ),
    )
    .toBe(expectedSaveCount);
}

async function chooseRichText(page: Page) {
  const editor = page.getByRole("textbox", { name: "Rich signature" });
  await editor.evaluate((root) => {
    const node =
      root.querySelector("strong")?.firstChild ??
      root.querySelector("p")?.firstChild;
    if (!(node instanceof Text))
      throw new Error("Expected rich signature text");
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    if (!selection) throw new Error("Selection API unavailable");
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

async function expectComposedVersions(
  page: Page,
  richVersion: string,
  plainVersion: string,
) {
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const preview = page.locator(".composer-signature-preview");
  await expect(preview.locator(".composer-signature-html")).toHaveText(
    richVersion,
  );
  await page.getByRole("button", { name: "Message options" }).click();
  await page.getByRole("menuitem", { name: "Plain text", exact: true }).click();
  await expect(preview.locator("pre")).toHaveText(plainVersion);
  await expect(preview.locator(".composer-signature-html")).toHaveCount(0);
}

test("saves an unformatted rich signature separately from its fallback", async ({
  page,
}) => {
  await installMockIpc(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?localMail=1");
  await openSignatureSettings(page);

  const editor = page.getByRole("textbox", { name: "Rich signature" });
  await editor.fill("Unformatted rich version");
  await expect(editor.locator("p")).toHaveText("Unformatted rich version");
  await expect(editor.locator("strong, em, u, a")).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Email signature" })
    .fill("Distinct plain fallback");
  await saveSignature(page, 1);

  await page.getByRole("button", { name: "Close settings" }).click();
  await openSignatureSettings(page);
  await expect(
    page.getByRole("textbox", { name: "Email signature" }),
  ).toHaveValue("Distinct plain fallback");
  await expect(
    page.getByRole("textbox", { name: "Rich signature" }).locator("p"),
  ).toHaveText("Unformatted rich version");

  await expectComposedVersions(
    page,
    "Unformatted rich version",
    "Distinct plain fallback",
  );
});

test("keeps a rich signature when its last formatting is removed", async ({
  page,
}) => {
  await installMockIpc(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?localMail=1");
  await openSignatureSettings(page);

  const editor = page.getByRole("textbox", { name: "Rich signature" });
  const fallback = page.getByRole("textbox", { name: "Email signature" });
  await editor.fill("Rich after formatting removal");
  await chooseRichText(page);
  await page.getByRole("button", { name: "Bold" }).click();
  await expect(editor.locator("strong")).toHaveText(
    "Rich after formatting removal",
  );
  await fallback.fill("Independent plain fallback");
  await saveSignature(page, 1);

  await chooseRichText(page);
  await page.getByRole("button", { name: "Bold" }).click();
  await expect(editor.locator("strong")).toHaveCount(0);
  await expect(fallback).toHaveValue("Independent plain fallback");
  await saveSignature(page, 2);

  await page.getByRole("button", { name: "Close settings" }).click();
  await openSignatureSettings(page);
  await expect(fallback).toHaveValue("Independent plain fallback");
  await expect(editor.locator("p")).toHaveText("Rich after formatting removal");
  await expect(editor.locator("strong, em, u, a")).toHaveCount(0);

  await expectComposedVersions(
    page,
    "Rich after formatting removal",
    "Independent plain fallback",
  );
});
