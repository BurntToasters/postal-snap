import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

async function dismissConfirmFor(page: Page, action: () => Promise<void>) {
  const dialogType = page.waitForEvent("dialog").then(async (dialog) => {
    const type = dialog.type();
    await dialog.dismiss();
    return type;
  });
  await action();
  expect(await dialogType).toBe("confirm");
}

async function acceptConfirmFor(page: Page, action: () => Promise<void>) {
  const dialogType = page.waitForEvent("dialog").then(async (dialog) => {
    const type = dialog.type();
    await dialog.accept();
    return type;
  });
  await action();
  expect(await dialogType).toBe("confirm");
}

async function scanSettings(page: Page, rules: string[]) {
  const result = await new AxeBuilder({ page })
    .include(".settings-window")
    .withRules(rules)
    .analyze();
  expect(
    result.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
}

async function attachArtifacts(page: Page, testInfo: TestInfo) {
  if (page.isClosed() || page.url() === "about:blank") return;
  const screenshotPath = testInfo.outputPath("settings-focus.png");
  await page.screenshot({ path: screenshotPath, animations: "disabled" });
  await testInfo.attach("settings-focus.png", {
    path: screenshotPath,
    contentType: "image/png",
  });
  const contentRegion = page.locator(".settings-content");
  if (!(await contentRegion.count())) return;
  const metrics = await contentRegion.evaluate((region) => ({
    scrollTop: region.scrollTop,
    scrollHeight: region.scrollHeight,
    clientHeight: region.clientHeight,
    tabIndex: region.tabIndex,
    role: region.getAttribute("role"),
    label: region.getAttribute("aria-label"),
    activeElement:
      document.activeElement instanceof HTMLElement
        ? {
            tagName: document.activeElement.tagName,
            role: document.activeElement.getAttribute("role"),
            label: document.activeElement.getAttribute("aria-label"),
            text: document.activeElement.textContent?.trim().slice(0, 80),
          }
        : null,
  }));
  await testInfo.attach("settings-focus-metrics.json", {
    body: JSON.stringify(metrics, null, 2),
    contentType: "application/json",
  });
}

test.beforeEach(async ({ page }) => {
  await installMockIpc(page);
  await page.setViewportSize({ width: 1280, height: 800 });
});

test.afterEach(async ({ page }, testInfo) => attachArtifacts(page, testInfo));

test("all settings views expose a scroll region and valid tab relationships", async ({
  page,
}) => {
  await page.goto("/?localMail=1&multiAccount=1");
  await page.getByRole("button", { name: "Settings" }).click();

  const tabs = [
    "General",
    "Appearance",
    "Reading & Sending",
    "Notifications",
    "Storage",
    "Accounts",
    "Shortcuts",
    "Updates",
    "Advanced",
    "About",
  ];
  const accessibilityRules = [
    "scrollable-region-focusable",
    "aria-valid-attr-value",
    "aria-roles",
    "duplicate-id",
  ];
  const region = page.locator(".settings-content");

  for (const name of tabs) {
    const tab = page.getByRole("tab", { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(region).toHaveAttribute("role", "region");
    await expect(region).toHaveAttribute("tabindex", "0");
    await expect(region).toHaveAccessibleName(name);
    const controlledId = await tab.getAttribute("aria-controls");
    expect(controlledId).toBeTruthy();
    await expect(page.locator(`#${controlledId}`)).toHaveCount(1);
    await scanSettings(page, accessibilityRules);
  }

  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  await page.getByRole("button", { name: "Manage Work", exact: true }).click();
  await scanSettings(page, accessibilityRules);
  for (const name of ["Connection", "Folders", "Identity", "Rules"]) {
    const pageButton = page.getByRole("button", { name, exact: true });
    await pageButton.click();
    await expect(pageButton).toHaveAttribute("aria-pressed", "true");
    await scanSettings(page, accessibilityRules);
  }

  await page.getByRole("tab", { name: "Shortcuts", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search settings" });
  const shortcutsTab = page.getByRole("tab", {
    name: "Shortcuts",
    exact: true,
  });
  await search.fill("signature");
  await expect(shortcutsTab).toHaveAttribute("aria-selected", "true");
  const searchControls = await shortcutsTab.getAttribute("aria-controls");
  if (searchControls) {
    await expect(page.locator(`#${searchControls}`)).toHaveCount(1);
  }
  await scanSettings(page, accessibilityRules);
  await search.fill("no-settings-match-93842");
  await expect(region.getByRole("status")).toContainText("No settings found");
  await scanSettings(page, accessibilityRules);

  await search.fill("");
  await shortcutsTab.click();
  const result = page.getByRole("button", { name: /Email signature/ });
  await search.fill("signature");
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.getByLabel("Email signature")).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Identity", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("tab", { name: "Accounts", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await scanSettings(page, accessibilityRules);

  await page.getByRole("tab", { name: "Advanced", exact: true }).click();
  const threatSwitch = page.locator(".switch-row input[type=checkbox]").nth(1);
  await threatSwitch.click();
  await expect(threatSwitch).toBeChecked();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await scanSettings(page, accessibilityRules);
});

test("Shortcuts scrolls by keyboard across density, scale, and narrow layouts", async ({
  page,
}) => {
  const observations: Array<Record<string, unknown>> = [];
  for (const density of ["comfortable", "compact"]) {
    for (const scale of [1, 2]) {
      await page.goto(`/?localMail=1&density=${density}&scale=${scale}`);
      await page.getByRole("button", { name: "Settings" }).click();
      const shortcutsTab = page.getByRole("tab", {
        name: "Shortcuts",
        exact: true,
      });
      await shortcutsTab.click();
      await expect(shortcutsTab).toHaveAttribute("aria-selected", "true");
      const region = page.locator(".settings-content");
      await page.keyboard.press("Tab");
      await expect(region).toBeFocused();
      const before = await region.evaluate((element) => element.scrollTop);
      await page.keyboard.press("ArrowDown");
      await expect
        .poll(() => region.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(before);
      const afterArrow = await region.evaluate((element) => element.scrollTop);
      await page.keyboard.press("PageDown");
      await expect
        .poll(() => region.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(afterArrow);
      await scanSettings(page, ["scrollable-region-focusable"]);
      observations.push({
        density,
        scale,
        scrollTop: await region.evaluate((element) => element.scrollTop),
        scrollHeight: await region.evaluate((element) => element.scrollHeight),
        clientHeight: await region.evaluate((element) => element.clientHeight),
      });
    }
  }

  await page.goto("/?localMail=1&density=compact&scale=2");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.setViewportSize({ width: 650, height: 800 });
  await expect(
    page.getByRole("combobox", { name: "Settings section" }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Settings section" })
    .selectOption("shortcuts");
  const sectionSelector = page.getByRole("combobox", {
    name: "Settings section",
  });
  await sectionSelector.focus();
  const region = page.locator(".settings-content");
  await page.keyboard.press("Tab");
  await expect(region).toBeFocused();
  const before = await region.evaluate((element) => element.scrollTop);
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(() => region.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(before);
  const afterArrow = await region.evaluate((element) => element.scrollTop);
  await page.keyboard.press("PageDown");
  await expect
    .poll(() => region.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(afterArrow);
  await scanSettings(page, ["scrollable-region-focusable"]);
  observations.push({
    density: "compact",
    scale: 2,
    viewportWidth: 650,
    scrollTop: await region.evaluate((element) => element.scrollTop),
  });

  await page.setViewportSize({ width: 620, height: 540 });
  await expect(sectionSelector).toBeVisible();
  await sectionSelector.focus();
  await page.keyboard.press("Tab");
  await expect(region).toBeFocused();
  const layout = page.locator(".settings-layout");
  await expect
    .poll(() =>
      layout.evaluate((element) => element.scrollHeight - element.clientHeight),
    )
    .toBeGreaterThan(0);
  const layoutBefore = await layout.evaluate((element) => element.scrollTop);
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(() => layout.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(layoutBefore);
  const layoutAfterArrow = await layout.evaluate(
    (element) => element.scrollTop,
  );
  await page.keyboard.press("PageDown");
  await expect
    .poll(() => layout.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(layoutAfterArrow);
  observations.push({
    density: "compact",
    scale: 2,
    viewportWidth: 620,
    viewportHeight: 540,
    ancestorScrollTop: await layout.evaluate((element) => element.scrollTop),
    ancestorScrollHeight: await layout.evaluate(
      (element) => element.scrollHeight,
    ),
    ancestorClientHeight: await layout.evaluate(
      (element) => element.clientHeight,
    ),
  });

  await page.emulateMedia({ forcedColors: "active" });
  await region.focus();
  const focusOutline = await region.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(focusOutline.style).not.toBe("none");
  expect(Number.parseFloat(focusOutline.width)).toBeGreaterThanOrEqual(2);
  await test.info().attach("settings-scroll-metrics.json", {
    body: JSON.stringify({ observations, focusOutline }, null, 2),
    contentType: "application/json",
  });
});

test("account navigation restores focus without bypassing dirty form guards", async ({
  page,
}) => {
  await page.goto("/?localMail=1&multiAccount=1");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  const manageWork = page.getByRole("button", {
    name: "Manage Work",
    exact: true,
  });
  await manageWork.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".account-detail-nav button.active")).toBeFocused();

  await page.getByRole("button", { name: "Identity", exact: true }).click();
  await page.getByLabel("Name on mail you send").fill("Unsaved Work identity");
  const back = page.getByRole("button", { name: "Back to accounts" });
  await back.focus();
  await dismissConfirmFor(page, () => page.keyboard.press("Enter"));
  await expect(back).toBeFocused();
  await expect(page.getByLabel("Name on mail you send")).toHaveValue(
    "Unsaved Work identity",
  );

  await acceptConfirmFor(page, () => page.keyboard.press("Enter"));
  await expect(manageWork).toBeFocused();
  await expect(manageWork).toBeVisible();
});

test("reported-threat confirmation returns focus to its switch", async ({
  page,
}) => {
  await page.goto("/?localMail=1");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Advanced", exact: true }).click();
  const threatSwitch = page.locator(".switch-row input[type=checkbox]").nth(1);

  await threatSwitch.click();
  await expect(threatSwitch).toBeChecked();
  const confirmation = page.getByRole("alertdialog");
  const token = page.getByRole("textbox", { name: "Type CONFIRM" });
  await expect(token).toBeFocused();
  await token.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(threatSwitch).toBeFocused();

  await threatSwitch.click();
  await expect(threatSwitch).toBeChecked();
  await page.getByRole("button", { name: "Keep protection on" }).click();
  await expect(threatSwitch).toBeFocused();
  await expect(threatSwitch).toBeChecked();

  await threatSwitch.click();
  await expect(threatSwitch).toBeChecked();
  await page.locator(".settings-confirm-overlay").click({
    position: { x: 5, y: 5 },
  });
  await expect(confirmation).toHaveCount(0);
  await expect(threatSwitch).toBeFocused();
  await expect(threatSwitch).toBeChecked();

  await threatSwitch.click();
  await expect(threatSwitch).toBeChecked();
  await token.fill("CONFIRM ");
  await expect(page.getByRole("button", { name: "Disable" })).toBeDisabled();
  await token.fill("CONFIRM");
  await page.getByRole("button", { name: "Disable" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(threatSwitch).toBeFocused();
  await expect(threatSwitch).not.toBeChecked();
});

test("focus trapping skips inactive tabs and defers to nested dialogs", async ({
  page,
}) => {
  await page.goto("/?localMail=1");
  await page.getByRole("button", { name: "Settings" }).click();
  const close = page.getByRole("button", { name: "Close settings" });
  await close.focus();

  let sawInactiveTab = false;
  for (let index = 0; index < 50; index += 1) {
    await page.keyboard.press("Tab");
    const state = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        isInactiveTab:
          active instanceof HTMLElement &&
          active.getAttribute("role") === "tab" &&
          active.tabIndex < 0,
        closeFocused:
          active instanceof HTMLElement &&
          active.getAttribute("aria-label") === "Close settings",
      };
    });
    sawInactiveTab ||= state.isInactiveTab;
    if (state.closeFocused) break;
  }
  expect(sawInactiveTab).toBe(false);

  await page.getByRole("tab", { name: "About", exact: true }).click();
  await page.getByRole("button", { name: "Licenses and credits" }).click();
  const credits = page.getByRole("dialog", { name: "Licenses and credits" });
  await expect(credits).toBeVisible();
  const closeCredits = credits.getByRole("button", { name: "Close" });
  await expect(closeCredits).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(credits.locator("summary").first()).toBeFocused();
});
