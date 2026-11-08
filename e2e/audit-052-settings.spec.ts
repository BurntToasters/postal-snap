import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Failure modes (audit-settings, C3):
// 1-3. Advanced: danger sentence hidden, unnamed "Learn more", details inside the label.
// 4-5. Settings nav: wrapping or centered tab labels; icons accent in forced colors.
// 6. Reading: "Remote images" note text size differs from row help.
// 7-9. Reader: 32px primary targets, bottom reply spacing, letter/header alignment.
// 10. 700px reader: date and size block floats mid-header.
// 11-13. Thread index: wrapping dates, moving sender column, mismatched hover radius.
// 14-17. Setup: preview subject, header spacing, step 4 button hierarchy.
// 18. Large text: a sticky quick reply covers the letter in short windows.
// Writes JSON and PNG to artifacts/0.5.2/audit-fixes/audit-settings/ (gitignored).

const ARTIFACT_DIR = join(
  process.cwd(),
  "artifacts",
  "0.5.2",
  "audit-fixes",
  "audit-settings",
);
const VIEWPORT = { width: 1280, height: 840 };

test.beforeEach(async ({ page }) => installMockIpc(page));

async function saveArtifact(
  name: string,
  value: unknown,
  page: Page,
  testInfo: TestInfo,
) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const json = join(ARTIFACT_DIR, `${name}.json`);
  const png = join(ARTIFACT_DIR, `${name}.png`);
  await writeFile(json, `${JSON.stringify(value, null, 2)}\n`);
  await page.screenshot({ path: png });
  await testInfo.attach(name, { path: png, contentType: "image/png" });
}

async function openSettingsTab(page: Page, tab: string) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: tab, exact: true }).click();
}

async function openMessage(page: Page) {
  await page.getByRole("option", { name: /Weekend plans/i }).click();
  await expect(page.locator("#message-title")).toBeVisible();
}

test("reported-threat danger sentence is visible and each Learn more is named", async ({
  page,
}, testInfo) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("/?density=normal&scale=1&theme=light");
  await openSettingsTab(page, "Advanced");

  await expect(
    page.getByText("Turning this off is dangerous.", { exact: false }),
  ).toBeVisible();

  const checkbox = page.getByRole("checkbox", {
    name: /Warn about reported dangerous addresses/,
  });
  await expect(checkbox).not.toHaveAccessibleName(/Learn more/);
  await expect(page.locator("#settings-advanced label details")).toHaveCount(0);

  const summaries = page.locator(
    "#settings-advanced details.help-more > summary",
  );
  const count = await summaries.count();
  expect(count).toBeGreaterThanOrEqual(2);
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const summary = summaries.nth(index);
    await expect(summary).toHaveAccessibleName(/^Learn more about .+\S$/);
    names.push(
      (await summary.getAttribute("aria-label")) ??
        (await summary.textContent()) ??
        "",
    );
  }
  expect(new Set(names).size).toBe(count);

  await saveArtifact("advanced-learn-more", { count, names }, page, testInfo);
});

test("large-text quick reply does not cover the letter in an 840px window", async ({
  page,
}, testInfo) => {
  const overlaps = async (scale: number) => {
    await page.setViewportSize({ width: 1280, height: 840 });
    await page.goto(
      `/?density=normal&scale=${scale}&threadGap=1&threadPeople=1&remote=1`,
    );
    await page.locator(".message-row").first().click();
    await page.locator("#message-title").waitFor();
    return page.evaluate(() => {
      const quick = document
        .querySelector(".quick-reply")!
        .getBoundingClientRect();
      const body = document
        .querySelector("#reader-pane .message-body")!
        .getBoundingClientRect();
      const position = getComputedStyle(
        document.querySelector(".quick-reply")!,
      ).position;
      const overlap = Math.max(
        0,
        Math.min(quick.bottom, body.bottom) - Math.max(quick.top, body.top),
      );
      return { overlap, position };
    });
  };

  const large = await overlaps(2);
  expect(large.overlap, "200% text overlap").toBeLessThanOrEqual(1);
  const normal = await overlaps(1);
  expect(normal.position).toBe("sticky");
  await saveArtifact(
    "quick-reply-large-text",
    { large, normal },
    page,
    testInfo,
  );
});

test("settings nav tabs stay on one line and start-aligned", async ({
  page,
}, testInfo) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("/?density=normal&scale=1&theme=light");
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  const tabs = page.locator(".settings-nav button");
  const measured = await tabs.evaluateAll((nodes) =>
    nodes.map((node) => {
      const style = getComputedStyle(node);
      const label = node.querySelector("span")!.getBoundingClientRect();
      const lineHeight = parseFloat(style.lineHeight) || 0;
      return {
        text: node.textContent?.trim() ?? "",
        height: node.getBoundingClientRect().height,
        textAlign: style.textAlign,
        labelHeight: label.height,
        fontSize: parseFloat(style.fontSize),
        lineHeight,
        overflows: node.scrollWidth > node.clientWidth + 1,
      };
    }),
  );
  const heights = measured.map((tab) => tab.height);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
  for (const tab of measured) {
    expect(tab.textAlign, tab.text).toBe("start");
    expect(tab.overflows, tab.text).toBe(false);
    expect(tab.labelHeight, tab.text).toBeLessThan(tab.fontSize * 2);
  }

  await page.getByRole("tab", { name: "Reading & Sending" }).click();
  await page.emulateMedia({ forcedColors: "active" });
  const icon = await page
    .locator('.settings-nav button[aria-selected="true"] svg')
    .evaluate((svg) => ({
      icon: getComputedStyle(svg).color,
      text: getComputedStyle(svg.parentElement!).color,
    }));
  expect(icon.icon).toBe(icon.text);

  await saveArtifact(
    "settings-nav",
    { measured, forcedIcon: icon },
    page,
    testInfo,
  );
});

test("Remote images note uses the same text size as row help", async ({
  page,
}, testInfo) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("/?density=normal&scale=1&theme=light");
  await openSettingsTab(page, "Reading & Sending");

  const note = page
    .locator("#settings-reading")
    .getByText("Remote images load only when", { exact: false });
  await expect(note).toBeVisible();
  const styles = await note.evaluate((node) => {
    const help = document.querySelector(
      "#settings-reading .settings-row small",
    );
    const own = getComputedStyle(node);
    const row = getComputedStyle(help!);
    return {
      noteSize: own.fontSize,
      rowSize: row.fontSize,
      noteColor: own.color,
      rowColor: row.color,
    };
  });
  expect(styles.noteSize).toBe(styles.rowSize);
  expect(styles.noteColor).toBe(styles.rowColor);

  await saveArtifact("reading-note", styles, page, testInfo);
});

test("reader action targets reach 36px and bottom reply buttons are spaced", async ({
  page,
}, testInfo) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("/?density=normal&scale=1&theme=light");
  await openMessage(page);

  const targets = await page
    .locator(
      "#reader-pane .reader-actions .reader-reply-action, #reader-pane .reader-actions .reader-icon-action",
    )
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => node.getBoundingClientRect().height > 1)
        .map((node) => ({
          label: node.getAttribute("aria-label") ?? node.textContent,
          height: node.getBoundingClientRect().height,
        })),
    );
  expect(targets.length).toBeGreaterThanOrEqual(3);
  for (const target of targets) {
    expect(target.height, target.label ?? "").toBeGreaterThanOrEqual(36);
  }

  await page.goto(
    "/?density=normal&scale=1&theme=light&pane=bottom&readerPaneHeight=420",
  );
  await openMessage(page);
  const bottom = await page
    .locator(".pane-bottom .reader-action-group")
    .first()
    .evaluate((group) => {
      const buttons = [
        ...group.querySelectorAll<HTMLElement>(".reader-reply-action"),
      ].map((node) => node.getBoundingClientRect());
      const box = group.getBoundingClientRect();
      const gaps = buttons
        .slice(1)
        .map((button, index) => button.left - (buttons[index]?.right ?? 0));
      return {
        gaps,
        leadingInset: (buttons[0]?.left ?? 0) - box.left,
        trailingInset: box.right - (buttons.at(-1)?.right ?? 0),
        count: buttons.length,
      };
    });
  expect(bottom.count).toBeGreaterThanOrEqual(3);
  for (const gap of bottom.gaps) expect(gap).toBeGreaterThanOrEqual(4);
  expect(bottom.leadingInset).toBeGreaterThanOrEqual(4);
  expect(bottom.trailingInset).toBeGreaterThanOrEqual(4);

  await saveArtifact("reader-targets", { targets, bottom }, page, testInfo);
});

// Blocked: the HTML letter centers its 72ch column inside the iframe (src/security.ts).
// Plain-text letters are left-aligned by reader.css; this stays fixme until security.ts changes.
test.fixme("bottom and hidden reader bodies align with the header text", async ({
  page,
}, testInfo) => {
  const alignment: Record<string, number> = {};
  for (const pane of ["bottom", "hidden"] as const) {
    await page.setViewportSize(VIEWPORT);
    await page.goto(
      `/?density=normal&scale=1&theme=light&pane=${pane}&readerPaneHeight=420`,
    );
    await openMessage(page);
    alignment[pane] = await page.evaluate(() => {
      const title = document.querySelector(".message-header h1")!;
      const body =
        document.querySelector(".plain-text-body, .message-body pre") ??
        document.querySelector(".message-body")!;
      const padding = parseFloat(getComputedStyle(body).paddingLeft) || 0;
      return (
        body.getBoundingClientRect().left +
        padding -
        title.getBoundingClientRect().left
      );
    });
    expect(Math.abs(alignment[pane]!), pane).toBeLessThanOrEqual(2);
  }

  await saveArtifact("reader-body-alignment", alignment, page, testInfo);
});

test("700px reader keeps the date and size block flush with the sender", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 700, height: 840 });
  await page.goto("/?density=normal&scale=1&theme=light");
  await openMessage(page);

  const alignment = await page.evaluate(() => {
    const sender = document
      .querySelector("#reader-pane .message-header .sender-primary-line")!
      .getBoundingClientRect();
    const stamp = document
      .querySelector("#reader-pane .message-stamp-meta")!
      .getBoundingClientRect();
    const align = getComputedStyle(
      document.querySelector("#reader-pane .message-stamp")!,
    ).textAlign;
    return { senderLeft: sender.left, stampLeft: stamp.left, align };
  });
  expect(
    Math.abs(alignment.stampLeft - alignment.senderLeft),
  ).toBeLessThanOrEqual(2);

  await saveArtifact("narrow-stamp", alignment, page, testInfo);
});

test("thread index keeps dates on one line, sender column fixed, and hover radius matched at 200%", async ({
  page,
}, testInfo) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto(
    "/?threadGap=1&threadPeople=1&density=normal&scale=2&theme=light",
  );
  await page.getByRole("treeitem", { name: /Weekend plans/i }).click();
  const index = page.getByRole("navigation", { name: "In this conversation" });
  const rows = index.locator("button");
  expect(await rows.count()).toBeGreaterThanOrEqual(2);

  const layout = await index.evaluate((nav) => {
    const buttons = [...nav.querySelectorAll<HTMLElement>("button")];
    return buttons.map((button) => {
      const time = button.querySelector("time")!;
      const sender = button.querySelector(".conversation-index-sender")!;
      return {
        timeHeight: time.getBoundingClientRect().height,
        timeFontSize: parseFloat(getComputedStyle(time).fontSize),
        senderLeft: sender.getBoundingClientRect().left,
        current: button.getAttribute("aria-current") === "true",
      };
    });
  });
  for (const row of layout) {
    expect(row.timeHeight).toBeLessThan(row.timeFontSize * 1.6);
  }
  const senderLefts = layout.map((row) => row.senderLeft);
  expect(
    Math.max(...senderLefts) - Math.min(...senderLefts),
  ).toBeLessThanOrEqual(1);

  const selected = index.locator('button[aria-current="true"]');
  const other = index.locator('button:not([aria-current="true"])').first();
  await other.hover();
  const radii = {
    hovered: await other.evaluate(
      (node) => getComputedStyle(node).borderRadius,
    ),
    selected: await selected.evaluate(
      (node) => getComputedStyle(node).borderRadius,
    ),
  };
  expect(radii.hovered).toBe(radii.selected);

  await saveArtifact("thread-index", { layout, radii }, page, testInfo);
});

for (const density of ["normal", "comfortable", "compact"] as const) {
  test(`setup preview shows sender and subject unclipped at ${density}, 100%`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(VIEWPORT);
    await page.goto("/?firstRun=1");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Interface spacing" })
      .selectOption(density);
    await expect(page.locator("html")).toHaveAttribute("data-density", density);

    const rows = await page.locator(".setup-preview-row").evaluateAll((nodes) =>
      nodes.map((node) => {
        const sender = node.querySelector("strong")!;
        const subject = node.querySelector("span")!;
        return {
          senderVisible: sender.getBoundingClientRect().height > 0,
          subjectDisplay: getComputedStyle(subject).display,
          subjectHeight: subject.getBoundingClientRect().height,
          subjectClipped: subject.scrollWidth > subject.clientWidth + 1,
          subjectText: subject.textContent,
        };
      }),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.senderVisible).toBe(true);
      expect(row.subjectDisplay).not.toBe("none");
      expect(row.subjectHeight).toBeGreaterThan(0);
      expect(row.subjectClipped, density).toBe(false);
    }

    await saveArtifact(`setup-preview-${density}`, { rows }, page, testInfo);
  });
}

test("setup header controls are spaced and step 4 has one gray secondary button", async ({
  page,
}, testInfo) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("/?firstRun=1");
  for (let step = 0; step < 3; step += 1) {
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  }
  await page.getByRole("button", { name: /iCloud Mail/i }).click();

  const header = page.locator(".setup-form-header");
  const back = header.locator(".back-button");
  const settings = header.locator(".setup-settings-button");
  await expect(back).toBeVisible();
  await expect(settings).toBeVisible();
  const backBox = await back.boundingBox();
  const settingsBox = await settings.boundingBox();
  const gap =
    (settingsBox?.x ?? 0) - ((backBox?.x ?? 0) + (backBox?.width ?? 0));
  expect(gap).toBeGreaterThanOrEqual(8);

  const grayButtons = await page
    .locator(".setup-step .secondary-button:visible")
    .evaluateAll(
      (nodes) =>
        nodes.filter(
          (node) =>
            getComputedStyle(node).backgroundColor !== "rgba(0, 0, 0, 0)" &&
            getComputedStyle(node).backgroundColor !== "transparent",
        ).length,
    );
  expect(grayButtons).toBeLessThanOrEqual(1);

  await saveArtifact("setup-header", { gap, grayButtons }, page, testInfo);
});
