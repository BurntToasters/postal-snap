import type { TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

// Failure inventory:
// - Day headings construct an Intl formatter for every entry in a huge list.
// - A day-label factory keeps stale dates across render batches or midnight.
// - Opening a synthetic huge-list row returns the base summary's identity.
// - Large-list formatting disrupts the virtualized row's message identity.
// - End/Home/ArrowUp lose focus or the set size in a 1500-row list.
// - Dragging a huge-list row drops its identity or never moves it.

type DayFormatterStats = {
  constructors: number;
  dayLabelConstructors: Record<string, number>;
  dayLabelFormats: number;
  startedAt: number;
};

test.beforeEach(async ({ page }) => installMockIpc(page));

test.afterEach(async ({ page }, testInfo: TestInfo) => {
  const slug = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  await attachArtifacts(page, testInfo, `list-formatting-${slug}`);
});

test("large lists reuse day formatters and open the matching message", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    type Stats = {
      constructors: number;
      dayLabelConstructors: Record<string, number>;
      dayLabelFormats: number;
      startedAt: number;
    };
    const stats: Stats = {
      constructors: 0,
      dayLabelConstructors: {},
      dayLabelFormats: 0,
      startedAt: performance.now(),
    };
    Object.defineProperty(window, "__LIST_FORMAT_STATS__", {
      configurable: true,
      value: stats,
    });

    const NativeDateTimeFormat = Intl.DateTimeFormat;
    const trackedDateTimeFormat = new Proxy(NativeDateTimeFormat, {
      construct(target, args) {
        stats.constructors += 1;
        const options = args[1] as Intl.DateTimeFormatOptions | undefined;
        const optionKeys = Object.keys(options ?? {})
          .sort()
          .join(",");
        let dayLabelKind: string | undefined;
        if (optionKeys === "weekday" && options?.weekday === "long") {
          dayLabelKind = "weekday";
        } else if (
          options?.month === "long" &&
          options.day === "numeric" &&
          optionKeys === "day,month"
        ) {
          dayLabelKind = "same-year-date";
        } else if (
          options?.month === "long" &&
          options.day === "numeric" &&
          options.year === "numeric" &&
          optionKeys === "day,month,year"
        ) {
          dayLabelKind = "other-year-date";
        }
        if (dayLabelKind) {
          stats.dayLabelConstructors[dayLabelKind] =
            (stats.dayLabelConstructors[dayLabelKind] ?? 0) + 1;
        }

        const formatter = Reflect.construct(target, args, target);
        return new Proxy(formatter, {
          get(instance, property) {
            const value = Reflect.get(instance, property, instance) as unknown;
            if (property === "format" && typeof value === "function") {
              return (date?: Date | number) => {
                if (dayLabelKind) stats.dayLabelFormats += 1;
                return value.call(instance, date);
              };
            }
            return typeof value === "function" ? value.bind(instance) : value;
          },
        });
      },
    });
    Object.defineProperty(Intl, "DateTimeFormat", {
      configurable: true,
      writable: true,
      value: trackedDateTimeFormat,
    });
  });

  await page.goto("/?hugeList=1500&theme=light");
  const first = page.getByRole("option", { name: /Archive note 1,/ });
  await expect(first).toBeVisible();
  await expect(first).toHaveAttribute("aria-setsize", "1500");

  const stats = await page.evaluate(() => {
    const value = (
      window as Window & { __LIST_FORMAT_STATS__?: DayFormatterStats }
    ).__LIST_FORMAT_STATS__;
    if (!value) return null;
    return {
      ...value,
      elapsedMs: performance.now() - value.startedAt,
    };
  });
  expect(stats).not.toBeNull();
  expect(stats!.dayLabelFormats).toBeGreaterThanOrEqual(1500);
  for (const constructors of Object.values(stats!.dayLabelConstructors)) {
    // React Strict Mode may render the loaded list more than once in dev.
    expect(constructors).toBeLessThan(20);
  }
  expect(stats!.elapsedMs).toBeLessThan(10_000);
  await testInfo.attach("list-formatting-metrics.json", {
    body: JSON.stringify(stats, null, 2),
    contentType: "application/json",
  });

  // 1500-row keyboard travel keeps focus, position, and identity.
  await first.focus();
  await page.keyboard.press("End");
  const last = page.getByRole("option", { name: /Archive note 1500/ });
  await expect(last).toBeFocused();
  await expect(last).toHaveAttribute("aria-posinset", "1500");
  await expect(
    page.getByRole("heading", { name: "Archive note 1500", level: 1 }),
  ).toBeVisible();

  await page.keyboard.press("ArrowUp");
  const almostLast = page.getByRole("option", { name: /Archive note 1499/ });
  await expect(almostLast).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "Archive note 1499", level: 1 }),
  ).toBeVisible();

  await page.keyboard.press("Home");
  const home = page.getByRole("option", { name: /Archive note 1,/ });
  await expect(home).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "Archive note 1", level: 1 }),
  ).toBeVisible();

  // Requested and opened identities match the huge-list envelope.
  const detailCalls = await page.evaluate(
    () =>
      window.__POSTAL_SNAP_TEST__?.ipcCalls.filter(
        (call) => call.command === "get_message",
      ) ?? [],
  );
  expect(detailCalls.some((call) => call.args.messageId === 5000)).toBe(true);
  expect(detailCalls.some((call) => call.args.messageId === 6499)).toBe(true);
  expect(detailCalls.some((call) => call.args.messageId === 6498)).toBe(true);

  // Dragging a huge-list row keeps its identity.
  const second = page.getByRole("option", { name: /Archive note 2,/ });
  await expect(second).toBeVisible();
  await second.dragTo(
    page.locator(".folder-list").getByRole("button", { name: "Archive" }),
  );
  const moved = await page.evaluate(() =>
    window.__POSTAL_SNAP_TEST__?.ipcCalls.find(
      (call) => call.command === "move_message_to_mailbox",
    ),
  );
  expect(moved?.args).toMatchObject({
    accountId: "account-1",
    messageId: 5001,
    destinationMailboxId: 2,
  });
});
