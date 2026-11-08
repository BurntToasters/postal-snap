import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifactsAfterEach } from "./ipc";

test.afterEach(attachArtifactsAfterEach);

// Failure modes covered here:
// 1. Reopened draft with high importance or a receipt shows no state; the
//    Message options name omits it.
// 2. A default new message shows a chip or a suffixed name.
// 3. Signature off is not announced.
// 4. Show formatting aria-pressed or its toolbar drifts from the toggle.
// 5. Pressed toggle fails contrast or lacks a forced-colors indicator.
// 6. 200% in 1280x800: footer over two rows or editor under 40%.
// 7. A collapsed footer action loses its name, tooltip, focus, or target size.
// 8. Header fields and the editor draw different focus rings.
// Metrics and screenshots land in artifacts/0.5.2/audit-fixes/audit-composer/.

const ARTIFACT_DIR = join(
  process.cwd(),
  "artifacts",
  "0.5.2",
  "audit-fixes",
  "audit-composer",
);
const VIEWPORT = { width: 1280, height: 800 };

test.beforeEach(async ({ page }) => installMockIpc(page));

async function saveArtifact(name: string, value: unknown, page: Page) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const json = join(ARTIFACT_DIR, `${name}.json`);
  await writeFile(json, `${JSON.stringify(value, null, 2)}\n`);
  await page.screenshot({ path: join(ARTIFACT_DIR, `${name}.png`) });
}

async function openNewComposer(page: Page, density: string, scale: number) {
  await page.setViewportSize(VIEWPORT);
  await page.goto(`/?density=${density}&scale=${scale}`);
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await expect(page.locator(".composer-window")).toBeVisible();
}

/** Opens a reply draft whose saved options come from `extra`. */
async function openSeededDraft(
  page: Page,
  density: string,
  scale: number,
  extra: Record<string, unknown>,
) {
  await page.setViewportSize(VIEWPORT);
  await page.goto(
    `/?localMail=1&replyDraft=reply&density=${density}&scale=${scale}`,
  );
  await page.evaluate((options) => {
    const mock = window.__POSTAL_SNAP_MOCK__;
    if (!mock) throw new Error("mock IPC is not installed");
    const base = mock.handlers.get_draft;
    mock.handlers.get_draft = async (args) => ({
      ...((await base?.(args)) as Record<string, unknown>),
      ...options,
    });
  }, extra);
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
  await page.getByRole("button", { name: "Continue draft" }).click();
  await expect(page.locator(".composer-window")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Subject" })).toHaveValue(
    "Family update",
  );
}

function optionsButton(page: Page, name: string): Locator {
  return page.locator(".composer-window").getByRole("button", {
    name,
    exact: true,
  });
}

function targetFor(density: string): number {
  if (density === "comfortable") return 44;
  if (density === "compact") return 32;
  return 36;
}

test("new message: options button is plain and shows no state chip", async ({
  page,
}) => {
  await openNewComposer(page, "normal", 1);
  await expect(optionsButton(page, "Message options")).toBeVisible();
  await expect(page.locator(".composer-option-chip")).toHaveCount(0);
});

test("reopened draft with high importance and receipt shows both states", async ({
  page,
}) => {
  await openSeededDraft(page, "normal", 1, {
    importance: "high",
    requestReceipt: true,
  });
  const button = optionsButton(
    page,
    "Message options, high importance, read receipt on",
  );
  await expect(button).toBeVisible();
  const chips = await page.locator(".composer-option-chip").allTextContents();
  expect(chips).toEqual(["High importance", "Receipt requested"]);
});

test("low importance is named in the chip and the button", async ({ page }) => {
  await openSeededDraft(page, "normal", 1, { importance: "low" });
  await expect(
    optionsButton(page, "Message options, low importance"),
  ).toBeVisible();
  await expect(page.locator(".composer-option-chip")).toHaveText([
    "Low importance",
  ]);
});

test("turning options off through the menu updates chip and name", async ({
  page,
}) => {
  await openSeededDraft(page, "normal", 1, {
    importance: "high",
    requestReceipt: true,
  });
  await optionsButton(
    page,
    "Message options, high importance, read receipt on",
  ).click();
  const menu = page.getByRole("menu", { name: "Message options" });
  await menu
    .getByRole("menuitemcheckbox", { name: "Request a read receipt" })
    .click();
  await menu.getByRole("menuitemcheckbox", { name: "High importance" }).click();
  await page.keyboard.press("Escape");
  await expect(optionsButton(page, "Message options")).toBeVisible();
  await expect(page.locator(".composer-option-chip")).toHaveCount(0);
});

test("include signature off is announced in the chip and the name", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const mock = window.__POSTAL_SNAP_MOCK__;
    if (mock) mock.account.signature = "-- Sam";
  });
  await openNewComposer(page, "normal", 1);
  await optionsButton(page, "Message options").click();
  await page
    .getByRole("menu", { name: "Message options" })
    .getByRole("menuitemcheckbox", { name: "Include signature" })
    .click();
  await page.keyboard.press("Escape");
  await expect(
    optionsButton(page, "Message options, signature off"),
  ).toBeVisible();
  await expect(page.locator(".composer-option-chip")).toHaveText([
    "No signature",
  ]);
});

test("Show formatting toggle announces its pressed state and opens the toolbar", async ({
  page,
}) => {
  await openNewComposer(page, "normal", 1);
  const toggle = page.getByRole("button", {
    name: "Show formatting",
    exact: true,
  });
  const toolbar = page.locator("#composer-formatting");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toolbar).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(toolbar).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toolbar).toBeHidden();
});

test("pressed toggle uses the accent ink token in light and dark", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openNewComposer(page, "normal", 1);
  const toggle = page.getByRole("button", {
    name: "Show formatting",
    exact: true,
  });
  await toggle.click();
  // Retrying matcher: the button animates its color, so read after it settles.
  await expect(toggle).toHaveCSS("color", "rgb(0, 87, 158)");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(toggle).toHaveCSS("color", "rgb(100, 181, 255)");
});

test("pressed toggle has a forced-colors outline", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await openNewComposer(page, "normal", 1);
  const toggle = page.getByRole("button", {
    name: "Show formatting",
    exact: true,
  });
  await toggle.click();
  const outline = await toggle.evaluate((el) => {
    const style = getComputedStyle(el);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(outline.style).toBe("solid");
  expect(parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
});

for (const density of ["normal", "comfortable", "compact"]) {
  test(`200% footer: at most two rows, editor >= 40%, names kept: ${density}`, async ({
    page,
  }) => {
    await openNewComposer(page, density, 2);
    // Send is disabled until there is a recipient and a letter.
    await page.locator("#composer-to").fill("pat@example.com");
    await page
      .getByRole("textbox", { name: "Subject", exact: true })
      .fill("Footer audit");
    await page
      .getByRole("textbox", { name: "Message body" })
      .fill("A short letter.");
    const composer = page.locator(".composer-window");
    await expect(composer).toBeVisible();

    const rowCount = await page
      .locator(".composer-window footer > *")
      .evaluateAll((els) => {
        const tops = els
          .filter((el) => getComputedStyle(el).position !== "absolute")
          .filter((el) => el.getBoundingClientRect().height > 0)
          .map((el) => Math.round(el.getBoundingClientRect().top));
        return new Set(tops).size;
      });

    const heightOf = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((el) => Math.round(el.getBoundingClientRect().height));
    const windowHeight = (await composer.boundingBox())?.height ?? 1;
    const editorHeight = await heightOf(".composer-editor-wrap");
    const share = editorHeight / windowHeight;
    const parts = {
      window: Math.round(windowHeight),
      header: await heightOf(".composer-window > header"),
      body: await heightOf(".composer-window > .composer-body"),
      footer: await heightOf(".composer-window > footer"),
      editor: editorHeight,
    };

    const minTarget = targetFor(density);
    const heights: Record<string, number> = {};
    const focusFailures: string[] = [];
    const sizeFailures: string[] = [];
    for (const name of [
      "Send",
      "Save draft",
      "Show formatting",
      "Attach",
      "Picture",
      "Discard",
    ]) {
      const button = optionsButton(page, name);
      await expect(button).toBeVisible();
      // Collapsed actions need a tooltip; Discard keeps its text.
      if (name !== "Discard")
        await expect(button).toHaveAttribute("title", /.+/);
      await button.focus();
      if (!(await button.evaluate((el) => el === document.activeElement)))
        focusFailures.push(name);
      const box = await button.boundingBox();
      heights[name] = box?.height ?? 0;
      if ((box?.height ?? 0) < minTarget || (box?.width ?? 0) < minTarget)
        sizeFailures.push(`${name} ${box?.width}x${box?.height}`);
    }

    await saveArtifact(
      `footer-200-${density}`,
      {
        density,
        scale: 2,
        viewport: VIEWPORT,
        rowCount,
        editorShare: share,
        parts,
        targetHeights: heights,
        focusFailures,
        sizeFailures,
      },
      page,
    );

    expect(rowCount).toBeLessThanOrEqual(2);
    expect(share).toBeGreaterThanOrEqual(0.4);
    expect(focusFailures).toEqual([]);
    expect(sizeFailures).toEqual([]);
  });
}

test("focus ring: To field and editor share one inset ring style", async ({
  page,
}) => {
  await openNewComposer(page, "normal", 1);
  const to = page.locator("#composer-to");
  await to.focus();
  const toRing = await to.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      style: style.outlineStyle,
      width: style.outlineWidth,
      color: style.outlineColor,
      offset: parseFloat(style.outlineOffset),
    };
  });
  await page.getByRole("textbox", { name: "Message body" }).click();
  const bodyRing = await page
    .locator(".composer-window .tiptap")
    .evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        style: style.outlineStyle,
        width: style.outlineWidth,
        color: style.outlineColor,
        offset: parseFloat(style.outlineOffset),
        shadow: style.boxShadow,
      };
    });
  expect(toRing.style).toBe("solid");
  expect(bodyRing.style).toBe("solid");
  expect(bodyRing.width).toBe(toRing.width);
  expect(bodyRing.color).toBe(toRing.color);
  expect(toRing.offset).toBeLessThan(0);
  expect(bodyRing.offset).toBeLessThan(0);
  expect(bodyRing.shadow).toBe("none");

  await saveArtifact("focus-rings", { to: toRing, body: bodyRing }, page);
});

for (const [density, scale, scheme] of [
  ["normal", 1, "light"],
  ["comfortable", 1, "light"],
  ["compact", 1, "light"],
  ["normal", 2, "light"],
  ["comfortable", 2, "light"],
  ["compact", 2, "light"],
  ["normal", 1, "dark"],
] as const) {
  test(`artifact: seeded reply with options, ${density} ${scale * 100}% ${scheme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openSeededDraft(page, density, scale, {
      importance: "high",
      requestReceipt: true,
    });
    const names = await page.locator(".composer-option-chip").allTextContents();
    expect(names).toEqual(["High importance", "Receipt requested"]);
    await saveArtifact(
      `reply-options-${density}-${scale * 100}-${scheme}`,
      { density, scale, scheme, chips: names },
      page,
    );
  });
}

test("artifact: forced colors reply with options", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await openSeededDraft(page, "normal", 1, {
    importance: "high",
    requestReceipt: true,
  });
  await saveArtifact(
    "reply-options-forced-colors",
    { forcedColors: true },
    page,
  );
});
