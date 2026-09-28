import type { Locator } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. Search focus draws a clipped outline; Select mode shows a 44px checkbox.
// 2. Sidebar actions misalign; nested folders widen the pane and clip actions.
// 3. Rename/Delete crowd every folder row even when not in use.
// 4. An empty mailbox message hugs the top; the empty reader shows a loud icon.
// 5. Mail-rule fields have no spacing; account sections run together.
// 6. Format groups stay outlined; Select actions wrap onto three rows.
// 7. Blocked pictures show a broken-image glyph.
// 8. The reader menu hides folders in a native dropdown.

test.beforeEach(async ({ page }) => installMockIpc(page));

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  if (!value) throw new Error("Element has no layout box");
  return value;
}

test("search focus ring sits on the capsule, not inside it", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.getByRole("searchbox", { name: "Search mail" });
  await input.focus();
  expect(
    await input.evaluate((node) => getComputedStyle(node).outlineStyle),
  ).toBe("none");
  expect(
    await page
      .locator(".search-box")
      .evaluate((node) => getComputedStyle(node).boxShadow),
  ).not.toBe("none");
});

test("select mode checkbox is compact with a full hit area", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const checkbox = page.getByRole("checkbox", { name: /Weekend plans/ });
  const visual = await box(checkbox);
  expect(visual.width).toBeLessThanOrEqual(24);
  const hit = await box(page.locator(".message-select-hit").first());
  expect(hit.width).toBeGreaterThanOrEqual(44);
  expect(hit.height).toBeGreaterThanOrEqual(44);
  await page.locator(".message-select-hit").first().click();
  await expect(checkbox).toBeChecked();
  await page.screenshot({ path: "test-results/ui-audit-select.png" });
});

test("sidebar actions line up with mailbox names", async ({ page }) => {
  await page.goto("/");
  const folderText = await box(
    page.locator(".folder", { hasText: "Inbox" }).locator("span").first(),
  );
  const addText = await box(page.getByRole("button", { name: "Add account" }));
  const addIcon = await box(
    page.getByRole("button", { name: "Add account" }).locator("svg"),
  );
  const folderIcon = await box(
    page.locator(".folder", { hasText: "Inbox" }).locator("svg"),
  );
  expect(Math.abs(addIcon.x - folderIcon.x)).toBeLessThanOrEqual(2);
  expect(addText.x).toBeLessThan(folderText.x);
});

test("an empty mailbox centers its message", async ({ page }) => {
  await page.goto("/?empty=1");
  const pane = await box(page.locator(".message-pane"));
  // Where the text starts: the element box includes its top padding.
  const textTop = await page.getByText("No messages here.").evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect().top;
  });
  expect(textTop - pane.y).toBeGreaterThan(pane.height * 0.25);
});

test("mail rule fields have room between them", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();
  const input = await box(page.getByLabel("Rule name").first());
  const nextLabel = await box(page.getByText("Match by").first());
  expect(nextLabel.y - (input.y + input.height)).toBeGreaterThanOrEqual(8);
});

test("composer format groups are borderless", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose" }).click();
  await page
    .getByRole("button", { name: /formatting/i })
    .first()
    .click();
  const width = await page
    .locator(".toolbar-group")
    .first()
    .evaluate((node) => getComputedStyle(node).borderTopWidth);
  expect(width).toBe("0px");
});

test("select-mode actions fit one row and the rest sit in the menu", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("checkbox", { name: /Weekend plans/ }).check();
  const bar = await box(page.getByRole("toolbar", { name: "1 selected" }));
  expect(bar.height).toBeLessThan(72);
  await page.getByRole("button", { name: "More mailbox actions" }).click();
  const menu = page.getByRole("menu", { name: "More mailbox actions" });
  await expect(menu.getByRole("menuitem", { name: "Mark read" })).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Mark unread" }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Mark as junk" }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/ui-audit-select-menu.png" });
});

test("the empty reader is quiet text", async ({ page }) => {
  await page.goto("/");
  const reader = page.locator(".empty-reader");
  await expect(reader).toContainText("Choose a message to read it.");
  await expect(reader.locator("img")).toHaveCount(0);
});

test("a blocked remote picture shows a clean placeholder", async ({ page }) => {
  await page.goto("/?remote=1");
  await page.locator('[role="option"]').first().click();
  const image = page
    .frameLocator(".message-body iframe")
    .locator("img.remote-image-blocked");
  await expect(image).toHaveCount(1);
  expect(
    await image.evaluate((node) => getComputedStyle(node).content),
  ).toContain("data:image/svg+xml");
});

test("the reader menu lists move destinations as items", async ({ page }) => {
  await page.goto("/?nestedFolders=1");
  await page.locator('[role="option"]').first().click();
  await page.getByRole("button", { name: "More actions" }).click();
  const menu = page.getByRole("menu", { name: "More actions" });
  const group = menu.getByRole("group", { name: "Move to" });
  await expect(group.getByRole("menuitem").first()).toBeVisible();
  await expect(menu.getByRole("combobox")).toHaveCount(0);
  await page.screenshot({ path: "test-results/ui-audit-reader-move.png" });
});

test("account settings are split into titled sections", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Accounts" }).click();
  const sections = page.locator(
    ".account-settings-card > :is(.account-password-section, .account-rules-section, .account-aliases-section)",
  );
  expect(await sections.count()).toBeGreaterThanOrEqual(3);
  for (const width of await sections.evaluateAll((nodes) =>
    nodes.map((node) => getComputedStyle(node).borderTopWidth),
  ))
    expect(width).toBe("1px");
  await page.screenshot({ path: "test-results/ui-audit-accounts.png" });
});

test("nested folders fit the sidebar and actions appear on demand", async ({
  page,
}) => {
  await page.goto("/?nestedFolders=1");
  const list = page.locator(".folder-list");
  const overflow = await list.evaluate(
    (node) => node.scrollWidth - node.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  const rename = page.getByRole("button", { name: "Rename Launch" });
  expect(await rename.evaluate((node) => getComputedStyle(node).opacity)).toBe(
    "0",
  );
  await page.locator(".folder-row", { hasText: "Launch" }).hover();
  await expect
    .poll(() => rename.evaluate((node) => getComputedStyle(node).opacity))
    .toBe("1");
  // Keyboard users reach it too.
  await rename.focus();
  await expect(rename).toBeFocused();
  await page.screenshot({ path: "test-results/ui-audit-sidebar.png" });
});
