import type { Page, TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./coverage-fixture";
import { attachArtifacts } from "./ipc-artifact";
import { emitTauriEvent, recordIpc, recordedCalls } from "./ipc-recorder";
import { installMockIpc } from "./mock-ipc";

// Failure modes covered here:
// 1. A render failure in the message list stops the folders and Compose.
// 2. A render failure in the sidebar stops the message list and Compose.
// 3. A reader failure cannot be retried after its source recovers.
// 4. A failed Settings view leaves the inert window with no way out.
// 5. Composer recovery drops autosaved text or starts a second draft.
// 6. Try again leaves the alert up or focus on a removed node.
// 7. Recovery clips, overflows, or loses an accessible name at any scale.
// 8. An unavailable preferred focus target prevents recovery from restoring focus.

declare global {
  interface Window {
    __viewRecovery?: {
      messagesBroken?: boolean;
      mailboxesBroken?: boolean;
      readerBroken?: boolean;
      usageBroken?: boolean;
      draftSyncBroken?: boolean;
      holdNextDraftSave?: boolean;
    };
    __savedDraft?: Record<string, unknown>;
    __savedDrafts?: Record<string, Record<string, unknown>>;
    __pendingDraftSave?: boolean;
    __releasePendingDraftSave?: () => void;
  }
}

const crashTitle = "Something went wrong in this window";
const variants = [
  { density: "comfortable", scale: 1 },
  { density: "compact", scale: 1 },
  { density: "comfortable", scale: 2 },
  { density: "compact", scale: 2 },
] as const;

test.beforeEach(async ({ page }) => {
  await installMockIpc(page);
  await recordIpc(page);
});

async function setFlags(
  page: Page,
  flags: NonNullable<Window["__viewRecovery"]>,
) {
  await page.evaluate((next) => {
    window.__viewRecovery = { ...window.__viewRecovery, ...next };
  }, flags);
}

// Forced failures return data the view cannot render. Flags decide when,
// so a Try again test can make the source healthy before it retries.
async function installFaults(page: Page) {
  await page.evaluate(() => {
    const mock = window.__POSTAL_SNAP_MOCK__!;
    const flags = () => window.__viewRecovery ?? {};
    const list = mock.handlers.list_messages;
    mock.handlers.list_messages = async (args: Record<string, unknown>) => {
      const result = (await list(args)) as {
        items: Array<Record<string, unknown>>;
      };
      if (!flags().messagesBroken) return result;
      return {
        ...result,
        items: result.items.map((item) => ({ ...item, senderAddress: null })),
      };
    };
    const mailboxes = mock.handlers.list_mailboxes;
    mock.handlers.list_mailboxes = async (args: Record<string, unknown>) => {
      const result = (await mailboxes(args)) as Array<Record<string, unknown>>;
      if (!flags().mailboxesBroken) return result;
      // A role with no folder icon makes the sidebar fail to render.
      return result.map((item) => ({ ...item, role: "unknown-role" }));
    };
    const getMessage = mock.handlers.get_message;
    mock.handlers.get_message = async (args: Record<string, unknown>) => {
      const result = (await getMessage(args)) as Record<string, unknown>;
      return flags().readerBroken ? { ...result, to: null } : result;
    };
    const usage = mock.handlers.get_cache_usage;
    mock.handlers.get_cache_usage = async (args: Record<string, unknown>) => {
      const result = (await usage(args)) as Record<string, unknown>;
      return {
        ...result,
        get bytes() {
          if (flags().usageBroken) throw new Error("forced storage failure");
          return result.bytes;
        },
      };
    };
    const drafts = mock.handlers.list_drafts;
    mock.handlers.list_drafts = async (args: Record<string, unknown>) => {
      const result = (await drafts(args)) as Array<Record<string, unknown>>;
      const summaries = Object.entries(window.__savedDrafts ?? {}).map(
        ([id, saved], index) => ({
          id,
          accountId: String(args.accountId),
          recipients: Array.isArray(saved.to) ? saved.to.join(", ") : "",
          subject: String(saved.subject ?? ""),
          updatedAt: new Date(Date.now() + index * 1_000).toISOString(),
          syncState: "localOnly",
          // An object cannot be rendered as text in the sync banner.
          syncDetail: flags().draftSyncBroken
            ? { reason: "forced" }
            : "Saved on this device",
          preview: String(saved.textBody ?? "").split("\n", 1)[0],
          attachmentCount: 0,
          fromAddress: null,
        }),
      );
      // This unrelated draft is deliberately newer than the composer draft.
      const unrelated = {
        id: "draft-unrelated-newer",
        accountId: String(args.accountId),
        recipients: "unrelated@example.com",
        subject: "Unrelated newer draft",
        updatedAt: new Date(Date.now() + 86_400_000).toISOString(),
        syncState: "localOnly",
        syncDetail: "Saved on this device",
        preview: "Must not replace the open composer",
        attachmentCount: 0,
        fromAddress: null,
      };
      return [unrelated, ...summaries, ...result];
    };
    mock.handlers.save_draft = async (args: Record<string, unknown>) => {
      const draft = { ...(args.draft as Record<string, unknown>) };
      if (flags().holdNextDraftSave) {
        flags().holdNextDraftSave = false;
        window.__pendingDraftSave = true;
        await new Promise<void>((resolve) => {
          window.__releasePendingDraftSave = resolve;
        });
        window.__pendingDraftSave = false;
        window.__releasePendingDraftSave = undefined;
      }
      const id =
        typeof draft.id === "string"
          ? draft.id
          : draft.subject === "Unsaved subject"
            ? "draft-saved"
            : draft.subject === "Old stable draft"
              ? "draft-old"
              : draft.subject === "New session draft"
                ? "draft-new"
                : "draft-autosaved";
      draft.id = id;
      window.__savedDrafts = {
        ...window.__savedDrafts,
        [id]: draft,
      };
      window.__savedDraft = draft;
      return { id, syncState: "localPending" };
    };
    const savedDraft = mock.handlers.get_draft;
    mock.handlers.get_draft = async (args: Record<string, unknown>) => {
      const result = (await savedDraft(args)) as Record<string, unknown>;
      const saved = window.__savedDrafts?.[String(args.draftId)];
      if (!saved) return result;
      return {
        ...result,
        ...saved,
        id: String(args.draftId),
      };
    };
  });
}

async function accountId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const accounts = (await window.__POSTAL_SNAP_MOCK__!.handlers.list_accounts(
      {},
    )) as Array<{ id: string }>;
    return accounts[0].id;
  });
}

async function expectRecovery(page: Page, scope: string) {
  const container = page.locator(scope);
  const recovery =
    scope === "body"
      ? container.locator(".crash-recovery").filter({ hasText: crashTitle })
      : container.filter({ hasText: crashTitle });
  await expect(recovery).toBeVisible();
  await expect(
    recovery.getByRole("heading", { name: crashTitle }),
  ).toBeFocused();
  return recovery;
}

async function expectNoRecovery(page: Page) {
  await expect(
    page.locator(".crash-recovery").filter({ hasText: crashTitle }),
  ).toHaveCount(0);
}

async function expectTryAgainUsable(
  page: Page,
  variant: (typeof variants)[number],
) {
  const button = page.getByRole("button", { name: "Try again", exact: true });
  await expect(button).toBeEnabled();
  if (variant.density === "comfortable") {
    const box = await button.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const violations = (
    await new AxeBuilder({ page }).include(".crash-recovery").analyze()
  ).violations;
  expect(violations).toEqual([]);
}

function label(variant: (typeof variants)[number]) {
  return `${variant.density}-${variant.scale * 100}`;
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await attachArtifacts(page, testInfo, `view-recovery-${name}`);
}

for (const variant of variants) {
  test(`a failed message list recovers on Try again (${label(variant)})`, async ({
    page,
  }, testInfo) => {
    await page.goto(`/?density=${variant.density}&scale=${variant.scale}`);
    await installFaults(page);
    const rows = page.locator('[role="option"]');
    await expect(rows.first()).toBeVisible();

    await setFlags(page, { messagesBroken: true });
    await page.getByRole("button", { name: "Trash", exact: true }).click();
    const alert = await expectRecovery(page, "#message-pane");
    await expect(page.locator("#folder-pane")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Compose", exact: true }),
    ).toBeEnabled();
    await expectTryAgainUsable(page, variant);

    await setFlags(page, { messagesBroken: false });
    await alert.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(rows.first()).toBeVisible();
    await expectNoRecovery(page);
    await expect(rows.first()).toBeFocused();
    await capture(page, testInfo, `list-${label(variant)}`);
  });

  test(`a failed folder pane recovers on Try again (${label(variant)})`, async ({
    page,
  }, testInfo) => {
    await page.goto(`/?density=${variant.density}&scale=${variant.scale}`);
    await installFaults(page);
    const rows = page.locator('[role="option"]');
    await expect(rows.first()).toBeVisible();

    await setFlags(page, { mailboxesBroken: true });
    const id = await accountId(page);
    await page.evaluate(
      (detail) =>
        window.dispatchEvent(
          new CustomEvent("postal:local-mail-changed", { detail }),
        ),
      id,
    );
    const alert = await expectRecovery(page, "#folder-pane");
    await expect(
      page.getByRole("button", { name: "Compose", exact: true }),
    ).toBeEnabled();
    await expect(rows.first()).toBeVisible();
    await expectTryAgainUsable(page, variant);

    await setFlags(page, { mailboxesBroken: false });
    await alert.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(
      page
        .locator("#folder-pane")
        .getByRole("button", { name: /Inbox/ })
        .first(),
    ).toBeVisible();
    await expect(
      page.locator("#folder-pane .folder-list button").first(),
    ).toBeFocused();
    await capture(page, testInfo, `sidebar-${label(variant)}`);
  });

  test(`a failed reader recovers on Try again (${label(variant)})`, async ({
    page,
  }, testInfo) => {
    await page.goto(`/?density=${variant.density}&scale=${variant.scale}`);
    await installFaults(page);
    const row = page.locator('[role="option"]').first();
    await expect(row).toBeVisible();

    await setFlags(page, { readerBroken: true });
    await row.click();
    const alert = await expectRecovery(page, "#reader-pane");
    await expect(page.locator("#folder-pane")).toBeVisible();
    await expect(page.locator("#message-pane")).toBeVisible();
    await expectTryAgainUsable(page, variant);

    await setFlags(page, { readerBroken: false });
    await alert.getByRole("button", { name: "Try again", exact: true }).click();
    await expectNoRecovery(page);
    await expect(page.locator("#reader-pane")).not.toHaveClass(
      /crash-recovery/,
    );
    await expect(
      page.locator('#reader-pane [role="toolbar"] button:focus'),
    ).toHaveCount(1);
    await capture(page, testInfo, `reader-${label(variant)}`);
  });

  test(`a failed Storage view recovers on Try again (${label(variant)})`, async ({
    page,
  }, testInfo) => {
    await page.goto(`/?density=${variant.density}&scale=${variant.scale}`);
    await installFaults(page);
    await setFlags(page, { usageBroken: true });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Storage", exact: true }).click();

    const alert = await expectRecovery(page, "body");
    await expectTryAgainUsable(page, variant);

    await setFlags(page, { usageBroken: false });
    await alert.getByRole("button", { name: "Try again", exact: true }).click();
    await page.getByRole("tab", { name: "Storage", exact: true }).click();
    await expect(
      page.getByRole("tab", { name: "Storage", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expectNoRecovery(page);
    await capture(page, testInfo, `settings-${label(variant)}`);
  });

  test(`a failed composer keeps autosaved text on Try again (${label(variant)})`, async ({
    page,
  }, testInfo) => {
    await page.goto(`/?density=${variant.density}&scale=${variant.scale}`);
    await installFaults(page);
    await page.getByRole("button", { name: "Compose", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Subject", exact: true })
      .fill("Unsaved subject");
    await page
      .getByLabel("Message body")
      .pressSequentially("Autosaved body text");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(page.getByText(/Draft saved/).first()).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.__savedDraft?.subject))
      .toBe("Unsaved subject");

    await setFlags(page, { draftSyncBroken: true });
    await emitTauriEvent(page, "draft-sync-changed", {
      accountId: await accountId(page),
      draftId: "draft-saved",
      syncState: "failed",
    });
    const alert = await expectRecovery(page, "body");
    await expectTryAgainUsable(page, variant);

    await setFlags(page, { draftSyncBroken: false });
    await alert.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Subject", exact: true }),
    ).toHaveValue("Unsaved subject");
    await expect(
      page.getByRole("textbox", { name: "Subject", exact: true }),
    ).toBeFocused();
    await expect(page.getByLabel("Message body")).toContainText(
      "Autosaved body text",
    );
    const reads = (await recordedCalls(page)).filter(
      (call) => call.command === "get_draft",
    );
    expect(reads.at(-1)?.args).toMatchObject({ draftId: "draft-saved" });
    await page
      .getByLabel("Message body")
      .fill("Autosaved body text after recovery");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect
      .poll(() => page.evaluate(() => window.__savedDraft?.id))
      .toBe("draft-saved");
    await expect
      .poll(() => page.evaluate(() => window.__savedDraft?.textBody))
      .toContain("Autosaved body text after recovery");
    await capture(page, testInfo, `composer-${label(variant)}`);
  });
}

test("a recovered pane skips a hidden preferred focus target", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await installFaults(page);
  await expect(page.locator('[role="option"]').first()).toBeVisible();

  await setFlags(page, { mailboxesBroken: true });
  const id = await accountId(page);
  await page.evaluate(
    (detail) =>
      window.dispatchEvent(
        new CustomEvent("postal:local-mail-changed", { detail }),
      ),
    id,
  );
  const alert = await expectRecovery(page, "#folder-pane");
  await page.addStyleTag({
    content:
      "#folder-pane .folder-list button:first-of-type { display: none !important; }",
  });

  await setFlags(page, { mailboxesBroken: false });
  await alert.getByRole("button", { name: "Try again", exact: true }).click();
  await expectNoRecovery(page);
  const preferred = page
    .locator("#folder-pane .folder-list button:not([disabled])")
    .first();
  await expect(preferred).toBeHidden();
  const focusState = await page.locator("#folder-pane").evaluate((root) => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    return {
      inPane: root.contains(active),
      visible: active.getClientRects().length > 0,
      enabled: !(active instanceof HTMLButtonElement) || !active.disabled,
      isPreferred: active === root.querySelector(".folder-list button"),
    };
  });
  expect(focusState).toEqual({
    inPane: true,
    visible: true,
    enabled: true,
    isPreferred: false,
  });
  await capture(page, testInfo, "sidebar-hidden-preferred-focus");
});

test("a failed Settings view traps Tab and closes on Escape", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await installFaults(page);
  await setFlags(page, { usageBroken: true });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Storage", exact: true }).click();
  await expectRecovery(page, "body");

  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
  }
  const focusStayedModal = await page.evaluate(() => {
    const active = document.activeElement;
    return Boolean(
      active?.closest(".settings-recovery, .global-window-caption-controls"),
    );
  });
  expect(focusStayedModal).toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-recovery")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
  await capture(page, testInfo, "settings-modal-keyboard-recovery");
});

test("a late autosave from a replaced composer cannot replace its recovery draft", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await installFaults(page);
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Subject", exact: true })
    .fill("Old stable draft");
  await page.getByLabel("Message body").pressSequentially("Old saved body");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect
    .poll(() => page.evaluate(() => window.__savedDraft?.id))
    .toBe("draft-old");

  await page
    .getByRole("textbox", { name: "Subject", exact: true })
    .fill("Old late edit");
  await setFlags(page, { holdNextDraftSave: true });
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect
    .poll(() => page.evaluate(() => window.__pendingDraftSave))
    .toBe(true);

  await setFlags(page, { draftSyncBroken: true });
  await emitTauriEvent(page, "draft-sync-changed", {
    accountId: await accountId(page),
    draftId: "draft-old",
  });
  await expectRecovery(page, "body");
  await emitTauriEvent(page, "menu-action", "compose");
  await page
    .getByRole("textbox", { name: "Subject", exact: true })
    .fill("New session draft");
  await page.getByLabel("Message body").pressSequentially("New saved body");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect
    .poll(() => page.evaluate(() => window.__savedDraft?.id))
    .toBe("draft-new");

  await page.evaluate(() => window.__releasePendingDraftSave?.());
  await expect
    .poll(() => page.evaluate(() => window.__pendingDraftSave))
    .toBe(false);
  await expect
    .poll(() =>
      page.evaluate(() => window.__savedDrafts?.["draft-old"]?.subject),
    )
    .toBe("Old late edit");

  await emitTauriEvent(page, "draft-sync-changed", {
    accountId: await accountId(page),
    draftId: "draft-new",
  });
  const alert = await expectRecovery(page, "body");
  await setFlags(page, { draftSyncBroken: false });
  await alert.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Subject", exact: true }),
  ).toHaveValue("New session draft");
  await expect(page.getByLabel("Message body")).toContainText("New saved body");

  const reads = (await recordedCalls(page)).filter(
    (call) => call.command === "get_draft",
  );
  expect(reads.at(-1)?.args).toMatchObject({ draftId: "draft-new" });
  await capture(page, testInfo, "composer-stale-save");
});

test("a failed Storage view can be closed to reach the window", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await installFaults(page);
  await setFlags(page, { usageBroken: true });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Storage", exact: true }).click();
  const alert = await expectRecovery(page, "body");
  await alert.getByRole("button", { name: "Close", exact: true }).click();
  await expectNoRecovery(page);
  await expect(
    page.getByRole("button", { name: "Compose", exact: true }),
  ).toBeEnabled();
  await capture(page, testInfo, "settings-dismissed");
});

test("Reload window remains available as a secondary recovery action", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await installFaults(page);
  await setFlags(page, { usageBroken: true });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Storage", exact: true }).click();
  const alert = await expectRecovery(page, "body");

  await alert
    .getByRole("button", { name: "Reload window", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Compose", exact: true }),
  ).toBeVisible();
  await expectNoRecovery(page);
  await capture(page, testInfo, "reload-window");
});
