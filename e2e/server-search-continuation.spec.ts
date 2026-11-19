import type { Page, TestInfo } from "@playwright/test";

import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc";
import { installMockIpc } from "./mock-ipc";
import type { MockShared } from "./mock/context";

// Failure modes covered here:
// 1. An incomplete server search shows no notice, so skipped folders go unnoticed.
// 2. "Search more folders" omits resumeAfterMailboxId, so the first folder repeats.
// 3. Continued hits replace the earlier results instead of merging with them.
// 4. The notice stays on screen after the search reports it is complete.
// 5. A stop without a resume id offers a button that cannot finish the search.
// Each density writes a screenshot and IPC log artifact.

const DENSITIES = ["normal", "comfortable", "compact"] as const;
const NOTICE =
  "Server search stopped early. Some folders were not fully searched.";

type ServerQuery = { text: string; resumeAfterMailboxId?: number };

async function stubServerSearch(page: Page, resumable = true): Promise<void> {
  await page.evaluate((resumable: boolean) => {
    const browser = window as unknown as { __POSTAL_SNAP_MOCK__?: MockShared };
    const mock = browser.__POSTAL_SNAP_MOCK__;
    if (!mock) throw new Error("Mock IPC was not installed");
    const original = mock.handlers.search_server_messages;
    if (!original) throw new Error("Mock handler missing: search");
    mock.handlers.search_server_messages = async (args) => {
      const query = args.query as { resumeAfterMailboxId?: number };
      const base = (await original(args)) as {
        messages: Array<Record<string, unknown>>;
      };
      const sample = base.messages[0];
      if (!sample) return { messages: [], complete: true };
      if (query.resumeAfterMailboxId === undefined) {
        return {
          messages: [
            {
              ...sample,
              id: 901,
              uid: 901,
              mailboxId: 1,
              subject: "First folder hit",
            },
          ],
          complete: false,
          resumeAfterMailboxId: resumable ? 1 : null,
        };
      }
      return {
        messages: [
          {
            ...sample,
            id: 902,
            uid: 902,
            mailboxId: 2,
            subject: "Second folder hit",
          },
        ],
        complete: true,
        resumeAfterMailboxId: null,
      };
    };
  }, resumable);
}

async function serverQueries(page: Page): Promise<ServerQuery[]> {
  const calls = await page.evaluate(
    () => window.__POSTAL_SNAP_TEST__?.ipcCalls ?? [],
  );
  return calls
    .filter((call) => call.command === "search_server_messages")
    .map((call) => call.args.query as ServerQuery);
}

for (const density of DENSITIES) {
  test(`continues a stopped server search in ${density} density`, async ({
    page,
  }, testInfo: TestInfo) => {
    await installMockIpc(page);
    await page.setViewportSize({ width: 1280, height: 840 });
    await page.goto(`/?localMail=1&density=${density}&scale=1`);
    await stubServerSearch(page);

    const search = page.getByRole("searchbox", { name: "Search mail" });
    await search.fill("stopped");
    await search.press("Enter");

    await expect(page.getByText(NOTICE)).toBeVisible();
    await expect(page.getByText("First folder hit")).toBeVisible();

    const more = page.getByRole("button", { name: "Search more folders" });
    await more.focus();
    await page.keyboard.press("Enter");

    await expect(page.getByText("Second folder hit")).toBeVisible();
    await expect(page.getByText("First folder hit")).toBeVisible();
    await expect(page.getByText(NOTICE)).toHaveCount(0);

    const resumed = (await serverQueries(page)).filter(
      (query) => query.resumeAfterMailboxId === 1,
    );
    expect(resumed).toHaveLength(1);
    expect(resumed[0].text).toBe("stopped");

    await attachArtifacts(
      page,
      testInfo,
      `server-search-continuation-${density}`,
    );
  });
}

test("shows the stop notice without a button when the search cannot resume", async ({
  page,
}, testInfo: TestInfo) => {
  await installMockIpc(page);
  await page.setViewportSize({ width: 1280, height: 840 });
  await page.goto("/?localMail=1&density=normal&scale=1");
  await stubServerSearch(page, false);

  const search = page.getByRole("searchbox", { name: "Search mail" });
  await search.fill("stopped");
  await search.press("Enter");

  await expect(page.getByText(NOTICE)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Search more folders" }),
  ).toHaveCount(0);
  await attachArtifacts(page, testInfo, "server-search-stop-without-resume");
});
