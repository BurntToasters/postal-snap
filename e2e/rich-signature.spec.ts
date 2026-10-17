import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import type { TestInfo } from "@playwright/test";
import { join } from "node:path";

import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here (docs/0.5.0-FAILURE-INVENTORY.md, C1-C3):
// 1. Rich formatting is lost when a signature is saved or reloaded.
// 2. The composer preview omits the saved signature or renders unsafe markup.
// 3. The editor or preview clips controls at compact density or 200% text.
// 4. Signature controls lose their accessible names or keyboard focus.

const VIEWPORT = { width: 1280, height: 900 };
const variants = [
  { density: "comfortable", scale: 1 },
  { density: "compact", scale: 1 },
  { density: "comfortable", scale: 2 },
  { density: "compact", scale: 2 },
] as const;

for (const { density, scale } of variants) {
  const slug = `${density}-${scale * 100}`;

  test(`rich signature saves, reloads, and previews: ${slug}`, async ({
    page,
  }, testInfo: TestInfo) => {
    await installMockIpc(page);
    await page.setViewportSize(VIEWPORT);
    await page.goto(`/?localMail=1&density=${density}&scale=${scale}`);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("tab", { name: "Accounts" }).click();
    await page.getByRole("button", { name: "Manage Sam", exact: true }).click();
    await page.getByRole("button", { name: "Identity", exact: true }).click();

    const editor = page.getByRole("textbox", { name: "Rich signature" });
    await editor.fill("Best,\nSam");
    const selectText = async (
      paragraph: number,
      start: number,
      end: number,
    ) => {
      await editor.evaluate(
        (root, selection) => {
          const node =
            root.querySelectorAll("p")[selection.paragraph]?.firstChild;
          if (!(node instanceof Text)) {
            throw new Error("Expected signature paragraph text");
          }
          const range = document.createRange();
          range.setStart(node, selection.start);
          range.setEnd(node, selection.end);
          const activeSelection = window.getSelection();
          if (!activeSelection) {
            throw new Error("Selection API unavailable");
          }
          activeSelection.removeAllRanges();
          activeSelection.addRange(range);
        },
        { paragraph, start, end },
      );
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    };
    await selectText(0, 0, 5);
    const boldButton = page.getByRole("button", { name: "Bold" });
    await boldButton.click();
    await expect(editor.locator("strong")).toHaveCount(1);
    await expect(boldButton).toHaveAttribute("aria-pressed", "true");
    await selectText(1, 1, 1);
    await expect(boldButton).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Signature saved.")).toBeVisible();

    const settingsScan = await new AxeBuilder({ page })
      .include(".settings-window")
      .analyze();
    expect(
      settingsScan.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);

    await page.getByRole("button", { name: "Close settings" }).click();
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("tab", { name: "Accounts" }).click();
    await page.getByRole("button", { name: "Manage Sam", exact: true }).click();
    await page.getByRole("button", { name: "Identity", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Rich signature" }).locator("strong"),
    ).toHaveCount(1);

    const saveCall = await page.evaluate(() =>
      window.__POSTAL_SNAP_TEST__?.ipcCalls
        .filter((call) => call.command === "update_account_signature")
        .at(-1),
    );
    expect(saveCall?.args).toMatchObject({
      signature: "Best,\nSam",
      signatureHtml: expect.stringContaining("<strong>"),
    });

    await page.getByRole("button", { name: "Close settings" }).click();
    await page.getByRole("button", { name: "Compose", exact: true }).click();
    const preview = page.locator(".composer-signature-preview");
    await expect(
      preview.locator(".composer-signature-html strong").first(),
    ).toHaveText("Best,");

    const previewScan = await new AxeBuilder({ page })
      .include(".composer-window")
      .analyze();
    expect(
      previewScan.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);

    const previewHtml = await preview.innerHTML();
    expect(previewHtml).not.toMatch(/<script|<img|onerror=|javascript:/i);
    const artifactDir = join("artifacts", "0.5.0", "rich-signature");
    mkdirSync(artifactDir, { recursive: true });
    await page.screenshot({
      path: join(artifactDir, `${slug}.png`),
      fullPage: true,
    });
    writeFileSync(
      join(artifactDir, `${slug}.json`),
      JSON.stringify(
        {
          density,
          scale,
          signature: saveCall?.args,
          previewHtml,
          seriousOrCriticalAxeViolations: [
            ...settingsScan.violations,
            ...previewScan.violations,
          ].filter((violation) =>
            ["serious", "critical"].includes(violation.impact ?? ""),
          ),
        },
        null,
        2,
      ),
    );
    await attachArtifacts(page, testInfo, `rich-signature-${slug}`);
  });
}
