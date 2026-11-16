import { expect, test, type Locator, type Page } from "@playwright/test";
import { installMockIpc } from "./mock-ipc";
import { attachArtifactsAfterEach, ipcCalls } from "./ipc";
import { revealMenuItem } from "./menu-reveal";

test.afterEach(attachArtifactsAfterEach);

// Failure modes:
// FM1. Three conditions with Any do not save as one v2 rule with matchMode any.
// FM2. Keyboard-only creation fails, or focus is invisible on the controls.
// FM3. At 200% text the editor scrolls sideways or rows overflow the form.
// FM4. A legacy rule shows the wrong text, or toggling it rewrites its fields.
// FM5. A single-condition Junk rule is no longer recognized as a block, or a
//      multi-condition rule is wrongly treated as one.
// FM6. An 11th condition, a second move action, or an empty match value gets through.
// FM7. A flag action saves without its color.
// FM8. Check matches does not send the conditions to the preview command.

test.beforeEach(async ({ page }) => installMockIpc(page));

async function openRules(page: Page, url = "/") {
  await page.goto(url);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const sectionSelect = page.locator(".settings-section-select select");
  if (await sectionSelect.isVisible()) {
    await sectionSelect.selectOption("accounts");
  } else {
    await page.getByRole("tab", { name: "Accounts", exact: true }).click();
  }
  await page.getByRole("button", { name: /^Manage Sam\b/ }).click();
  await page.getByRole("button", { name: "Rules", exact: true }).click();
}

async function callsOf(page: Page, command: string) {
  return (await ipcCalls(page)).filter((call) => call.command === command);
}

async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 40; step += 1) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Focus never reached the target control");
}

test("FM1: three conditions with Any save as one v2 rule", async ({ page }) => {
  await openRules(page);
  await page.getByLabel("Rule name", { exact: true }).fill("Any three");
  await page
    .getByLabel("Text to match", { exact: true })
    .fill("one@example.test");
  await page
    .getByRole("button", { name: "Add condition", exact: true })
    .click();
  await page
    .getByLabel("Text to match 2", { exact: true })
    .fill("two@example.test");
  await page
    .getByRole("button", { name: "Add condition", exact: true })
    .click();
  await page
    .getByLabel("Text to match 3", { exact: true })
    .fill("three@example.test");
  await page
    .getByRole("radio", { name: "Match any condition", exact: true })
    .check();
  await page.getByRole("button", { name: "Add rule", exact: true }).click();
  await expect
    .poll(async () => (await callsOf(page, "create_filter_rule")).length)
    .toBe(1);
  const rule = (await callsOf(page, "create_filter_rule"))[0].args as {
    rule: { matchMode: string; conditions: { value: string }[] };
  };
  expect(rule.rule.matchMode).toBe("any");
  expect(rule.rule.conditions.map((c) => c.value)).toEqual([
    "one@example.test",
    "two@example.test",
    "three@example.test",
  ]);
});

test("FM2: keyboard-only creation with visible focus", async ({ page }) => {
  await openRules(page);
  await page.getByLabel("Rule name", { exact: true }).focus();
  await page.keyboard.type("Keyboard rule");
  const any = page.getByRole("radio", {
    name: "Match any condition",
    exact: true,
  });
  await tabTo(page, any);
  await page.keyboard.press("Space");
  await expect(any).toBeChecked();
  await tabTo(page, page.getByLabel("Text to match", { exact: true }));
  await page.keyboard.type("keys@example.test");
  await tabTo(
    page,
    page.getByRole("button", { name: "Add condition", exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(
    page.getByLabel("Text to match 2", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.type("second@example.test");
  const add = page.getByRole("button", { name: "Add rule", exact: true });
  await tabTo(page, add);
  expect(await add.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await callsOf(page, "create_filter_rule")).length)
    .toBe(1);
  const sent = (await callsOf(page, "create_filter_rule"))[0].args as {
    rule: { matchMode: string; conditions: { value: string }[] };
  };
  expect(sent.rule.matchMode).toBe("any");
  expect(sent.rule.conditions).toHaveLength(2);
});

test("FM3: editor fits at 200% text without sideways scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 620, height: 640 });
  await openRules(page, "/?scale=2");
  await page
    .getByRole("button", { name: "Add condition", exact: true })
    .click();
  const overflow = await page.locator(".rule-form").evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
  const pageWidth = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(pageWidth.scroll).toBeLessThanOrEqual(pageWidth.client + 1);
});

test("FM4: legacy rule reads as one condition and action, and saves unchanged", async ({
  page,
}) => {
  await openRules(page, "/?legacyRule=1");
  const row = page
    .locator("li.rule-item")
    .filter({ hasText: "Legacy archive" });
  await expect(row).toContainText(
    "If Sender contains “legacy@example.test”, Move to Archive.",
  );
  await row.getByRole("button", { name: /^Legacy archive: On$/ }).click();
  await expect
    .poll(async () => (await callsOf(page, "update_filter_rule")).length)
    .toBe(1);
  const sent = (await callsOf(page, "update_filter_rule"))[0].args as {
    rule: Record<string, unknown>;
  };
  expect(sent.rule).toEqual({
    id: "rule-legacy",
    accountId: expect.any(String),
    name: "Legacy archive",
    field: "from",
    contains: "legacy@example.test",
    action: "move_archive",
    targetMailbox: null,
    enabled: false,
  });
});

test("FM5: a single-condition Junk rule is a block", async ({ page }) => {
  await page.goto("/?v2BlockedSender=1");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await revealMenuItem(page, "Unblock sender");
  await page.getByRole("button", { name: "More actions" }).click();
  await revealMenuItem(page, "Unblock sender");
  await expect(
    page.getByRole("menuitem", { name: "Unblock sender", exact: true }),
  ).toBeVisible();
});

test("FM5: a two-condition Junk rule is not offered as a block", async ({
  page,
}) => {
  await page.goto("/?v2BlockedSender=2");
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await revealMenuItem(page, "Block sender");
  await page.getByRole("button", { name: "More actions" }).click();
  await revealMenuItem(page, "Block sender");
  await expect(
    page.getByRole("menuitem", { name: "Block sender", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Unblock sender", exact: true }),
  ).toHaveCount(0);
});

test("FM6: limits and empty values are refused in the editor", async ({
  page,
}) => {
  await openRules(page);
  await page.getByLabel("Rule name", { exact: true }).fill("Limits");
  for (let count = 2; count <= 10; count += 1) {
    await page
      .getByRole("button", { name: "Add condition", exact: true })
      .click();
  }
  await expect(page.locator(".rule-condition-row")).toHaveCount(10);
  await expect(
    page.getByRole("button", { name: "Add condition", exact: true }),
  ).toBeDisabled();

  await page.getByLabel("Then", { exact: true }).selectOption("move_archive");
  await page.getByRole("button", { name: "Add action", exact: true }).click();
  const secondMove = await page
    .getByLabel("Then 2", { exact: true })
    .evaluate((el) => (el as HTMLSelectElement).options[1].disabled);
  expect(secondMove).toBe(true);

  await page.getByLabel("Text to match", { exact: true }).fill("");
  await page.getByRole("button", { name: "Add rule", exact: true }).click();
  await expect(
    page.getByText("Enter the text to match.", { exact: true }),
  ).toBeVisible();
  expect(await callsOf(page, "create_filter_rule")).toHaveLength(0);
});

test("FM7: flag action sends its color", async ({ page }) => {
  await openRules(page);
  await page.getByLabel("Rule name", { exact: true }).fill("Flag blue");
  await page
    .getByLabel("Text to match", { exact: true })
    .fill("flag@example.test");
  await page.getByLabel("Then", { exact: true }).selectOption("flag");
  await page.getByLabel("Flag color", { exact: true }).selectOption("4");
  await page.getByRole("button", { name: "Add rule", exact: true }).click();
  await expect
    .poll(async () => (await callsOf(page, "create_filter_rule")).length)
    .toBe(1);
  const sent = (await callsOf(page, "create_filter_rule"))[0].args as {
    rule: { actions: { kind: string; flagColor: number | null }[] };
  };
  expect(sent.rule.actions).toEqual([
    expect.objectContaining({ kind: "flag", flagColor: 4 }),
  ]);
});

test("FM8: check matches sends the conditions", async ({ page }) => {
  await openRules(page);
  await page.getByLabel("Text to match", { exact: true }).fill("power");
  await page
    .getByRole("button", { name: "Add condition", exact: true })
    .click();
  await page.getByLabel("Match by 2", { exact: true }).selectOption("subject");
  await page.getByLabel("Text to match 2", { exact: true }).fill("bill");
  await page
    .getByRole("button", { name: "Check matches", exact: true })
    .click();
  await expect
    .poll(async () => (await callsOf(page, "preview_filter_rule")).length)
    .toBe(1);
  const sent = (await callsOf(page, "preview_filter_rule"))[0].args as {
    rule: { conditions: { field: string; value: string }[] };
  };
  expect(sent.rule.conditions).toEqual([
    { field: "from", value: "power" },
    { field: "subject", value: "bill" },
  ]);
});
