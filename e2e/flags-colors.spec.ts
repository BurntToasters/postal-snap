import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";
import { attachArtifactsAfterEach, ipcCalls } from "./ipc";

test.afterEach(attachArtifactsAfterEach);

// Failure modes covered here:
// FM1. Choosing Orange from the row menu does not send color 1 for the message.
// FM2. A flagged row lacks the "Flagged, Orange" name or a glyph tinted by --flag-orange.
// FM3. Clear Flag leaves the glyph or sends a non-null color.
// FM4. The flag:green operator is rewritten before it reaches search.
// FM5. The glyph disappears under forced colors.
// FM6. The flag submenu cannot be reached or used from the keyboard alone.
// FM7. The row menu overflows the viewport at 200% text.
// FM8. A mailbox without keyword support enables color items, or blocks plain Flag.
// FM9. Multi-select applies the color to only one of the checked messages.

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const path = `test-results/flags-colors-${slug}.png`;
  await page.screenshot({ path });
  await testInfo.attach("screenshot", { path, contentType: "image/png" });
});

function weekendRow(page: Page) {
  return page.getByRole("option", { name: /Weekend plans/i });
}

async function openRowMenu(page: Page) {
  await weekendRow(page).click({ button: "right" });
  await expect(page.locator(".context-menu")).toBeVisible();
}

async function openFlagColorMenu(page: Page) {
  const trigger = page.locator(".popup-submenu-trigger", {
    hasText: "Flag color",
  });
  await trigger.focus();
  await page.keyboard.press("ArrowRight");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  return page.locator(".popup-submenu-panel");
}

/** Picks a color by keyboard: focus the submenu item, then press Enter. */
async function pickFlag(page: Page, name: string) {
  const trigger = page.locator(".popup-submenu-trigger", {
    hasText: "Flag color",
  });
  await trigger.focus();
  await page.keyboard.press("ArrowRight");
  const item = page
    .locator(".popup-submenu-panel")
    .getByRole("menuitem", { name, exact: true });
  await item.focus();
  await page.keyboard.press("Enter");
}

async function colorCalls(page: Page) {
  return (await ipcCalls(page)).filter(
    (call) => call.command === "set_messages_flag_color",
  );
}

async function weekendId(page: Page) {
  return Number(await weekendRow(page).getAttribute("data-message-id"));
}

test("FM1 choosing Orange from the row menu sends color 1 for that message", async ({
  page,
}) => {
  await page.goto("/");
  const id = await weekendId(page);
  await openRowMenu(page);
  await pickFlag(page, "Orange");
  await expect.poll(async () => (await colorCalls(page)).length).toBe(1);
  const [call] = await colorCalls(page);
  expect(call.args).toMatchObject({
    accountId: "account-1",
    messageIds: [id],
    color: 1,
  });
});

test("FM2 a flagged row is named Flagged, Orange with an orange glyph", async ({
  page,
}) => {
  await page.goto("/");
  await openRowMenu(page);
  await pickFlag(page, "Orange");
  const row = weekendRow(page);
  await expect(row).toHaveAccessibleName(/Flagged, Orange/);
  const glyph = row.locator(".star-mark");
  await expect(glyph).toBeVisible();
  const ink = await glyph.evaluate((node) =>
    getComputedStyle(node).getPropertyValue("--flag-ink").trim(),
  );
  const token = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--flag-orange")
      .trim(),
  );
  expect(token).not.toBe("");
  expect(ink).toBe(token);
});

test("FM3 Clear Flag sends a null color and removes the glyph", async ({
  page,
}) => {
  await page.goto("/");
  const id = await weekendId(page);
  await openRowMenu(page);
  await pickFlag(page, "Blue");
  await expect(weekendRow(page).locator(".star-mark")).toBeVisible();
  await openRowMenu(page);
  await pickFlag(page, "Clear Flag");
  await expect(weekendRow(page).locator(".star-mark")).toHaveCount(0);
  const calls = await colorCalls(page);
  expect(calls.at(-1)?.args).toMatchObject({ messageIds: [id], color: null });
});

test("FM4 flag:green reaches cached and server search unchanged", async ({
  page,
}) => {
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Search mail" });
  await search.fill("flag:green");
  await search.press("Enter");
  await expect(
    page.getByRole("option", { name: /Current mailbox/ }),
  ).toBeVisible();
  const calls = await ipcCalls(page);
  const texts = (command: string) =>
    calls
      .filter((call) => call.command === command)
      .map((call) => (call.args as { query: { text: string } }).query.text);
  expect(texts("search_cached_messages")).toEqual(["flag:green"]);
  expect(texts("search_server_messages")).toEqual(["flag:green"]);
});

test("FM5 the glyph stays visible under forced colors", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/");
  await openRowMenu(page);
  await pickFlag(page, "Green");
  const glyph = weekendRow(page).locator(".star-mark");
  await expect(glyph).toBeVisible();
  const box = await glyph.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(8);
  const colors = await glyph.evaluate((node) => {
    const probe = document.createElement("span");
    probe.style.color = "CanvasText";
    document.body.append(probe);
    const canvasText = getComputedStyle(probe).color;
    probe.remove();
    return { glyph: getComputedStyle(node).color, canvasText };
  });
  expect(colors.glyph).toBe(colors.canvasText);
});

test("FM6 the flag submenu works from the keyboard alone", async ({ page }) => {
  await page.goto("/");
  const id = await weekendId(page);
  const row = weekendRow(page);
  await row.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.locator(".context-menu");
  await expect(menu).toBeVisible();
  const trigger = page.locator(".popup-submenu-trigger", {
    hasText: "Flag color",
  });
  await trigger.focus();
  await page.keyboard.press("ArrowRight");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const panel = page.locator(".popup-submenu-panel");
  await expect(
    panel.getByRole("menuitem", { name: "Red", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    panel.getByRole("menuitem", { name: "Orange", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await colorCalls(page)).length).toBe(1);
  expect((await colorCalls(page))[0].args).toMatchObject({
    messageIds: [id],
    color: 1,
  });
});

test("FM7 the row menu fits the viewport at 200% text with the flag submenu open", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1240, height: 820 });
  await page.goto("/?scale=2");
  await openRowMenu(page);
  await openFlagColorMenu(page);
  const viewport = page.viewportSize();
  const box = await page.locator(".context-menu").boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
  const red = page.getByRole("menuitem", { name: "Red", exact: true });
  await expect(red).toBeVisible();
});

test("FM8 without keyword support, color items are disabled and plain Flag still works", async ({
  page,
}) => {
  await page.goto("/?noKeywords");
  await openRowMenu(page);
  const panel = await openFlagColorMenu(page);
  await expect(
    panel.getByText("Flags need server keyword support in this mailbox.", {
      exact: true,
    }),
  ).toBeVisible();
  for (const name of ["Red", "Orange", "Blue", "Gray"]) {
    await expect(
      panel.getByRole("menuitem", { name, exact: true }),
    ).toBeDisabled();
  }
  await page
    .locator(".context-menu")
    .getByRole("menuitem", { name: "Flag", exact: true })
    .click();
  await expect
    .poll(async () =>
      (await ipcCalls(page)).some(
        (call) =>
          call.command === "set_message_flags" &&
          (call.args as { isStarred?: boolean }).isStarred === true,
      ),
    )
    .toBe(true);
  expect(await colorCalls(page)).toHaveLength(0);
});

test("FM9 multi-select applies the chosen color to every checked message", async ({
  page,
}) => {
  await page.goto("/?threadGap=1");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const first = page.getByRole("option", { name: /Library hours/i });
  const second = page.getByRole("option", { name: /Older family note/i });
  const expected = [
    Number(await first.getAttribute("data-message-id")),
    Number(await second.getAttribute("data-message-id")),
  ];
  await first.click();
  await second.click();
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  await pickFlag(page, "Blue");
  await expect.poll(async () => (await colorCalls(page)).length).toBe(1);
  const [call] = await colorCalls(page);
  expect(call.args).toMatchObject({ accountId: "account-1", color: 4 });
  const ids = (call.args as { messageIds: number[] }).messageIds;
  expect([...ids].sort()).toEqual([...expected].sort());
});
