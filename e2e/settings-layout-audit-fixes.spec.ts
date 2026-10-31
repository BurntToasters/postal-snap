import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

test.beforeEach(async ({ page }) => installMockIpc(page));

for (const density of ["comfortable", "compact"] as const) {
  for (const scale of [1, 2] as const) {
    for (const theme of ["light", "dark"] as const) {
      test(`short settings rows remain reachable at ${density}, ${scale * 100}%, ${theme}`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width: 620, height: 540 });
        await page.goto(`/?density=${density}&scale=${scale}&theme=${theme}`);
        await page.getByRole("button", { name: "Settings" }).first().click();

        const dialog = page.locator(".settings-window");
        const close = dialog.getByRole("button", { name: "Close settings" });
        await expect(close).toBeVisible();

        const sectionSelect = page.locator(".settings-section-select select");
        await expect(sectionSelect).toBeVisible();
        await sectionSelect.selectOption("about");
        await expect(page.locator("#settings-about")).toBeVisible();
        await sectionSelect.selectOption("appearance");
        await expect(page.locator("#settings-appearance")).toBeVisible();

        const textSize = page.getByRole("combobox", { name: "Text size" });
        await sectionSelect.focus();
        let keyboardReachedTextSize = false;
        for (let index = 0; index < 12; index += 1) {
          await page.keyboard.press("Tab");
          keyboardReachedTextSize = await textSize.evaluate(
            (node) => document.activeElement === node,
          );
          if (keyboardReachedTextSize) break;
        }
        expect(keyboardReachedTextSize).toBe(true);
        await expect(textSize).toBeFocused();

        const geometry = await page.evaluate(() => {
          const layout =
            document.querySelector<HTMLElement>(".settings-layout");
          const content =
            document.querySelector<HTMLElement>(".settings-content");
          const currentRow = document.querySelector<HTMLElement>(
            '#settings-appearance .settings-row:has(select[aria-label="Text size"])',
          );
          const control = currentRow?.querySelector<HTMLElement>(
            'select[aria-label="Text size"]',
          );
          if (!layout || !content || !currentRow || !control) return null;
          const layoutBox = layout.getBoundingClientRect();
          const contentBox = content.getBoundingClientRect();
          const rowBox = currentRow.getBoundingClientRect();
          const controlBox = control.getBoundingClientRect();
          return {
            layoutClientHeight: layout.clientHeight,
            layoutScrollHeight: layout.scrollHeight,
            layoutTop: layoutBox.top,
            layoutBottom: layoutBox.bottom,
            contentClientHeight: content.clientHeight,
            contentScrollHeight: content.scrollHeight,
            contentTop: contentBox.top,
            contentBottom: contentBox.bottom,
            rowTop: rowBox.top,
            rowBottom: rowBox.bottom,
            rowHeight: rowBox.height,
            controlTop: controlBox.top,
            controlBottom: controlBox.bottom,
            controlHeight: controlBox.height,
            layoutScrollTop: layout.scrollTop,
          };
        });

        expect(geometry, `${density}/${scale}/${theme}`).not.toBeNull();
        if (!geometry) return;
        expect(geometry.rowHeight).toBeGreaterThan(geometry.controlHeight);
        expect(geometry.rowHeight).toBeLessThanOrEqual(
          geometry.layoutClientHeight,
        );
        expect(geometry.rowTop).toBeGreaterThanOrEqual(geometry.layoutTop - 1);
        expect(geometry.rowBottom).toBeLessThanOrEqual(
          geometry.layoutBottom + 1,
        );
        expect(geometry.controlTop).toBeGreaterThanOrEqual(
          geometry.layoutTop - 1,
        );
        expect(geometry.controlBottom).toBeLessThanOrEqual(
          geometry.layoutBottom + 1,
        );

        await textSize.click();
        const selectedScale = scale === 1 ? "1.15" : "1.75";
        await textSize.selectOption(selectedScale);
        await expect(textSize).toHaveValue(selectedScale);
        await expect(page.locator("html")).toHaveAttribute(
          "data-text-scale",
          Number(selectedScale) >= 1.5 ? "large" : "normal",
        );

        const measurements = {
          viewport: { width: 620, height: 540 },
          density,
          scale,
          theme,
          geometry,
          keyboardReachedTextSize,
          pointerSelectedTextSize: Number(selectedScale),
        };
        const screenshotPath = testInfo.outputPath("settings-layout.png");
        await page.screenshot({ path: screenshotPath, fullPage: false });
        await testInfo.attach("settings-layout-screenshot", {
          path: screenshotPath,
          contentType: "image/png",
        });
        await testInfo.attach("settings-layout-measurements", {
          body: JSON.stringify(measurements, null, 2),
          contentType: "application/json",
        });
      });
    }
  }
}

test("About link hover stays visible in forced colors", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/?density=comfortable&scale=1&theme=light");
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByRole("tab", { name: "About", exact: true }).click();

  const source = page.getByRole("button", { name: "Source code" });
  await source.hover();
  const hover = await source.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
    };
  });
  expect(hover.outlineStyle).toBe("solid");
  expect(Number.parseFloat(hover.outlineWidth)).toBeGreaterThanOrEqual(2);
  await testInfo.attach("about-link-forced-colors-hover", {
    body: JSON.stringify(hover, null, 2),
    contentType: "application/json",
  });
});

for (const density of ["comfortable", "compact"] as const) {
  for (const scale of [1, 2] as const) {
    for (const theme of ["light", "dark"] as const) {
      test(`About link contrast passes at ${density}, ${scale * 100}%, ${theme}`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({ width: 1280, height: 820 });
        await page.goto(`/?density=${density}&scale=${scale}&theme=${theme}`);
        await page.getByRole("button", { name: "Settings" }).first().click();
        await page.getByRole("tab", { name: "About", exact: true }).click();
        await expect(
          page.getByRole("button", { name: "Source code" }),
        ).toBeVisible();

        const links = page.locator(".settings-link-row");
        const restingContrast = await new AxeBuilder({ page })
          .include(".settings-link-row")
          .withRules(["color-contrast"])
          .analyze();
        expect(restingContrast.violations).toEqual([]);

        const restingColor = await links.first().evaluate((node) => ({
          color: getComputedStyle(node).color,
          linkBackground: getComputedStyle(node).backgroundColor,
          groupFill: getComputedStyle(node.parentElement!).backgroundColor,
          surface: getComputedStyle(node.closest(".settings-content")!)
            .backgroundColor,
        }));
        await links.first().hover();
        const hoveredContrast = await new AxeBuilder({ page })
          .include(".settings-link-row")
          .withRules(["color-contrast"])
          .analyze();
        expect(hoveredContrast.violations).toEqual([]);
        const hoveredColor = await links.first().evaluate((node) => ({
          color: getComputedStyle(node).color,
          linkBackground: getComputedStyle(node).backgroundColor,
          groupFill: getComputedStyle(node.parentElement!).backgroundColor,
          surface: getComputedStyle(node.closest(".settings-content")!)
            .backgroundColor,
        }));
        await testInfo.attach("about-link-contrast", {
          body: JSON.stringify(
            {
              density,
              scale,
              theme,
              restingColor,
              hoveredColor,
              restingViolations: restingContrast.violations,
              hoveredViolations: hoveredContrast.violations,
            },
            null,
            2,
          ),
          contentType: "application/json",
        });
      });
    }
  }
}
