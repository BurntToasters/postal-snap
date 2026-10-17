import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import type { TestInfo } from "@playwright/test";
import { join } from "node:path";

import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Plain-text composition previews the rich signature instead of its fallback.
// 2. Switching formats changes only the preview, not the saved account values.
// 3. Sanitized signature links remain inert in the privileged composer.
// 4. Signature controls or previews clip at compact density or 200% text.

const variants = [
  { density: "comfortable", scale: 1 },
  { density: "compact", scale: 1 },
  { density: "comfortable", scale: 2 },
  { density: "compact", scale: 2 },
] as const;

for (const { density, scale } of variants) {
  const slug = `${density}-${scale * 100}`;

  test(`plain composer previews the saved fallback: ${slug}`, async ({
    page,
  }, testInfo: TestInfo) => {
    await installMockIpc(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/?density=${density}&scale=${scale}`);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Accounts", exact: true }).click();
    await page.getByRole("button", { name: "Manage Sam", exact: true }).click();
    await page.getByRole("button", { name: "Identity", exact: true }).click();

    const editor = page.getByRole("textbox", { name: "Rich signature" });
    await editor.evaluate((root) => {
      root.focus();
      const clipboard = new DataTransfer();
      clipboard.setData(
        "text/html",
        '<p><strong>Rich version</strong> <a href="https://tracking.example.test/path">reference</a><img src="https://tracking.example.test/pixel" onerror="alert(1)"></p><script>alert(1)</script>',
      );
      clipboard.setData("text/plain", "Rich version reference");
      root.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      );
    });
    await expect(editor.locator("strong")).toHaveText("Rich version");
    const fallback = page.getByRole("textbox", { name: "Email signature" });
    await fallback.fill("Plain fallback distinct from rich");
    await editor.evaluate((root) => {
      const node = root.querySelector("strong")?.firstChild;
      if (!(node instanceof Text)) throw new Error("Rich text is missing");
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      if (!selection) throw new Error("Selection API unavailable");
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.getByRole("button", { name: "Italic" }).click();
    await expect(fallback).toHaveValue("Plain fallback distinct from rich");
    await page
      .locator(".signature-form")
      .getByRole("button", { name: "Save", exact: true })
      .click();
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
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Accounts", exact: true }).click();
    await page.getByRole("button", { name: "Manage Sam", exact: true }).click();
    await page.getByRole("button", { name: "Identity", exact: true }).click();
    const reopenedFallback = page.getByRole("textbox", {
      name: "Email signature",
    });
    await expect(reopenedFallback).toHaveValue(
      "Plain fallback distinct from rich",
    );
    const reopenedEditor = page.getByRole("textbox", {
      name: "Rich signature",
    });
    await reopenedEditor.evaluate((root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !node.textContent?.trim()) node = walker.nextNode();
      if (!(node instanceof Text)) throw new Error("Rich text is missing");
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      if (!selection) throw new Error("Selection API unavailable");
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.getByRole("button", { name: "Underline" }).click();
    await expect(reopenedFallback).toHaveValue(
      "Plain fallback distinct from rich",
    );
    await page
      .locator(".signature-form")
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect(page.getByText("Signature saved.")).toBeVisible();
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.getByRole("button", { name: "Compose", exact: true }).click();
    const preview = page.locator(".composer-signature-preview");
    await expect(preview.locator("strong").last()).toHaveText("Rich version");
    const richAudit = await preview.evaluate((root) => ({
      html: root.innerHTML,
      imageCount: root.querySelectorAll("img").length,
      actionableLinks: [...root.querySelectorAll("a")].filter(
        (link) =>
          link.hasAttribute("href") || link.hasAttribute("data-external-href"),
      ).length,
    }));
    expect(richAudit.html).not.toMatch(/<script|onerror=|javascript:/i);
    expect(richAudit.imageCount).toBe(0);
    expect(richAudit.actionableLinks).toBe(0);

    const richScan = await new AxeBuilder({ page })
      .include(".composer-window")
      .analyze();
    expect(
      richScan.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);

    await page.getByRole("button", { name: "Message options" }).click();
    await page
      .getByRole("menuitem", { name: "Plain text", exact: true })
      .click();
    await expect(preview.locator("pre")).toHaveText(
      "Plain fallback distinct from rich",
    );
    await expect(preview.locator(".composer-signature-html")).toHaveCount(0);
    const plainScan = await new AxeBuilder({ page })
      .include(".composer-window")
      .analyze();
    expect(
      plainScan.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);

    const artifactDir = join(
      "artifacts",
      "0.5.0",
      "rich-signature-plain-preview",
    );
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
          richPreview: richAudit,
          plainPreview: await preview.innerText(),
          seriousOrCriticalAxeViolations: [
            ...settingsScan.violations,
            ...richScan.violations,
            ...plainScan.violations,
          ].filter((violation) =>
            ["serious", "critical"].includes(violation.impact ?? ""),
          ),
        },
        null,
        2,
      ),
    );
    await attachArtifacts(page, testInfo, `w19-signature-preview-${slug}`);
  });
}
