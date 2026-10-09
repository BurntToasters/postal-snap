import type { Locator } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. At 200% text, toolbar and folder icons stay at their 100% size.
// 2. At 200% text, Settings selects clip their value ("Auto (Sy").
// 3. At 200% text, Get Mail wraps or is clipped by Compose.
// 4. At 200% text, setup step numbers spill out of their circles.
// 5. In a narrow window the reader date takes the sender's place.
// 6. At 200% text, Select is cut off by the message list edge.
// 7. At 200% text, "Add account" wraps onto two lines.
// 8. The Drafts title and the draft subject start on different lines.

test.beforeEach(async ({ page }) => installMockIpc(page));

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  if (!value) throw new Error("Element has no layout box");
  return value;
}

test("icons grow with 200% text", async ({ page }) => {
  await page.goto("/?scale=2");
  const getMail = page.locator(".get-mail-button svg");
  const folder = page.locator(".folder svg").first();
  expect((await box(getMail)).width).toBeGreaterThanOrEqual(30);
  expect((await box(folder)).height).toBeGreaterThanOrEqual(30);
  await page.screenshot({ path: "test-results/large-text-mailbox.png" });
});

test("Get Mail stays on one unclipped line at 200% text", async ({ page }) => {
  await page.goto("/?scale=2");
  const button = page.getByRole("button", { name: "Get Mail" });
  const fits = await button.evaluate(
    (element) => element.scrollWidth <= element.clientWidth,
  );
  expect(fits).toBe(true);
  const compose = await box(page.getByRole("button", { name: "Compose" }));
  const getMail = await box(button);
  expect(getMail.x + getMail.width).toBeLessThanOrEqual(compose.x);
  expect(getMail.height).toBeLessThan(compose.height * 1.5);
});

test("Settings selects show their whole value at 200% text", async ({
  page,
}) => {
  await page.goto("/?scale=2");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  const appearance = page.getByRole("combobox", { name: "Appearance" });
  await expect(appearance).toBeVisible();
  const clipped = await appearance.evaluate((element) => {
    const select = element as HTMLSelectElement;
    const probe = document.createElement("span");
    probe.textContent = select.selectedOptions[0]?.text ?? "";
    probe.style.font = getComputedStyle(select).font;
    probe.style.position = "absolute";
    document.body.append(probe);
    const needed = probe.getBoundingClientRect().width;
    probe.remove();
    return needed > select.clientWidth;
  });
  expect(clipped).toBe(false);
  await page.screenshot({ path: "test-results/large-text-settings.png" });
});

test("setup step numbers fit their circles at 200% text", async ({ page }) => {
  await page.goto("/?firstRun=1&scale=2");
  const step = page.locator(".setup-flow-progress > div > span").first();
  await expect(step).toBeVisible();
  const overflows = await step.evaluate(
    (element) => element.scrollHeight > element.clientHeight + 1,
  );
  expect(overflows).toBe(false);
});

test("Add account stays on one line at 200% text", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?scale=2");
  const button = page.getByRole("button", { name: "Add account" });
  const info = await button.evaluate((node) => {
    const text = [...node.childNodes].find(
      (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim(),
    );
    const range = document.createRange();
    if (text) range.selectNodeContents(text);
    const shell = document.querySelector(".mail-shell");
    const style = shell ? getComputedStyle(shell) : null;
    return {
      lines: text ? range.getClientRects().length : 0,
      clipped: node.scrollWidth > node.clientWidth + 1,
      folder: Math.round(
        document.querySelector(".folder-pane")?.getBoundingClientRect().width ??
          0,
      ),
      messages: Math.round(
        document.querySelector(".message-pane")?.getBoundingClientRect()
          .width ?? 0,
      ),
      messageToken: style?.getPropertyValue("--rendered-message-width").trim(),
    };
  });
  expect(info.lines).toBe(1);
  expect(info.clipped).toBe(false);
  // The extra sidebar width comes from the reader, not the message list.
  expect(info.messages).toBeGreaterThanOrEqual(380);
  expect(info.messageToken).toContain("390px");
  expect(info.folder).toBeGreaterThan(248);
});

for (const scale of [1, 2]) {
  test(`the Drafts title lines up with the subject at ${scale * 100}% text`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?localMail=1&scale=${scale}`);
    await page.getByRole("button", { name: /^Drafts/ }).click();
    await expect(page.getByRole("heading", { name: "Drafts" })).toBeVisible();
    const edges = await page.evaluate(() => {
      const left = (selector: string) => {
        const node = document.querySelector(selector);
        if (!(node instanceof HTMLElement)) return null;
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getBoundingClientRect().left;
      };
      return {
        title: left(".pane-heading h1"),
        subject: left(".local-mail-row strong"),
      };
    });
    expect(edges.title).not.toBeNull();
    expect(edges.subject).not.toBeNull();
    expect(
      Math.abs((edges.subject ?? 0) - (edges.title ?? 0)),
    ).toBeLessThanOrEqual(1);
  });
}

test("list actions stay inside the heading at 200% text", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?scale=2");
  const heading = await box(page.locator(".pane-heading"));
  const select = await box(
    page.getByRole("button", { name: "Select", exact: true }),
  );
  expect(select.x).toBeGreaterThanOrEqual(heading.x);
  expect(select.x + select.width).toBeLessThanOrEqual(
    heading.x + heading.width - 4,
  );
  const search = page.getByRole("searchbox", { name: "Search mail" });
  const fits = await search.evaluate(
    (node) => node.scrollWidth <= node.clientWidth + 1,
  );
  expect(fits).toBe(true);
});

test("narrow reader keeps the sender beside the avatar", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 700 });
  await page.goto("/");
  await page.locator('[role="option"]').first().click();
  const avatar = await box(page.locator(".message-header .sender-avatar"));
  const sender = await box(page.locator(".message-header .sender-details"));
  const time = await box(page.locator(".message-header time"));
  expect(sender.x).toBeGreaterThan(avatar.x + avatar.width - 1);
  expect(sender.y).toBeLessThan(avatar.y + avatar.height);
  expect(time.y).toBeGreaterThanOrEqual(sender.y + sender.height - 1);
  await page.screenshot({ path: "test-results/narrow-reader-header.png" });
});
