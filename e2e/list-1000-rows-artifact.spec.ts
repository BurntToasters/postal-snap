import AxeBuilder from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc-artifact";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here (docs/0.5.0-FAILURE-INVENTORY.md, section F):
// F7  Compact, 200% text, or multi-line previews overlap or leave gaps.
// F8  Load older drops the button or appends the same page twice.
// The 1500-row fixture is served in two pages: 1000, then 500 older rows.
// Each density writes a screenshot and a JSON metrics attachment.

test.beforeEach(async ({ page }) => installMockIpc(page));

// Serves ?hugeList=1500 as a cursor-paged list so Load older is exercised.
async function servePagedHugeList(page: Page) {
  await page.addInitScript(() => {
    const mock = (
      window as unknown as {
        __POSTAL_SNAP_MOCK__?: { handlers: Record<string, unknown> };
      }
    ).__POSTAL_SNAP_MOCK__;
    const original = mock?.handlers.list_messages as
      ((args: Record<string, unknown>) => unknown) | undefined;
    if (!mock || !original) return;
    mock.handlers.list_messages = async (args: Record<string, unknown>) => {
      const page = (await original(args)) as {
        items: Array<{ receivedAt: string; uid: number }>;
        nextCursor: unknown;
        hasMore: boolean;
      };
      if (!args.cursor) {
        const first = page.items.slice(0, 1000);
        const last = first[first.length - 1];
        return {
          ...page,
          items: first,
          nextCursor: { receivedAt: last.receivedAt, uid: last.uid },
          hasMore: true,
        };
      }
      return {
        ...page,
        items: page.items.slice(1000),
        nextCursor: null,
        hasMore: false,
      };
    };
  });
}

const DENSITIES = [
  ["comfortable", ""],
  ["compact", "&density=compact"],
  ["200% text", "&scale=2"],
] as const;

async function domRowCount(page: Page): Promise<number> {
  return page.locator(".message-list .message-row").count();
}

// Measures the mounted rows: items stack without gaps, rows stay inside
// their item, and no two rows overlap.
async function layoutProblems(page: Page) {
  return page.evaluate(() => {
    const list = document.querySelector(".message-list");
    if (!list) return { items: 0, rows: 0, problems: ["no list"] };
    const items = [...list.querySelectorAll<HTMLElement>("[data-index]")]
      .map((node) => ({
        index: Number(node.dataset.index),
        box: node.getBoundingClientRect(),
        inner: [
          ...node.querySelectorAll<HTMLElement>(".message-row, .list-day"),
        ].map((child) => child.getBoundingClientRect()),
      }))
      .sort((a, b) => a.index - b.index);
    const problems: string[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.box.height < 4) problems.push(`item ${item.index} collapsed`);
      for (const box of item.inner) {
        if (box.top < item.box.top - 1 || box.bottom > item.box.bottom + 1) {
          problems.push(`item ${item.index} content escapes its box`);
        }
      }
      const next = items[i + 1];
      if (next && next.index === item.index + 1) {
        const gap = next.box.top - item.box.bottom;
        if (Math.abs(gap) > 1)
          problems.push(`gap ${gap.toFixed(1)} at ${item.index}`);
      }
    }
    const rows = [...list.querySelectorAll<HTMLElement>(".message-row")]
      .map((node) => node.getBoundingClientRect())
      .sort((a, b) => a.top - b.top);
    for (let i = 1; i < rows.length; i += 1) {
      const overlap = rows[i - 1].bottom - rows[i].top;
      if (overlap > 1) problems.push(`rows overlap by ${overlap.toFixed(1)}px`);
    }
    return { items: items.length, rows: rows.length, problems };
  });
}

for (const [label, query] of DENSITIES) {
  test(`1500 rows in ${label}: small DOM, clean layout, Load older`, async ({
    page,
  }, testInfo: TestInfo) => {
    await servePagedHugeList(page);
    await page.goto(`/?hugeList=1500&theme=light${query}`);
    const list = page.locator(".message-list");
    await expect(page.getByRole("option").first()).toBeVisible();

    const metrics: Record<string, unknown> = { density: label };
    metrics.initialDomRows = await domRowCount(page);
    expect(metrics.initialDomRows).toBeLessThan(120);

    let peakRows = 0;
    const samples: Array<{ top: number; problems: string[] }> = [];
    for (let step = 0; step < 12; step += 1) {
      await list.evaluate((node) => {
        node.scrollTop += node.clientHeight * 3;
      });
      await expect
        .poll(async () => (await layoutProblems(page)).items)
        .toBeGreaterThan(0);
      peakRows = Math.max(peakRows, await domRowCount(page));
      const layout = await layoutProblems(page);
      samples.push({
        top: await list.evaluate((node) => node.scrollTop),
        problems: layout.problems,
      });
    }
    metrics.peakDomRows = peakRows;
    metrics.samples = samples.length;
    expect(peakRows).toBeLessThan(120);
    expect(samples.flatMap((sample) => sample.problems)).toEqual([]);

    await list.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    const loadOlder = page.getByRole("button", {
      name: "Load older mail",
      exact: true,
    });
    await expect(loadOlder).toBeVisible();
    await loadOlder.click();
    await expect(loadOlder).toBeHidden();
    await list.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(page.getByRole("option").first()).toHaveAttribute(
      "aria-setsize",
      "1500",
    );
    const lastRow = page.getByRole("option", { name: /Archive note 1500,/ });
    await expect(lastRow).toBeVisible();
    await expect(lastRow).toHaveAttribute("aria-posinset", "1500");
    metrics.afterLoadOlderSetSize = await page
      .getByRole("option")
      .first()
      .getAttribute("aria-setsize");

    // The pointer sits where Load older was; move it so the scan sees rest state.
    await page.mouse.move(0, 0);
    const scan = await new AxeBuilder({ page })
      .include(".message-list")
      .analyze();
    const serious = scan.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    );
    expect(serious).toEqual([]);

    const slug = label.replace(/[^a-z0-9]+/gi, "-");
    await testInfo.attach(`list-1000-rows-${slug}-metrics.json`, {
      body: JSON.stringify(metrics, null, 2),
      contentType: "application/json",
    });
    await attachArtifacts(page, testInfo, `list-1000-rows-${slug}`);
  });
}
