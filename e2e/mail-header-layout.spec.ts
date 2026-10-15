import { expect, test } from "./coverage-fixture";
import { installMockIpc } from "./mock-ipc";

// Large text and long counts must not overlap the mailbox actions or
// escape the heading. Preserve all pane modes and both density settings.
for (const density of ["comfortable", "compact"] as const) {
  for (const scale of [1, 2]) {
    for (const pane of ["right", "bottom", "hidden"] as const) {
      test(`mailbox heading fits: ${density}, ${scale * 100}%, ${pane}`, async ({
        page,
      }, testInfo) => {
        await installMockIpc(page);
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(`/?density=${density}&scale=${scale}&pane=${pane}`);
        await expect(
          page.getByRole("heading", { name: "Inbox", exact: true }),
        ).toBeVisible();
        await expect
          .poll(() =>
            page
              .locator("html")
              .evaluate((node) => getComputedStyle(node).fontSize),
          )
          .toBe(`${scale * 16}px`);
        const metrics = await page
          .locator(".message-pane .pane-heading")
          .evaluate((heading) => {
            const actions = heading
              .querySelector(".pane-heading-actions")!
              .getBoundingClientRect();
            const bounds = heading.getBoundingClientRect();
            const text = [...heading.querySelectorAll(":scope > span > *")].map(
              (node) => {
                const box = node.getBoundingClientRect();
                return {
                  text: node.textContent,
                  left: box.left,
                  right: box.right,
                  top: box.top,
                  bottom: box.bottom,
                  overlapsActions:
                    box.left < actions.right &&
                    box.right > actions.left &&
                    box.top < actions.bottom &&
                    box.bottom > actions.top,
                };
              },
            );
            return {
              text,
              heading: { left: bounds.left, right: bounds.right },
              actions: { left: actions.left, right: actions.right },
            };
          });
        await testInfo.attach("heading-metrics.json", {
          body: JSON.stringify(metrics, null, 2),
          contentType: "application/json",
        });
        await page.screenshot({
          path: testInfo.outputPath("mailbox-heading.png"),
        });
        for (const text of metrics.text) {
          expect(
            text.overlapsActions,
            `${text.text} overlaps mailbox actions`,
          ).toBe(false);
          expect(text.right).toBeLessThanOrEqual(metrics.heading.right + 1);
        }
        expect(metrics.actions.right).toBeLessThanOrEqual(
          metrics.heading.right + 1,
        );
      });
    }
  }
}

// A shared height must shrink again after text becomes smaller; otherwise
// measuring an already stretched bar creates a permanent height feedback loop.
test("reader and mailbox bars align and shrink after text scaling", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installMockIpc(page);
  await page.goto("/?density=compact&scale=2&pane=right");
  // At 200% the hover cluster covers the row center; click the left side.
  await page
    .getByRole("option", { name: /Weekend plans/i })
    .click({ position: { x: 24, y: 16 } });
  const heights = () =>
    page.evaluate(() => {
      const bar = document
        .querySelector(".reader-actions")!
        .getBoundingClientRect();
      const heading = document
        .querySelector(".message-pane .pane-heading")!
        .getBoundingClientRect();
      return {
        bar: bar.height,
        heading: heading.height,
        delta: Math.abs(bar.bottom - heading.bottom),
      };
    });
  await expect.poll(async () => (await heights()).delta).toBeLessThanOrEqual(1);
  const large = await heights();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Appearance", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Text size", exact: true })
    .selectOption("1");
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await expect.poll(async () => (await heights()).bar).toBeLessThan(large.bar);
  await expect.poll(async () => (await heights()).delta).toBeLessThanOrEqual(1);
  await testInfo.attach("resized-heading-metrics.json", {
    body: JSON.stringify({ large, smaller: await heights() }, null, 2),
    contentType: "application/json",
  });
  await page.screenshot({
    path: testInfo.outputPath("mailbox-reader-alignment.png"),
  });
  expect(errors).toEqual([]);
});
