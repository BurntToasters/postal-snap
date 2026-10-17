import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here (inventory B1-B6):
// 1. Mod+K inside the composer body opens the palette instead of editing.
// 2. The palette lists folders from an inactive account.
// 3. An action whose availability is false appears or can run.
// 4. Closing the palette leaves focus on body instead of the invoker.
// 5. The active option is not exposed, or groups have no names.
// 6. At 200% text the palette clips options or overflows a narrow window.

type MockWindow = Window & {
  __POSTAL_SNAP_MOCK__: {
    account: { id: string };
    mailboxes: Array<{ id: number; accountId: string }>;
  };
};

test.beforeEach(async ({ page }) => installMockIpc(page));

const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "Command palette" });
const combobox = (page: Page) =>
  page.getByRole("combobox", { name: /Search commands/ });
const group = (page: Page, name: string) =>
  page.getByRole("group", { name, exact: true });

async function openPalette(page: Page) {
  await page.keyboard.press("ControlOrMeta+K");
  await expect(dialog(page)).toBeVisible();
  await expect(combobox(page)).toBeFocused();
}

async function mockMailboxCount(page: Page, accountId?: string) {
  return page.evaluate((id) => {
    const mock = (window as MockWindow).__POSTAL_SNAP_MOCK__;
    const wanted = id ?? mock.account.id;
    return mock.mailboxes.filter((box) => box.accountId === wanted).length;
  }, accountId);
}

async function expectNoClipping(page: Page) {
  const clipped = await page
    .locator(".palette-option")
    .evaluateAll(
      (items) =>
        items.filter((item) => item.scrollWidth > item.clientWidth + 1).length,
    );
  expect(clipped).toBe(0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
}

test("Mod+K opens the palette and Escape restores focus", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/");
  const invoker = page.getByRole("button", { name: "Get Mail", exact: true });
  await invoker.focus();
  await openPalette(page);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(invoker).toBeFocused();
  await attachArtifacts(page, testInfo, "command-palette-open-close");
});

test("Mod+K inside the composer body does not open the palette", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const body = page.getByRole("textbox", { name: "Message body" });
  await body.click();
  await page.keyboard.type("Hello");
  await page.keyboard.press("ControlOrMeta+K");
  await expect(dialog(page)).toHaveCount(0);
  await expect(body).toContainText("Hello");
  await attachArtifacts(page, testInfo, "command-palette-composer");
});

test("Mod+K inside the message search field does not open the palette", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/");
  const search = page.getByLabel("Search mail").first();
  await search.click();
  await page.keyboard.type("invoice");
  await page.keyboard.press("ControlOrMeta+K");
  await expect(dialog(page)).toHaveCount(0);
  await attachArtifacts(page, testInfo, "command-palette-search-field");
});

test("folders listed are only the active account's", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/?multiAccount=1");
  await openPalette(page);
  const folders = group(page, "Folders").getByRole("option");
  await expect(folders).toHaveCount(await mockMailboxCount(page));
  await attachArtifacts(page, testInfo, "command-palette-active-folders");
});

test("switching account refreshes the folder list to that account", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/?multiAccount=1");
  await openPalette(page);
  await combobox(page).fill("Work");
  await group(page, "Accounts").getByRole("option", { name: /Work/ }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__POSTAL_SNAP_TEST__?.ipcCalls.some(
            (call) =>
              call.command === "list_mailboxes" &&
              call.args.accountId === "account-2",
          ) ?? false,
      ),
    )
    .toBe(true);
  await openPalette(page);
  await expect(group(page, "Folders").getByRole("option")).toHaveCount(
    await mockMailboxCount(page, "account-2"),
  );
  await attachArtifacts(page, testInfo, "command-palette-switch-account");
});

test("message actions are hidden until a message is open", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/");
  await openPalette(page);
  const actions = group(page, "Actions");
  await expect(
    actions.getByRole("option", { name: /New message/ }),
  ).toHaveCount(1);
  await expect(actions.getByRole("option", { name: /^Reply/ })).toHaveCount(0);
  await expect(actions.getByRole("option", { name: /^Archive/ })).toHaveCount(
    0,
  );
  await attachArtifacts(page, testInfo, "command-palette-hidden-actions");
  await page.keyboard.press("Escape");

  await page
    .getByRole("option", { name: /Weekend plans/i })
    .or(page.getByRole("treeitem", { name: /Weekend plans/i }))
    .click();
  await expect(
    page.getByRole("heading", { name: "Weekend plans" }),
  ).toBeVisible();
  await openPalette(page);
  await combobox(page).fill("reply");
  await group(page, "Actions")
    .getByRole("option")
    .filter({
      has: page.locator(".palette-option-label", { hasText: /^Reply$/ }),
    })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message body" }),
  ).toBeFocused();
});

test("New message from the palette opens the composer", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/");
  await openPalette(page);
  await combobox(page).fill("new message");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("combobox", { name: "To" })).toBeFocused();
  await attachArtifacts(page, testInfo, "command-palette-new-message");
});

test("a folder chosen in the palette loads that folder", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/");
  await openPalette(page);
  await combobox(page).fill("archive");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  const archiveId = await page.evaluate(() => {
    const mock = (window as MockWindow).__POSTAL_SNAP_MOCK__;
    return mock.mailboxes.find(
      (box) => box.accountId === mock.account.id && box.id === 2,
    )?.id;
  });
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          window.__POSTAL_SNAP_TEST__?.ipcCalls.some(
            (call) =>
              call.command === "list_messages" && call.args.mailboxId === id,
          ) ?? false,
        archiveId,
      ),
    )
    .toBe(true);
  await attachArtifacts(page, testInfo, "command-palette-folder");
});

test("arrow, Home, and End keys move the active option and aria names it", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/?multiAccount=1");
  await openPalette(page);
  const input = combobox(page);
  await expect(input).toHaveAttribute("aria-expanded", "true");
  const listId = await input.getAttribute("aria-controls");
  expect(listId).toBeTruthy();
  const listbox = page.locator(`[id="${listId}"]`);
  await expect(listbox).toHaveAttribute("role", "listbox");
  await expect(listbox).toHaveAccessibleName("Results");
  await expect(group(page, "Actions")).toBeVisible();
  await expect(group(page, "Folders")).toBeVisible();
  await expect(group(page, "Accounts")).toBeVisible();

  const options = listbox.getByRole("option");
  const count = await options.count();
  expect(count).toBeGreaterThan(2);
  const activeId = () => input.getAttribute("aria-activedescendant");
  const firstId = await options.first().getAttribute("id");
  const lastId = await options.last().getAttribute("id");
  expect(await activeId()).toBe(firstId);

  await page.keyboard.press("ArrowDown");
  expect(await activeId()).not.toBe(firstId);
  await page.keyboard.press("End");
  expect(await activeId()).toBe(lastId);
  await page.keyboard.press("ArrowDown");
  expect(await activeId()).toBe(firstId);
  await page.keyboard.press("ArrowUp");
  expect(await activeId()).toBe(lastId);
  await page.keyboard.press("Home");
  expect(await activeId()).toBe(firstId);
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await attachArtifacts(page, testInfo, "command-palette-keyboard");
});

test("a query with no match shows an announced empty state", async ({
  page,
}, testInfo: TestInfo) => {
  await page.goto("/");
  await openPalette(page);
  await combobox(page).fill("zzqxw");
  await expect(page.locator(".palette-empty")).toHaveText(/No matches/);
  await expect(combobox(page)).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await attachArtifacts(page, testInfo, "command-palette-no-match");
});

const densities = ["comfortable", "compact"] as const;
const scales = [1, 2] as const;

for (const density of densities) {
  for (const scale of scales) {
    test(`palette fits a narrow window in ${density} density at ${scale * 100}% text`, async ({
      page,
    }, testInfo: TestInfo) => {
      await page.setViewportSize({ width: 420, height: 800 });
      await page.goto(`/?density=${density}&scale=${scale}`);
      await openPalette(page);
      const box = await dialog(page).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(420);
      await expectNoClipping(page);
      await page.keyboard.press("End");
      const visible = await page.evaluate(() => {
        const active = document.querySelector<HTMLElement>(
          '.palette-option[aria-selected="true"]',
        );
        const list = document.querySelector(".palette-results");
        if (!active || !list) return false;
        const row = active.getBoundingClientRect();
        const area = list.getBoundingClientRect();
        return row.top >= area.top - 1 && row.bottom <= area.bottom + 1;
      });
      expect(visible).toBe(true);
      const scan = await new AxeBuilder({ page })
        .include(".palette-dialog")
        .analyze();
      expect(scan.violations).toEqual([]);
      await attachArtifacts(
        page,
        testInfo,
        `command-palette-${density}-${scale * 100}`,
      );
    });
  }
}

test("palette forced-colors state marks the active option", async ({
  page,
}, testInfo: TestInfo) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/");
  await openPalette(page);
  const selected: Locator = page.locator(
    '.palette-option[aria-selected="true"]',
  );
  await expect(selected).toHaveCount(1);
  const background = await selected.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
  await attachArtifacts(page, testInfo, "command-palette-forced-colors");
});
