import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc-artifact";
import { emitTauriEvent } from "./ipc-recorder";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here (docs/0.5.0-FAILURE-INVENTORY.md, G9/F7):
// 1. Avatar, provider, setup-preview, or composer controls overlap or clip.
// 2. Compact density and 200% text create unusable geometry.
// 3. Avatar colors or focus indicators disappear in forced colors.
// 4. A density change introduces a serious accessibility violation.

const combos = [
  { name: "comfortable-1x", density: "comfortable", scale: 1 },
  { name: "comfortable-2x", density: "comfortable", scale: 2 },
  { name: "compact-1x", density: "compact", scale: 1 },
  { name: "compact-2x", density: "compact", scale: 2 },
] as const;

const artifactDir = join(process.cwd(), "artifacts", "0.5.0", "css-tokens");

async function expectAxeClean(
  page: import("@playwright/test").Page,
  selector: string,
) {
  const scan = await new AxeBuilder({ page }).include(selector).analyze();
  expect(
    scan.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
}

test.describe("CSS density token matrix", () => {
  test.setTimeout(120_000);

  test("covers avatar, composer, and setup surfaces at both scales", async ({
    page,
  }, testInfo) => {
    await installMockIpc(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await mkdir(artifactDir, { recursive: true });
    const metrics: Record<string, unknown> = {};

    for (const combo of combos) {
      const query = `density=${combo.density}&scale=${combo.scale}`;
      await page.goto(`/?firstRun=1&${query}`);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(page.locator(".setup-preview-mail")).toBeVisible();

      const preview = await page
        .locator(".setup-preview-mail")
        .evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            width: rect.width,
            height: rect.height,
            firstColumn: Number.parseFloat(style.gridTemplateColumns),
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
          };
        });
      expect(preview.firstColumn).toBeGreaterThan(0);
      expect(preview.width).toBeGreaterThan(0);
      expect(preview.height).toBeGreaterThan(0);
      expect(preview.scrollWidth).toBeLessThanOrEqual(preview.clientWidth + 2);
      await expectAxeClean(page, ".setup-flow");
      const previewShot = await page.screenshot({
        path: join(artifactDir, `${combo.name}-setup-preview.png`),
      });
      await testInfo.attach(`${combo.name}-setup-preview.png`, {
        body: previewShot,
        contentType: "image/png",
      });

      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(
        page.locator(".setup-flow .provider-button").first(),
      ).toBeVisible();
      const provider = await page
        .locator(".setup-flow .provider-button")
        .first()
        .evaluate((button) => {
          const root = getComputedStyle(document.documentElement);
          const symbol = button.querySelector(".provider-symbol")!;
          const arrow = button.querySelector(".provider-arrow")!;
          const symbolRect = symbol.getBoundingClientRect();
          const arrowRect = arrow.getBoundingClientRect();
          const buttonRect = button.getBoundingClientRect();
          const copyRect = button
            .querySelector(".provider-copy")!
            .getBoundingClientRect();
          return {
            symbol: symbolRect.width,
            symbolHeight: symbolRect.height,
            arrow: arrowRect.width,
            arrowHeight: arrowRect.height,
            firstColumn: Number.parseFloat(
              getComputedStyle(button).gridTemplateColumns,
            ),
            buttonWidth: buttonRect.width,
            copyRight: copyRect.right,
            arrowLeft: arrowRect.left,
            buttonRight: buttonRect.right,
            textSize: Number.parseFloat(root.fontSize),
          };
        });
      expect(provider.symbol).toBeGreaterThan(0);
      expect(provider.symbolHeight).toBeGreaterThan(0);
      expect(provider.firstColumn).toBeCloseTo(provider.symbol, 0);
      expect(provider.arrow).toBeGreaterThan(0);
      expect(provider.arrowHeight).toBeGreaterThan(0);
      expect(provider.copyRight).toBeLessThan(provider.arrowLeft);
      expect(provider.arrow).toBeLessThan(provider.buttonWidth);
      expect(provider.buttonRight).toBeGreaterThan(provider.arrowLeft);
      expect(provider.textSize).toBe(combo.scale * 16);
      await expectAxeClean(page, ".setup-flow");
      const providerShot = await page.screenshot({
        path: join(artifactDir, `${combo.name}-setup-provider.png`),
      });
      await testInfo.attach(`${combo.name}-setup-provider.png`, {
        body: providerShot,
        contentType: "image/png",
      });

      await page.goto(`/?${query}`);
      await expect(page.locator(".message-row").first()).toBeVisible();
      await expect(page.locator(".account-avatar").first()).toBeVisible();
      await page.getByRole("option", { name: /Weekend plans/i }).click();
      await expect(page.locator(".sender-avatar")).toBeVisible();
      const avatars = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const box = (selector: string) => {
          const rect = document
            .querySelector(selector)!
            .getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        };
        return {
          account: box(".account-avatar"),
          sender: box(".sender-avatar"),
          textSize: Number.parseFloat(root.fontSize),
        };
      });
      expect(avatars.account.width).toBeGreaterThan(0);
      expect(avatars.account.height).toBeGreaterThan(0);
      expect(avatars.sender.width).toBeGreaterThan(0);
      expect(avatars.sender.height).toBeGreaterThan(0);
      expect(
        Math.abs(avatars.account.width - avatars.account.height),
      ).toBeLessThan(1);
      expect(
        Math.abs(avatars.sender.width - avatars.sender.height),
      ).toBeLessThan(1);
      expect(avatars.textSize).toBe(combo.scale * 16);
      const avatarTextFit = await page.evaluate(() => {
        const measure = (selector: string) => {
          const element = document.querySelector<HTMLElement>(selector)!;
          const original = element.textContent;
          element.textContent = "WW";
          const range = document.createRange();
          range.selectNodeContents(element);
          const textRect = range.getBoundingClientRect();
          const avatarRect = element.getBoundingClientRect();
          element.textContent = original;
          return {
            width: avatarRect.width,
            height: avatarRect.height,
            textWidth: textRect.width,
            textHeight: textRect.height,
            fits:
              textRect.left >= avatarRect.left - 1 &&
              textRect.right <= avatarRect.right + 1 &&
              textRect.top >= avatarRect.top - 1 &&
              textRect.bottom <= avatarRect.bottom + 1,
          };
        };
        return {
          account: measure(".account-avatar"),
          sender: measure(".sender-avatar"),
        };
      });
      expect(
        avatarTextFit.account.fits,
        `${combo.name} account avatar: ${JSON.stringify(avatarTextFit.account)}`,
      ).toBe(true);
      expect(
        avatarTextFit.sender.fits,
        `${combo.name} sender avatar: ${JSON.stringify(avatarTextFit.sender)}`,
      ).toBe(true);
      const avatarShot = await page.screenshot({
        path: join(artifactDir, `${combo.name}-avatars.png`),
      });
      await testInfo.attach(`${combo.name}-avatars.png`, {
        body: avatarShot,
        contentType: "image/png",
      });

      await page.getByRole("button", { name: "Reply", exact: true }).click();
      await expect(page.locator(".composer-window")).toBeVisible();
      const composer = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const footer = document.querySelector(
          ".composer-window footer.has-resize-grip",
        )!;
        const editor = document.querySelector(
          ".composer-window > div:has(.composer-editor)",
        )!;
        const editorContent = editor.querySelector(".composer-editor")!;
        const grip = document.querySelector(".composer-resize-grip")!;
        const footerRect = footer.getBoundingClientRect();
        const gripRect = grip.getBoundingClientRect();
        const editorRect = editor.getBoundingClientRect();
        return {
          gutter: Number.parseFloat(getComputedStyle(footer).paddingRight),
          editorMinHeight: Number.parseFloat(
            getComputedStyle(editor).minHeight,
          ),
          editorWidth: editorRect.width,
          contentWidth: editorContent.getBoundingClientRect().width,
          contentScrollWidth: editorContent.scrollWidth,
          footerWidth: footerRect.width,
          gripWidth: gripRect.width,
          gripRight: gripRect.right,
          footerRight: footerRect.right,
          textSize: Number.parseFloat(root.fontSize),
        };
      });
      expect(composer.gutter).toBeGreaterThanOrEqual(composer.gripWidth);
      expect(composer.editorMinHeight).toBeGreaterThan(0);
      expect(composer.editorWidth).toBeGreaterThan(0);
      expect(composer.contentWidth).toBeGreaterThan(0);
      expect(composer.contentScrollWidth).toBeLessThanOrEqual(
        composer.contentWidth + 2,
      );
      expect(composer.gripRight).toBeCloseTo(composer.footerRight, 0);
      expect(composer.gripWidth).toBeGreaterThanOrEqual(32);
      expect(composer.footerWidth).toBeGreaterThan(composer.gripWidth);
      expect(composer.textSize).toBe(combo.scale * 16);
      await expectAxeClean(page, ".composer-window");
      const composerShot = await page.screenshot({
        path: join(artifactDir, `${combo.name}-composer.png`),
      });
      await testInfo.attach(`${combo.name}-composer.png`, {
        body: composerShot,
        contentType: "image/png",
      });

      metrics[combo.name] = {
        preview,
        provider,
        avatars,
        avatarTextFit,
        composer,
      };
      await writeFile(
        join(artifactDir, "metrics.json"),
        `${JSON.stringify(metrics, null, 2)}\n`,
      );
      await attachArtifacts(page, testInfo, `css-tokens-${combo.name}`);
    }

    for (const scale of [1, 2]) {
      const comfortable = metrics[`comfortable-${scale}x`] as {
        provider: { symbol: number; arrow: number };
        avatars: { account: { width: number }; sender: { width: number } };
        preview: { firstColumn: number };
        composer: { editorMinHeight: number };
      };
      const compact = metrics[`compact-${scale}x`] as typeof comfortable;
      expect(compact.avatars.account.width).toBeLessThan(
        comfortable.avatars.account.width,
      );
      expect(compact.avatars.sender.width).toBeLessThan(
        comfortable.avatars.sender.width,
      );
      expect(compact.provider.symbol).toBeLessThan(comfortable.provider.symbol);
      expect(compact.provider.arrow).toBeLessThan(comfortable.provider.arrow);
      expect(compact.preview.firstColumn).toBeLessThan(
        comfortable.preview.firstColumn,
      );
      expect(compact.composer.editorMinHeight).toBeLessThan(
        comfortable.composer.editorMinHeight,
      );
    }

    await writeFile(
      join(artifactDir, "metrics.json"),
      `${JSON.stringify(metrics, null, 2)}\n`,
    );
  });

  test("keeps the composer body visible and scrollable at large text in a short window", async ({
    page,
  }, testInfo) => {
    await installMockIpc(page);
    await mkdir(artifactDir, { recursive: true });
    const metrics: Record<string, unknown> = {};

    try {
      for (const combo of combos) {
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.goto(`/?density=${combo.density}&scale=${combo.scale}`);
        await page
          .getByRole("button", { name: "Compose", exact: true })
          .click();

        const composer = page.locator(".composer-window");
        const subject = composer.locator("#composer-subject");
        const recipient = composer.locator("#composer-to");
        const body = page.getByRole("textbox", {
          name: "Message body",
          exact: true,
        });
        const content = Array.from(
          { length: 32 },
          (_, index) => `Body line ${index + 1}: readable text for scrolling.`,
        ).join("\n");

        await expect(recipient).toBeVisible();
        await expect(subject).toBeVisible();
        await subject.fill(`Composer ${combo.name}`);
        await body.fill(content);
        await expect(body).toContainText("Body line 1");
        await body.focus();
        await expect(body).toBeFocused();

        const geometry = await body.evaluate((element) => {
          const editor = element as HTMLElement;
          const editorRect = editor.getBoundingClientRect();
          const composer = editor.closest<HTMLElement>(".composer-window")!;
          const footer = composer.querySelector<HTMLElement>("footer")!;
          const footerRect = footer.getBoundingClientRect();
          editor.scrollTop = 0;
          const firstParagraph = editor.querySelector("p")!;
          const range = document.createRange();
          range.selectNodeContents(firstParagraph);
          const textRect = range.getBoundingClientRect();
          const visibleBottom = Math.min(
            editorRect.bottom,
            footerRect.top,
            window.innerHeight,
          );
          return {
            editorHeight: editorRect.height,
            editorClientHeight: editor.clientHeight,
            editorScrollHeight: editor.scrollHeight,
            textTop: textRect.top,
            textBottom: textRect.bottom,
            textVisible:
              textRect.width > 0 &&
              textRect.height > 0 &&
              textRect.top >= editorRect.top - 1 &&
              textRect.bottom <= visibleBottom + 1,
            footerTop: footerRect.top,
            viewportHeight: window.innerHeight,
          };
        });

        expect(
          geometry.editorHeight,
          `${combo.name}: ${JSON.stringify(geometry)}`,
        ).toBeGreaterThanOrEqual(96);
        expect(
          geometry.textVisible,
          `${combo.name}: body text is obscured`,
        ).toBe(true);
        expect(geometry.editorScrollHeight).toBeGreaterThan(
          geometry.editorClientHeight,
        );

        const scrollTop = await body.evaluate((element) => {
          const editor = element as HTMLElement;
          editor.scrollTop = editor.scrollHeight;
          return editor.scrollTop;
        });
        expect(scrollTop, `${combo.name}: body did not scroll`).toBeGreaterThan(
          0,
        );
        await expect(
          composer.getByRole("button", { name: "Send", exact: true }),
        ).toBeVisible();
        await expectAxeClean(page, ".composer-window");

        const screenshot = await page.screenshot({
          path: join(artifactDir, `${combo.name}-short-composer.png`),
        });
        await testInfo.attach(`${combo.name}-short-composer.png`, {
          body: screenshot,
          contentType: "image/png",
        });
        metrics[combo.name] = geometry;
        await writeFile(
          join(artifactDir, "short-composer-metrics.json"),
          `${JSON.stringify(metrics, null, 2)}\n`,
        );
      }
    } finally {
      await attachArtifacts(page, testInfo, "css-token-short-composer");
    }
  });

  test("keeps a recovered compact 200% draft body exposed above the footer", async ({
    page,
  }, testInfo) => {
    await installMockIpc(page);
    await mkdir(artifactDir, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(() => {
      type SavedDraft = Record<string, unknown>;
      type RecoveryWindow = Window & {
        __cssComposerFault?: boolean;
        __cssSavedDrafts?: Record<string, SavedDraft>;
        __POSTAL_SNAP_MOCK__?: {
          handlers: Record<
            string,
            (args: Record<string, unknown>) => Promise<unknown> | unknown
          >;
        };
      };
      const scope = window as RecoveryWindow;
      const mock = scope.__POSTAL_SNAP_MOCK__!;
      const originalList = mock.handlers.list_drafts;
      mock.handlers.list_drafts = async (args) => {
        const existing = (await originalList(args)) as Array<
          Record<string, unknown>
        >;
        const summaries = Object.entries(scope.__cssSavedDrafts ?? {}).map(
          ([id, saved]) => ({
            id,
            accountId: String(args.accountId),
            recipients: Array.isArray(saved.to) ? saved.to.join(", ") : "",
            subject: String(saved.subject ?? ""),
            updatedAt: new Date().toISOString(),
            syncState: "localOnly",
            syncDetail: scope.__cssComposerFault
              ? { reason: "forced render failure" }
              : "Saved on this device",
            preview: String(saved.textBody ?? "").split("\n", 1)[0],
            attachmentCount: 0,
            fromAddress: null,
          }),
        );
        return [...summaries, ...existing];
      };
      mock.handlers.save_draft = async (args) => {
        const draft = { ...(args.draft as SavedDraft), id: "draft-css-saved" };
        scope.__cssSavedDrafts = {
          ...scope.__cssSavedDrafts,
          ["draft-css-saved"]: draft,
        };
        return { id: "draft-css-saved", syncState: "localPending" };
      };
      const originalGet = mock.handlers.get_draft;
      mock.handlers.get_draft = async (args) => {
        const base = (await originalGet(args)) as SavedDraft;
        const saved = scope.__cssSavedDrafts?.[String(args.draftId)];
        return saved ? { ...base, ...saved } : base;
      };
    });

    try {
      await page.goto(
        "/?density=compact&scale=2&composerWidth=940&composerHeight=620",
      );
      await page.getByRole("button", { name: "Compose", exact: true }).click();
      const subject = page.getByRole("textbox", {
        name: "Subject",
        exact: true,
      });
      const recipient = page.locator("#composer-to");
      const body = page.getByRole("textbox", {
        name: "Message body",
        exact: true,
      });
      await recipient.fill("pat@example.com");
      await subject.fill("Recovered compact draft");
      await body.fill(
        Array.from(
          { length: 16 },
          (_, index) =>
            `Recovered body line ${index + 1} remains editable and visible`,
        ).join("\n"),
      );
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await expect(page.getByText(/Draft saved/).first()).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(() => {
            const scope = window as Window & {
              __cssSavedDrafts?: Record<string, Record<string, unknown>>;
            };
            return scope.__cssSavedDrafts?.["draft-css-saved"]?.subject;
          }),
        )
        .toBe("Recovered compact draft");

      await page.evaluate(() => {
        const scope = window as Window & { __cssComposerFault?: boolean };
        scope.__cssComposerFault = true;
      });
      const accountId = await page.evaluate(async () => {
        const mock = (
          window as Window & {
            __POSTAL_SNAP_MOCK__: {
              handlers: Record<
                string,
                (args: Record<string, unknown>) => Promise<unknown> | unknown
              >;
            };
          }
        ).__POSTAL_SNAP_MOCK__;
        const accounts = (await mock.handlers.list_accounts({})) as Array<{
          id: string;
        }>;
        return accounts[0].id;
      });
      await emitTauriEvent(page, "draft-sync-changed", {
        accountId,
        draftId: "draft-css-saved",
        syncState: "failed",
      });
      const recovery = page
        .locator("body .crash-recovery")
        .filter({ hasText: "Something went wrong in this window" });
      await expect(recovery).toBeVisible();
      await page.evaluate(() => {
        const scope = window as Window & { __cssComposerFault?: boolean };
        scope.__cssComposerFault = false;
      });
      await recovery
        .getByRole("button", { name: "Try again", exact: true })
        .click();
      await expect(subject).toHaveValue("Recovered compact draft");
      await expect(body).toContainText(
        "Recovered body line 1 remains editable and visible",
      );
      await expect(subject).toBeVisible();
      const composer = page.locator(".composer-window");
      const syncBanner = composer.locator(".draft-sync-banner");
      const beforeScroll = await composer.evaluate(
        (element) => element.scrollTop,
      );
      const bannerBox = await syncBanner.boundingBox();
      if (!bannerBox) throw new Error("draft status banner is not visible");
      await page.mouse.move(
        bannerBox.x + bannerBox.width / 2,
        bannerBox.y + bannerBox.height / 2,
      );
      await page.mouse.wheel(0, 320);
      await expect
        .poll(() => composer.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(beforeScroll);
      await body.focus();
      await expect(body).toBeFocused();

      const geometry = await body.evaluate((element) => {
        const editor = element as HTMLElement;
        const editorRect = editor.getBoundingClientRect();
        const composer = editor.closest<HTMLElement>(".composer-window")!;
        const composerRect = composer.getBoundingClientRect();
        const headerRect = composer
          .querySelector<HTMLElement>(":scope > header")!
          .getBoundingClientRect();
        const footer = composer.querySelector<HTMLElement>("footer")!;
        const footerRect = footer.getBoundingClientRect();
        editor.scrollTop = 0;
        const text = document.createRange();
        text.selectNodeContents(editor.querySelector("p")!);
        const textRect = text.getBoundingClientRect();
        const exposedTop = Math.max(0, composerRect.top, editorRect.top);
        const exposedBottom = Math.min(
          editorRect.bottom,
          footerRect.top,
          composerRect.bottom,
          window.innerHeight,
        );
        return {
          editorTop: editorRect.top,
          editorBottom: editorRect.bottom,
          composerTop: composerRect.top,
          headerTop: headerRect.top,
          footerTop: footerRect.top,
          exposedHeight: Math.max(0, exposedBottom - exposedTop),
          textTop: textRect.top,
          textBottom: textRect.bottom,
          textExposed:
            textRect.width > 0 &&
            textRect.height > 0 &&
            textRect.bottom <= exposedBottom + 1 &&
            textRect.top >= exposedTop - 1,
        };
      });
      const screenshot = await page.screenshot({
        path: join(artifactDir, "compact-2x-recovered-composer.png"),
      });
      await testInfo.attach("compact-2x-recovered-composer.png", {
        body: screenshot,
        contentType: "image/png",
      });
      expect(
        geometry.exposedHeight,
        `Recovered compact 200% editor exposure: ${JSON.stringify(geometry)}`,
      ).toBeGreaterThanOrEqual(64);
      expect(geometry.textExposed).toBe(true);
      expect(
        Math.abs(geometry.headerTop - geometry.composerTop),
      ).toBeLessThanOrEqual(2);
      expect(geometry.footerTop).toBeGreaterThanOrEqual(
        geometry.editorBottom - 1,
      );
      await expect(
        body.evaluate((element) => {
          const editor = element as HTMLElement;
          return editor.scrollHeight > editor.clientHeight;
        }),
      ).resolves.toBe(true);
      const scrollTop = await body.evaluate((element) => {
        const editor = element as HTMLElement;
        editor.scrollTop = editor.scrollHeight;
        return editor.scrollTop;
      });
      expect(scrollTop).toBeGreaterThan(0);
      const send = page.getByRole("button", { name: "Send", exact: true });
      await send.focus();
      await expect(send).toBeFocused();
      await expect(send).toBeInViewport();
      await expectAxeClean(page, ".composer-window");
    } finally {
      await attachArtifacts(page, testInfo, "css-tokens-recovered-composer");
    }
  });

  test("avatar palette remains distinct and legible in forced colors", async ({
    page,
  }, testInfo) => {
    await installMockIpc(page);
    await page.goto("/?density=comfortable&scale=1");
    await page.evaluate(() => {
      const colors = [
        "teal",
        "green",
        "amber",
        "orange",
        "red",
        "pink",
        "purple",
      ];
      const host = document.createElement("section");
      host.id = "avatar-palette-fixture";
      host.setAttribute("aria-label", "Account avatar colors");
      host.innerHTML = `<div role="radiogroup" aria-label="Account colors">${colors
        .map(
          (color, index) =>
            `<button type="button" role="radio" aria-checked="${index === 0}" class="account-color-swatch" data-color="${color}" aria-label="${color} account color"></button>`,
        )
        .join("")}</div><div aria-hidden="true">${colors
        .map(
          (color) =>
            `<span class="account-avatar" data-color="${color}">A</span>`,
        )
        .join("")}</div>`;
      document.body.append(host);
    });

    const palette = await page.evaluate(() => {
      return [
        ...document.querySelectorAll<HTMLButtonElement>(
          "#avatar-palette-fixture .account-color-swatch",
        ),
      ].map((button) => {
        const avatar = document.querySelector<HTMLElement>(
          `#avatar-palette-fixture .account-avatar[data-color="${button.dataset.color}"]`,
        )!;
        return {
          background: getComputedStyle(button).backgroundColor,
          avatarBackground: getComputedStyle(avatar).backgroundColor,
        };
      });
    });
    expect(palette).toHaveLength(7);
    expect(
      palette.every((color) => color.background === color.avatarBackground),
    ).toBe(true);
    expect(new Set(palette.map((color) => color.background)).size).toBe(7);

    await page.emulateMedia({ forcedColors: "active" });
    await page
      .locator("#avatar-palette-fixture .account-color-swatch")
      .first()
      .focus();
    await page.keyboard.press("Tab");
    const fallback = await page.evaluate(() => {
      const sample = (color: string) => {
        const probe = document.createElement("div");
        probe.style.color = color;
        probe.style.backgroundColor = color;
        document.body.append(probe);
        const style = getComputedStyle(probe);
        const result = {
          color: style.color,
          background: style.backgroundColor,
        };
        probe.remove();
        return result;
      };
      const canvas = sample("Canvas");
      const canvasText = sample("CanvasText").color;
      const highlight = sample("Highlight").background;
      const swatches = [
        ...document.querySelectorAll<HTMLButtonElement>(
          "#avatar-palette-fixture .account-color-swatch",
        ),
      ];
      const avatars = [
        ...document.querySelectorAll<HTMLElement>(
          "#avatar-palette-fixture .account-avatar",
        ),
      ];
      const focused = document.querySelector<HTMLButtonElement>(
        "#avatar-palette-fixture .account-color-swatch:focus-visible",
      )!;
      return {
        canvas: canvas.background,
        canvasText,
        highlight,
        swatchBackgrounds: swatches.map(
          (swatch) => getComputedStyle(swatch).backgroundColor,
        ),
        avatarBackgrounds: avatars.map(
          (avatar) => getComputedStyle(avatar).backgroundColor,
        ),
        selectedBorder: getComputedStyle(swatches[0]).borderTopColor,
        avatarText: getComputedStyle(avatars[0]).color,
        focusOutline: getComputedStyle(focused).outlineColor,
        focusWidth: getComputedStyle(focused).outlineWidth,
      };
    });
    expect(
      fallback.swatchBackgrounds.every((color) => color === fallback.canvas),
    ).toBe(true);
    expect(
      fallback.avatarBackgrounds.every((color) => color === fallback.canvas),
    ).toBe(true);
    expect(fallback.avatarText).toBe(fallback.canvasText);
    expect(fallback.selectedBorder).toBe(fallback.highlight);
    expect(fallback.focusOutline).toBe(fallback.highlight);
    expect(Number.parseFloat(fallback.focusWidth)).toBeGreaterThan(0);
    await expectAxeClean(page, "#avatar-palette-fixture");
    const screenshot = await page.screenshot({
      path: join(artifactDir, "avatar-forced-colors.png"),
    });
    await testInfo.attach("avatar-forced-colors.png", {
      body: screenshot,
      contentType: "image/png",
    });
    await attachArtifacts(page, testInfo, "avatar-forced-colors");
  });
});
