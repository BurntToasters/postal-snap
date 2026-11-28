import type { Page, TestInfo } from "@playwright/test";

import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc";
import { installMockIpc } from "./mock-ipc";
import type { MockShared } from "./mock/context";

// Failure modes covered here:
// 1. A first-folder ceiling skip is lost when a later page completes.
// 2. A clipped final folder leaves a false continuation button or hides the warning.
// 3. Normally resumable pages repeat folders, lose hits, or clear status incorrectly.
// 4. A stale term, account, mailbox, or scope can continue an obsolete cursor.
// 5. A stale continuation response can replace the active search results.
// 6. Server-only body hits and the selected result disappear during continuation.
// Artifacts include screenshots and IPC logs for each scenario.

const DENSITIES = ["normal", "comfortable", "compact"] as const;
const NOTICE =
  "Server search stopped early. Some folders were not fully searched.";

type StubMode =
  | "resumable"
  | "partial-then-complete"
  | "clipped-final"
  | "scope-change"
  | "delayed-continuation";

type ServerQuery = {
  accountId: string;
  allFolders: boolean;
  mailboxId?: number;
  resumeAfterMailboxId?: number;
  text: string;
};

async function stubServerSearch(page: Page, mode: StubMode): Promise<void> {
  await page.evaluate((mode: StubMode) => {
    const browser = window as unknown as {
      __POSTAL_SNAP_MOCK__?: MockShared;
      __SERVER_SEARCH_CONTINUATION_RELEASE__?: () => void;
    };
    const mock = browser.__POSTAL_SNAP_MOCK__;
    if (!mock) throw new Error("Mock IPC was not installed");
    const original = mock.handlers.search_server_messages;
    if (!original) throw new Error("Mock handler missing: search");
    const originalGetMessage = mock.handlers.get_message;

    mock.handlers.get_message = async (args) => {
      const loaded = (await originalGetMessage(args)) as Record<
        string,
        unknown
      >;
      const id = Number(args.messageId);
      const metadata: Record<number, { mailboxId: number; subject: string }> = {
        901: { mailboxId: 1, subject: "First folder hit" },
        902: { mailboxId: 2, subject: "Second folder hit" },
        911: { mailboxId: 1, subject: "Skipped folder hit" },
        912: { mailboxId: 2, subject: "Remaining folder hit" },
        921: { mailboxId: 1, subject: "Finished folder hit" },
        922: { mailboxId: 3, subject: "Final clipped folder hit" },
        930: { mailboxId: 1, subject: "All folders first hit" },
        931: { mailboxId: 2, subject: "Unexpected continuation" },
        932: { mailboxId: 1, subject: "Mailbox scope result" },
        941: { mailboxId: 1, subject: "First folder hit" },
        942: { mailboxId: 2, subject: "Stale continuation hit" },
      };
      const match = metadata[id];
      return match ? { ...loaded, id, uid: id, ...match } : loaded;
    };

    mock.handlers.search_server_messages = async (args) => {
      const query = args.query as ServerQuery;
      const base = (await original(args)) as {
        messages: Array<Record<string, unknown>>;
      };
      const sample = base.messages[0];
      if (!sample) return { messages: [], complete: true, partial: false };
      const hit = (id: number, mailboxId: number, subject: string) => ({
        ...sample,
        id,
        uid: id,
        mailboxId,
        subject,
      });

      if (mode === "resumable") {
        if (query.resumeAfterMailboxId === undefined) {
          return {
            messages: [hit(901, 1, "First folder hit")],
            complete: false,
            partial: false,
            resumeAfterMailboxId: 1,
          };
        }
        return {
          messages: [hit(902, 2, "Second folder hit")],
          complete: true,
          partial: false,
          resumeAfterMailboxId: null,
        };
      }

      if (mode === "partial-then-complete") {
        if (query.resumeAfterMailboxId === undefined) {
          return {
            messages: [hit(911, 1, "Skipped folder hit")],
            complete: false,
            partial: true,
            resumeAfterMailboxId: 1,
          };
        }
        return {
          messages: [hit(912, 2, "Remaining folder hit")],
          complete: true,
          partial: false,
          resumeAfterMailboxId: null,
        };
      }

      if (mode === "clipped-final") {
        if (query.resumeAfterMailboxId === undefined) {
          return {
            messages: [hit(921, 1, "Finished folder hit")],
            complete: false,
            partial: false,
            resumeAfterMailboxId: 1,
          };
        }
        return {
          messages: [hit(922, 3, "Final clipped folder hit")],
          complete: false,
          partial: true,
          resumeAfterMailboxId: null,
        };
      }

      if (mode === "scope-change") {
        if (query.resumeAfterMailboxId !== undefined) {
          return {
            messages: [hit(931, 2, "Unexpected continuation")],
            complete: true,
            partial: false,
          };
        }
        if (!query.allFolders) {
          return {
            messages: [hit(932, 1, "Mailbox scope result")],
            complete: true,
            partial: false,
          };
        }
        return {
          messages: [hit(930, 1, "All folders first hit")],
          complete: false,
          partial: false,
          resumeAfterMailboxId: 1,
        };
      }

      if (
        mode === "delayed-continuation" &&
        query.resumeAfterMailboxId === undefined &&
        !query.allFolders
      ) {
        return {
          messages: [hit(932, 1, "Mailbox scope result")],
          complete: true,
          partial: false,
        };
      }

      if (query.resumeAfterMailboxId === undefined) {
        return {
          messages: [hit(941, 1, "First folder hit")],
          complete: false,
          partial: false,
          resumeAfterMailboxId: 1,
        };
      }
      return await new Promise((resolve) => {
        browser.__SERVER_SEARCH_CONTINUATION_RELEASE__ = () => {
          browser.__SERVER_SEARCH_CONTINUATION_RELEASE__ = undefined;
          resolve({
            messages: [hit(942, 2, "Stale continuation hit")],
            complete: true,
            partial: false,
            resumeAfterMailboxId: null,
          });
        };
      });
    };
  }, mode);
}

async function chooseAllFolders(page: Page): Promise<void> {
  await page.getByRole("button", { name: "This mailbox" }).click();
  await page.getByRole("menuitemradio", { name: "All folders" }).click();
  await expect(page.getByRole("button", { name: "All folders" })).toBeVisible();
}

async function startSearch(page: Page, text = "stopped"): Promise<void> {
  const search = page.getByRole("searchbox", { name: "Search mail" });
  await search.fill(text);
  await search.press("Enter");
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
  test(`continues a resumable all-folder search by keyboard, ${density} at 200%`, async ({
    page,
  }, testInfo: TestInfo) => {
    await installMockIpc(page);
    await page.setViewportSize({ width: 1280, height: 840 });
    await page.goto(`/?localMail=1&density=${density}&scale=2`);
    await stubServerSearch(page, "resumable");
    await chooseAllFolders(page);
    await startSearch(page);

    await expect(page.getByText(NOTICE)).toBeVisible();
    const firstHit = page.getByRole("option", { name: /First folder hit/ });
    await expect(firstHit).toBeVisible();
    await firstHit.click();
    await expect(firstHit).toHaveAttribute("aria-selected", "true");

    const more = page.getByRole("button", { name: "Search more folders" });
    await more.focus();
    await page.keyboard.press("Enter");

    await expect(
      page.getByRole("option", { name: /Second folder hit/ }),
    ).toBeVisible();
    await expect(firstHit).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(NOTICE)).toHaveCount(0);
    expect(await serverQueries(page)).toEqual([
      expect.objectContaining({ accountId: "account-1", allFolders: true }),
      expect.objectContaining({
        accountId: "account-1",
        allFolders: true,
        resumeAfterMailboxId: 1,
        text: "stopped",
      }),
    ]);
    await attachArtifacts(
      page,
      testInfo,
      `server-search-resumable-${density}-200`,
    );
  });
}

test("keeps an earlier skipped-folder warning after the remaining page completes", async ({
  page,
}, testInfo: TestInfo) => {
  await installMockIpc(page);
  await page.goto("/?localMail=1&density=normal&scale=2");
  await stubServerSearch(page, "partial-then-complete");
  await chooseAllFolders(page);
  await startSearch(page);
  await expect(page.getByText(NOTICE)).toBeVisible();

  await page.getByRole("button", { name: "Search more folders" }).click();
  await expect(
    page.getByRole("option", { name: /Remaining folder hit/ }),
  ).toBeVisible();
  await expect(page.getByText(NOTICE)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Search more folders" }),
  ).toHaveCount(0);
  const queries = await serverQueries(page);
  expect(queries).toHaveLength(2);
  expect(queries[0]).toMatchObject({ allFolders: true, text: "stopped" });
  expect(queries[1]).toMatchObject({
    allFolders: true,
    resumeAfterMailboxId: 1,
    text: "stopped",
  });
  await attachArtifacts(page, testInfo, "server-search-partial-after-complete");
});

test("shows terminal partial status without a button after the last folder is clipped", async ({
  page,
}, testInfo: TestInfo) => {
  await installMockIpc(page);
  await page.goto("/?localMail=1&density=normal&scale=2");
  await stubServerSearch(page, "clipped-final");
  await chooseAllFolders(page);
  await startSearch(page);
  await expect(page.getByText(NOTICE)).toBeVisible();
  await page.getByRole("button", { name: "Search more folders" }).click();

  await expect(
    page.getByRole("option", { name: /Final clipped folder hit/ }),
  ).toBeVisible();
  await expect(page.getByText(NOTICE)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Search more folders" }),
  ).toHaveCount(0);
  expect(await serverQueries(page)).toHaveLength(2);
  expect((await serverQueries(page))[1]).toMatchObject({
    allFolders: true,
    resumeAfterMailboxId: 1,
    text: "stopped",
  });
  await attachArtifacts(page, testInfo, "server-search-terminal-partial");
});

test("editing the live term disables its old continuation", async ({
  page,
}, testInfo: TestInfo) => {
  await installMockIpc(page);
  await page.goto("/?localMail=1");
  await stubServerSearch(page, "resumable");
  await chooseAllFolders(page);
  await startSearch(page);

  const oldMore = page.getByRole("button", { name: "Search more folders" });
  await expect(oldMore).toBeVisible();
  await page
    .getByRole("searchbox", { name: "Search mail" })
    .fill("another term");
  if (await oldMore.isVisible()) await oldMore.click();
  const queries = await serverQueries(page);
  expect(queries).toHaveLength(1);
  expect(queries[0]).toMatchObject({ allFolders: true, text: "stopped" });
  await attachArtifacts(page, testInfo, "server-search-stale-term");
});

test("switching search scope starts a fresh query instead of the old cursor", async ({
  page,
}, testInfo: TestInfo) => {
  await installMockIpc(page);
  await page.goto("/?localMail=1");
  await stubServerSearch(page, "scope-change");
  await chooseAllFolders(page);
  await startSearch(page);
  await expect(page.getByText(NOTICE)).toBeVisible();

  await page.getByRole("button", { name: "All folders" }).click();
  await page.getByRole("menuitemradio", { name: "This mailbox" }).click();
  await expect(
    page.getByRole("option", { name: /Mailbox scope result/ }),
  ).toBeVisible();
  const oldMore = page.getByRole("button", { name: "Search more folders" });
  if (await oldMore.isVisible()) await oldMore.click();
  const queries = await serverQueries(page);
  expect(queries).toHaveLength(2);
  expect(queries[0]).toMatchObject({ allFolders: true, text: "stopped" });
  expect(queries[1]).toMatchObject({ allFolders: false, text: "stopped" });
  expect(
    queries.some((query) => query.resumeAfterMailboxId !== undefined),
  ).toBe(false);
  await attachArtifacts(page, testInfo, "server-search-stale-scope");
});

test("switching accounts leaves no action for the old account cursor", async ({
  page,
}, testInfo: TestInfo) => {
  await installMockIpc(page);
  await page.goto("/?multiAccount=1");
  await stubServerSearch(page, "resumable");
  await chooseAllFolders(page);
  await startSearch(page);
  await expect(page.getByText(NOTICE)).toBeVisible();

  await page.getByRole("button", { name: /Sam.*sam@icloud\.com/ }).click();
  await page
    .getByRole("menu", { name: "Email accounts" })
    .getByRole("menuitemradio", { name: /Work/ })
    .click();
  await expect(page.getByRole("option", { name: /Team launch/ })).toBeVisible();
  const oldMore = page.getByRole("button", { name: "Search more folders" });
  if (await oldMore.isVisible()) await oldMore.click();
  expect(await serverQueries(page)).toHaveLength(1);
  await expect(
    page.getByRole("searchbox", { name: "Search mail" }),
  ).toHaveValue("");
  await attachArtifacts(page, testInfo, "server-search-stale-account");
});

test("ignores a continuation response after the search scope changes", async ({
  page,
}, testInfo: TestInfo) => {
  await installMockIpc(page);
  await page.goto("/?localMail=1");
  await stubServerSearch(page, "delayed-continuation");
  await chooseAllFolders(page);
  await startSearch(page);
  await expect(page.getByText(NOTICE)).toBeVisible();
  await page.getByRole("button", { name: "Search more folders" }).click();
  await expect.poll(async () => (await serverQueries(page)).length).toBe(2);

  await page.getByRole("button", { name: "All folders" }).click();
  await page.getByRole("menuitemradio", { name: "This mailbox" }).click();
  await expect(
    page.getByRole("option", { name: /Mailbox scope result/ }),
  ).toBeVisible();
  await page.evaluate(() => {
    const browser = window as unknown as {
      __SERVER_SEARCH_CONTINUATION_RELEASE__?: () => void;
    };
    browser.__SERVER_SEARCH_CONTINUATION_RELEASE__?.();
  });
  await expect(
    page.getByRole("option", { name: /Stale continuation hit/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("option", { name: /Mailbox scope result/ }),
  ).toBeVisible();
  await attachArtifacts(page, testInfo, "server-search-stale-response");
});

test("all-folder server-only body matches remain visible", async ({
  page,
}, testInfo: TestInfo) => {
  await installMockIpc(page);
  await page.goto("/?localMail=1");
  await chooseAllFolders(page);
  await startSearch(page, "bodyonly words");
  await expect(
    page.getByRole("option", { name: /Server body match/ }),
  ).toBeVisible();
  expect(await serverQueries(page)).toEqual([
    expect.objectContaining({
      accountId: "account-1",
      allFolders: true,
      text: "bodyonly words",
    }),
  ]);
  await attachArtifacts(page, testInfo, "server-search-body-only");
});
